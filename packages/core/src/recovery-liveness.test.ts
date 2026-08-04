import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobStore, PersistedJob } from "./job-store.ts";
import type { GatewayEvent, Job, JobSnapshot } from "./types.ts";

/**
 * The turn that ended while its run was still running.
 *
 * Reconstructed from job 6ac8eeb0 (2026-08-04), whose whole lifecycle is
 * readable in the gateway log:
 *
 *   08:25:46  chat.send accepted — the run starts
 *   08:26:38  the gateway takes SIGTERM and restarts; the connector's socket
 *             dies with no terminal `chat` event
 *   08:26:53  the socket-close door hands off: chat() resolves with the
 *             no-summary sentinel, the job enters `no_live_final_text`
 *             recovery and starts the 10s transcript long-poll
 *   08:26:55  openclaw's own restart recovery RE-DISPATCHES the interrupted
 *             session — the run is executing again, under a new run id
 *   08:26:55  31 transcript reads, 10s apart, all identical: the resumed run
 *    →08:32:18 works through model calls without the persisted transcript
 *             advancing. At 5 minutes the poll's idle timeout fires and the
 *             turn is published `completed_no_summary`.
 *   08:32:18+ the run keeps making model calls for many more minutes.
 *
 * The parent stopped watching a live run and published it as a turn that
 * finished with nothing to say — and released the busy guard, so the next
 * send on that session would have aborted the run it collided with.
 *
 * The evidence to prevent that was in hand the whole time: every one of those
 * 31 reads classified openclaw's own run state (readTranscriptSample →
 * classifyUpstreamRun) and the poll threw the answer away. The quiet watchdog
 * on the OTHER recovery path has refused this same inference from the start —
 * "absence is never a verdict". These tests pin that rule onto this path.
 *
 * They drive the REAL gateway poll (only its one transcript read is stubbed)
 * and the REAL SessionManager, so the idle-timeout/stability/liveness logic
 * under test is the shipped logic, not a re-implementation of it.
 */

process.env.HOME = mkdtempSync(join(tmpdir(), "clawconnect-recovery-liveness-"));
// Shrunk from 90 minutes so the hard-cap ceiling is reachable in a test
// without changing what it means: still well above the 5-minute idle timeout
// the extensions are made of.
process.env.CLAWCONNECT_RECOVERY_TIMEOUT_MS = String(20 * 60_000);

const { OpenClawGateway } = await import("./gateway.ts");
const { SessionManager } = await import("./session.ts");
const { NO_SUMMARY_SENTINEL } = await import("./types.ts");

/** recoverLateFinalText's own numbers — the shape of one extension. */
const POLL_INTERVAL_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const HARD_CAP_MS = 20 * 60_000;
/** One idle window plus a poll tick: long enough for the idle exit to fire. */
const PAST_IDLE_MS = IDLE_TIMEOUT_MS + POLL_INTERVAL_MS * 2;

type Sample = { snapshotKey: string; trailingText: string; upstream: "active" | "unknown" } | null;

const UPSTREAM_RUN_ID = "8c2e83f3-cdef-493e-881b-f41f5f15f012";

/**
 * A real OpenClawGateway with exactly one seam stubbed: the single
 * `chat.history` read every poll is built out of. Everything above it — the
 * stability threshold, the idle timeout, the hard cap, the liveness
 * classification handed back through `onSample` — is the shipped code.
 */
function harness(initial: Sample) {
  const gateway = new OpenClawGateway({ url: "ws://127.0.0.1:1", token: "test-token" });
  const chats: {
    sessionKey: string;
    onEvent?: (e: GatewayEvent) => void;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  let sample = initial;
  const reads: { runId: string | undefined }[] = [];

  gateway.chat = ((
    sessionKey: string,
    _message: string,
    _timeoutMs: number,
    onEvent?: (e: GatewayEvent) => void,
    onRunId?: (runId: string) => void,
  ) => {
    onRunId?.(UPSTREAM_RUN_ID);
    return new Promise<string>((resolve, reject) => {
      chats.push({ sessionKey, onEvent, resolve, reject });
    });
  }) as InstanceType<typeof OpenClawGateway>["chat"];

  // Never lets the quiet watchdog decide anything: this file is about the
  // OTHER recovery path, and an unreadable observation is its documented
  // "keep waiting" case.
  gateway.reconcileRun = (async () => ({
    ok: false,
    changed: false,
    trailingText: "",
    snapshotKey: "",
    upstream: "unknown" as const,
  })) as InstanceType<typeof OpenClawGateway>["reconcileRun"];

  (gateway as unknown as { readTranscriptSample: (s: string, runId?: string) => Promise<Sample> })
    .readTranscriptSample = async (_sessionKey: string, runId?: string) => {
    reads.push({ runId });
    return sample;
  };

  return {
    gateway,
    reads,
    /** What every subsequent transcript read returns. */
    setSample: (next: Sample) => {
      sample = next;
    },
    /** The socket-close door's hand-off: chat() resolving with the sentinel. */
    closeStream: (call = 0) => chats[call]?.resolve(NO_SUMMARY_SENTINEL),
    finishChat: (text: string, call = 0) => chats[call]?.resolve(text),
    emit: (e: GatewayEvent, call = 0) => chats[call]?.onEvent?.(e),
    chatCount: () => chats.length,
  };
}

/** The frozen transcript of the resumed run: identical read, run still executing. */
const frozenAndActive: Sample = { snapshotKey: "assistant:0:12", trailingText: "", upstream: "active" };
/** Same stillness, but upstream no longer claims anything — the pre-existing "give up" case. */
const frozenAndUnknown: Sample = { snapshotKey: "assistant:0:12", trailingText: "", upstream: "unknown" };

/**
 * The cross-field invariants a caller relies on. Asserted at every step of
 * every lifecycle below rather than once at the end: a snapshot that
 * contradicts itself for one poll is exactly what a client renders.
 */
function expectCoherent(snapshot: JobSnapshot, now: number): void {
  const running = snapshot.status === "running";
  expect(snapshot.continuePolling).toBe(running);
  expect(snapshot.nextAction === null).toBe(!running);
  if (!running) {
    // Nothing is still being watched once the turn is published.
    expect(snapshot.recovery).toBeUndefined();
    expect(snapshot.retryAfterMs).toBe(0);
    // The contradiction this file exists to prevent: a turn published as
    // having quietly finished, over a still-fresh check that says the run
    // is executing.
    const livenessIsFresh = snapshot.liveness !== undefined && now - snapshot.liveness.checkedAt <= IDLE_TIMEOUT_MS;
    if (livenessIsFresh && snapshot.liveness?.upstream === "active") {
      expect(snapshot.status).not.toBe("completed_no_summary");
    }
  } else if (snapshot.recovery) {
    expect(snapshot.retryAfterMs).toBeGreaterThan(0);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("late recovery — a still transcript is not a finished run", () => {
  it("keeps the turn alive for as long as upstream reports the run executing", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "recover the fleet worktree" });

    // The socket died before any terminal event — the run is not over, the
    // connection to it is.
    ctrl.closeStream();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.recovery?.reason).toBe("no_live_final_text");

    // Three idle windows — 15+ minutes of a transcript that never moves,
    // which is what a resumed run doing model calls looks like from here.
    for (let window = 0; window < 3; window++) {
      await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
      const live = sessions.getJob(job.jobId)!;
      expect(live.status).toBe("running");
      expect(live.summary).toBeUndefined();
      expectCoherent(sessions.buildSnapshot(live), Date.now());
    }

    const live = sessions.getJob(job.jobId)!;
    // Not silently: the caller is told, in the log, why the watch continues.
    expect(live.logs.filter((l) => l.text.includes("still executing")).length).toBeGreaterThanOrEqual(2);
    // ...and the evidence behind that claim is on the job, freshly re-checked
    // by the very reads the poll was already making.
    expect(live.liveness?.upstream).toBe("active");
    expect(Date.now() - live.liveness!.checkedAt).toBeLessThanOrEqual(POLL_INTERVAL_MS * 2);
  });

  it("publishes the answer when it finally lands, exactly once", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "recover the fleet worktree" });
    ctrl.closeStream();

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS * 2);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // The run finally writes its report.
    ctrl.setSample({ snapshotKey: "assistant:41:13", trailingText: "the answer the resumed run wrote", upstream: "active" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the answer the resumed run wrote");
    expect(live.terminalReason).toBe("late-recovery-transcript");
    expect(live.resultSource).toBe("parent");
    expect(live.recovery).toBeUndefined();
    // Published once: one outcome write, not one per extension or per poll.
    expect(live.outcomeVersion).toBe(1);
    expectCoherent(sessions.buildSnapshot(live), Date.now());

    // And it stays published. Later polls re-read a transcript that still
    // carries the same text; none of them may republish or restring it.
    const readsAtCompletion = ctrl.reads.length;
    for (let poll = 0; poll < 3; poll++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const polled = await sessions.waitForJob(job.jobId, 0, undefined, "poll", 1_000);
      expect(polled?.summary).toBe("the answer the resumed run wrote");
      expect(polled?.outcomeVersion).toBe(1);
    }
    // The watch stopped when the turn was published — the only reads after it
    // are the rate-limited lazy re-checks, not a long-poll still running.
    expect(ctrl.reads.length - readsAtCompletion).toBeLessThan(10);
  });

  it("holds the session's busy guard while upstream is still executing", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:mcp-1785849945732-fd359ae7";
    sessions.submitTask({ task: "recover the fleet worktree", sessionKey });
    ctrl.closeStream();

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS * 2);

    // The corollary of staying `running`. Publishing the turn here would free
    // the guard, and the next send would abort the run it collided with —
    // both jobs broken, which is what the guard exists to prevent.
    const second = sessions.submitTask({ task: "same session, again", sessionKey });
    expect(second.status).toBe("error");
    expect(second.errorInfo?.message).toBe("session busy");
    expect(ctrl.chatCount()).toBe(1);
  });

  it("never publishes completed_no_summary over an active run — the ceiling ends it as a diagnosable failure", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "recover the fleet worktree" });
    ctrl.closeStream();

    // Past the absolute ceiling, with upstream never once retracting.
    await vi.advanceTimersByTimeAsync(HARD_CAP_MS + PAST_IDLE_MS);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).not.toBe("completed_no_summary");
    expect(live.status).toBe("error");
    expect(live.terminalReason).toBe("late-recovery-upstream-still-active");
    // A real failure says what was actually observed...
    expect(live.error).toContain("still reported as executing");
    expect(live.error).toContain(UPSTREAM_RUN_ID);
    // ...and what to do about it, which is NOT "resubmit and collide".
    expect(live.errorInfo?.suggestedRecovery).toContain("check_task");
    expect(live.errorInfo?.suggestedRecovery).toContain(job.jobId);
    expect(live.errorInfo?.suggestedRecovery).toMatch(/not re-submit/i);
    expectCoherent(sessions.buildSnapshot(live), Date.now());

    // Still recoverable: an `error` job keeps being re-read, so an answer that
    // lands afterwards still reaches the caller.
    ctrl.setSample({ snapshotKey: "assistant:44:14", trailingText: "the answer, an hour late", upstream: "unknown" });
    await vi.advanceTimersByTimeAsync(60_000);
    const rechecking = sessions.waitForJob(job.jobId, 0, undefined, "poll", 1_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await rechecking;
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe("the answer, an hour late");
  });

  it("still settles a genuinely quiet turn — the change is evidence-gated, not a blanket refusal to finish", async () => {
    vi.useFakeTimers();
    // Same stillness, no positive evidence of a run behind it: the
    // pre-existing outcome, unchanged.
    const ctrl = harness(frozenAndUnknown);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "a run that really did end quietly" });
    ctrl.closeStream();

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).toBe(NO_SUMMARY_SENTINEL);
    expect(live.terminalReason).toBe("late-recovery-exhausted");
    expectCoherent(sessions.buildSnapshot(live), Date.now());
  });

  it("stops extending the moment upstream stops claiming the run", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "a run that ends mid-watch" });
    ctrl.closeStream();

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    ctrl.setSample(frozenAndUnknown);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
  });

  it("correlates its transcript reads to the run it is waiting on", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    sessions.submitTask({ task: "recover the fleet worktree" });
    ctrl.closeStream();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    // Without the run id, only the session-wide `hasActiveRun` latch can ever
    // read as positive evidence; with it, our own run appearing in
    // activeRunIds does too. See classifyUpstreamRun.
    expect(ctrl.reads.length).toBeGreaterThan(0);
    expect(ctrl.reads.every((r) => r.runId === UPSTREAM_RUN_ID)).toBe(true);
  });
});

describe("late recovery — the surfaces a caller reads", () => {
  it("exposes the ids needed to find the work: the upstream run and the attached session", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "recover the fleet worktree",
      context:
        "[[clawconnect:agent-session]]\n" +
        JSON.stringify({
          op: "attach",
          runtime: "claude-fleet",
          handle: "fleet-worktree-20260804",
          providerSessionId: "provider-session-77",
          host: "build-host",
          worktree: "/tmp/worktrees/recovery-fix",
          remoteUrl: "https://example.test/sessions/77",
        }) +
        "\n[[/clawconnect:agent-session]]",
    });
    ctrl.closeStream();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    const snapshot = sessions.buildSnapshot(sessions.getJob(job.jobId)!);
    expect(snapshot.parentRunId).toBe(UPSTREAM_RUN_ID);
    expect(snapshot.agentSession?.handle).toBe("fleet-worktree-20260804");
    expect(snapshot.agentSession?.providerSessionId).toBe("provider-session-77");
    expect(snapshot.agentSession?.host).toBe("build-host");
    expect(snapshot.agentSession?.worktree).toBe("/tmp/worktrees/recovery-fix");
    expect(snapshot.agentSession?.remoteUrl).toBe("https://example.test/sessions/77");
    // The directive block never reaches the agent.
    expect(sessions.getJob(job.jobId)?.prompt.context ?? "").not.toContain("clawconnect:agent-session");
  });

  it("a stream that ends before the turn does is reported as recoverable, not as a failure", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "recover the fleet worktree" });

    ctrl.closeStream();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = sessions.buildSnapshot(sessions.getJob(job.jobId)!);
    expect(snapshot.status).toBe("running");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.errorInfo).toBeUndefined();
    // What the widget keys its "the chat connection ended, the task is still
    // running" notice off — see deriveConnectionNotice.
    expect(snapshot.recovery?.reason).toBe("no_live_final_text");
    expectCoherent(snapshot, Date.now());
  });
});

describe("late recovery — a failed tool command is not the end of the turn", () => {
  it("carries on through a failed command and completes on the run's own final text", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "set up a fleet worktree" });

    // The shape the incident opened with: the very first command fails.
    ctrl.emit({ type: "tool", text: "Bash: git worktree add …", toolName: "Bash", args: {} });
    ctrl.emit({ type: "tool-result", text: "Bash failed", toolName: "Bash", isError: true });
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // The agent recovers and keeps working.
    ctrl.emit({ type: "tool", text: "Bash: git worktree add … --force", toolName: "Bash", args: {} });
    ctrl.emit({ type: "tool-result", text: "Bash done", toolName: "Bash", isError: false });
    ctrl.finishChat("worktree created on the second attempt");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("worktree created on the second attempt");
    // The failure is kept as evidence — it just never decided anything.
    expect(live.logs.some((l) => l.isError === true)).toBe(true);
    expectCoherent(sessions.buildSnapshot(live), Date.now());
  });

  it("a failed tool result still closes its round, so the watchdog is not blinded by it", async () => {
    vi.useFakeTimers();
    // An errored result that did not decrement the outstanding-tool count
    // would leave the run permanently looking like it was inside a tool call,
    // and reconciliation would never look upstream again.
    const ctrl = harness(frozenAndActive);
    const reconcileCalls: string[] = [];
    ctrl.gateway.reconcileRun = (async (sessionKey: string) => {
      reconcileCalls.push(sessionKey);
      return { ok: false, changed: false, trailingText: "", snapshotKey: "", upstream: "unknown" as const };
    }) as InstanceType<typeof OpenClawGateway>["reconcileRun"];
    const sessions = new SessionManager(ctrl.gateway);
    sessions.submitTask({ task: "a command that fails" });

    ctrl.emit({ type: "tool", text: "Bash: pnpm test", toolName: "Bash", args: {} });
    ctrl.emit({ type: "tool-result", text: "Bash failed", toolName: "Bash", isError: true });

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(reconcileCalls.length).toBeGreaterThan(0);
  });
});

describe("late recovery — reattaching after a restart", () => {
  class FakeJobStore implements JobStore {
    saved: PersistedJob[][] = [];
    constructor(private preloaded: PersistedJob[] = []) {}
    load(): PersistedJob[] {
      return this.preloaded;
    }
    save(jobs: PersistedJob[]): void {
      this.saved.push(jobs);
    }
    get latestSave(): PersistedJob[] | undefined {
      return this.saved.at(-1);
    }
  }

  const persisted: PersistedJob = {
    jobId: "job-6ac8eeb0",
    sessionKey: "agent:main:main:thread:mcp-1785849945732-fd359ae7",
    startedAt: 1_000,
    lastEventAt: 2_000,
    pollCount: 3,
    prompt: { task: "recover the fleet worktree", context: undefined, senderName: "jake" },
    parentRunId: UPSTREAM_RUN_ID,
  };

  it("a reloaded job whose run is still executing stays running, and completes when its answer lands", { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const store = new FakeJobStore([persisted]);
    const sessions = new SessionManager(ctrl.gateway, "main", store);

    // The connector came back, the live stream did not — same recovery path,
    // and the same reason it must not conclude anything from stillness.
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS * 2);
    const reloaded = sessions.getJob(persisted.jobId)!;
    expect(reloaded.status).toBe("running");
    expectCoherent(sessions.buildSnapshot(reloaded), Date.now());

    ctrl.setSample({ snapshotKey: "assistant:52:9", trailingText: "the report the run finished writing", upstream: "active" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);

    expect(reloaded.status).toBe("completed");
    expect(reloaded.summary).toBe("the report the run finished writing");
    expect(store.latestSave).toEqual([]);
    expectCoherent(sessions.buildSnapshot(reloaded), Date.now());
  });

  it("reads the reloaded job's persisted run id — restart does not lose the correlation", async () => {
    vi.useFakeTimers();
    const ctrl = harness(frozenAndActive);
    const sessions = new SessionManager(ctrl.gateway, "main", new FakeJobStore([persisted]));

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(ctrl.reads.length).toBeGreaterThan(0);
    expect(ctrl.reads.every((r) => r.runId === UPSTREAM_RUN_ID)).toBe(true);
    expect(sessions.buildSnapshot(sessions.getJob(persisted.jobId) as Job).parentRunId).toBe(UPSTREAM_RUN_ID);
  });
});
