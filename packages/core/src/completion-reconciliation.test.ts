import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONCILE_QUIET_MS, SessionManager } from "./session.ts";
import type { OpenClawGateway, RunObservation } from "./gateway.ts";
import type { GatewayEvent } from "./types.ts";

/**
 * Bounded completion reconciliation: what happens to a job whose live chat
 * stream produced tool activity and then simply stopped, without ever
 * delivering a terminal event. Before this existed, chat() stayed pending and
 * the job sat in `running` until the 30-minute timeout turned it into an
 * error — the production shape this covers.
 *
 * The quiet watchdog re-reads upstream truth (the persisted transcript) after
 * RECONCILE_QUIET_MS of live silence and turns the answer into a bounded
 * outcome. Crucially it never decides `completed` from a single round: an
 * active run routinely leaves an interim status line in the trailing-
 * assistant slot and then works for minutes. See
 * SessionManager.reconcileQuietRun.
 */

// Read from the module rather than hardcoded: CLAWCONNECT_RECONCILE_QUIET_MS
// can override the policy, and a fixture that assumed 120s would then be
// advancing the fake clock to the wrong place.
const QUIET_MS = RECONCILE_QUIET_MS;
const PAST_QUIET_MS = QUIET_MS + 1_000;

const settled = (trailingText: string, snapshotKey = "settled-1"): RunObservation => ({
  ok: true,
  changed: false,
  trailingText,
  snapshotKey,
});
const advancing = (snapshotKey = "advancing-1"): RunObservation => ({
  ok: true,
  changed: true,
  trailingText: "",
  snapshotKey,
});
const unreadable = (): RunObservation => ({ ok: false, changed: false, trailingText: "", snapshotKey: "" });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Fake gateway with per-call control over every chat() invocation (a single
 * fixture can have two jobs in flight on one sessionKey) and a scripted
 * sequence of reconciliation observations.
 */
function fakeGateway(
  opts: {
    observations?: (RunObservation | (() => Promise<RunObservation>))[];
    pollTranscriptForFinalText?: () => Promise<string | undefined>;
  } = {},
) {
  const calls: {
    sessionKey: string;
    onEvent?: (e: GatewayEvent) => void;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  const reconcileCalls: string[] = [];
  let observationIndex = 0;

  const gateway = {
    chat(sessionKey: string, _message: string, _timeoutMs: number, onEvent?: (e: GatewayEvent) => void) {
      // Never settles on its own: every fixture here is about a run whose
      // terminal event never reaches the connector.
      return new Promise<string>((resolve, reject) => {
        calls.push({ sessionKey, onEvent, resolve, reject });
      });
    },
    async reconcileRun(sessionKey: string): Promise<RunObservation> {
      reconcileCalls.push(sessionKey);
      const scripted = opts.observations;
      if (!scripted || scripted.length === 0) return advancing();
      // The last entry repeats once the script runs out.
      const next = scripted[Math.min(observationIndex, scripted.length - 1)];
      observationIndex += 1;
      return typeof next === "function" ? next() : next;
    },
    pollTranscriptForFinalText: opts.pollTranscriptForFinalText ?? (async () => undefined),
    close() {},
  } as unknown as OpenClawGateway;

  return {
    gateway,
    reconcileCalls,
    emit: (e: GatewayEvent, call = 0) => calls[call]?.onEvent?.(e),
    finishChat: (text: string, call = 0) => calls[call]?.resolve(text),
    failChat: (err: Error, call = 0) => calls[call]?.reject(err),
  };
}

const toolEvent: GatewayEvent = { type: "tool", text: "Bash: pnpm test", toolName: "Bash", args: {} };
const toolResultEvent: GatewayEvent = { type: "tool-result", text: "Bash done", toolName: "Bash", isError: false };

/**
 * A COMPLETE tool round. Real streams pair every tool start with a result;
 * the interval between the two is where a long-running tool lives, and
 * reconciliation deliberately refuses to finalize inside it. Fixtures about
 * a run that went quiet AFTER doing work must therefore close the round —
 * emitting a bare start models a tool that never returns.
 */
const emitToolRound = (ctrl: ReturnType<typeof fakeGateway>) => {
  ctrl.emit(toolEvent);
  ctrl.emit(toolResultEvent);
};
const SENTINEL = "Stream finished with no response collected.";

afterEach(() => {
  vi.useRealTimers();
});

describe("completion reconciliation — the normal path is untouched", () => {
  it("an immediate final event completes the job and never reconciles", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "quick thing" });

    ctrl.finishChat("the immediate answer");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the immediate answer");

    // The watchdog must be disarmed by the live completion, not merely
    // out-voted by it — no transcript reads, however long we wait.
    await vi.advanceTimersByTimeAsync(10 * QUIET_MS);
    expect(ctrl.reconcileCalls).toHaveLength(0);
  });

  it("a run that keeps streaming events is never reconciled — the quiet clock resets on each one", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    sessions.submitTask({ task: "long tool-heavy job" });

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
      emitToolRound(ctrl);
    }

    expect(ctrl.reconcileCalls).toHaveLength(0);
  });
});

describe("completion reconciliation — a terminal event that never arrived", () => {
  it("recovers the final response from the transcript, but only once it is confirmed by a second round", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("the real answer"), settled("the real answer")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });

    emitToolRound(ctrl);
    // ...and then the live stream goes silent, terminal event never delivered.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    // One quiet look at trailing text is not evidence the run finished.
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real answer");
    expect(ctrl.reconcileCalls).toEqual([job.sessionKey, job.sessionKey]);
    expect(live.logs.some((l) => l.type === "recovery")).toBe(true);
  });

  it("settles to completed_no_summary when upstream is terminal with no visible text — after a bounded number of rounds", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");
    expect(ctrl.reconcileCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).toBe(SENTINEL);
    expect(ctrl.reconcileCalls).toHaveLength(2);
  });

  it("still ends the job when upstream can't be read at all — never indefinite running", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [unreadable()] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).toContain("could not be read");
  });

  it("waits a full quiet window on a continued session that has produced no events yet", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    // A supplied sessionKey means no initial log entry, so lastEventAt stays
    // 0 — the quiet clock has to fall back to startedAt rather than reading
    // "quiet since the epoch" and reconciling instantly.
    sessions.submitTask({ task: "continued work", sessionKey: "agent:main:main:thread:existing" });

    await vi.advanceTimersByTimeAsync(QUIET_MS - 5_000);
    expect(ctrl.reconcileCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctrl.reconcileCalls).toHaveLength(1);
  });
});

describe("completion reconciliation — an active run is never mistaken for a finished one", () => {
  it("leaves a genuinely active run alone — an advancing transcript means still running, indefinitely", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [advancing()] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long quiet thinking job" });
    emitToolRound(ctrl);

    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }
    expect(ctrl.reconcileCalls).toHaveLength(4);
  });

  it("never finalizes while a tool call is still in flight — a long tool is not a finished run", async () => {
    vi.useFakeTimers();
    // The blocking shape: the agent writes a status line, calls a long tool,
    // and the stream goes quiet. Live events fire only at the tool's start
    // and result, and chat.history stays frozen on the status line — so
    // every sample looks "settled" for as long as the tool runs.
    const ctrl = fakeGateway({ observations: [settled("I'm tracing the live wiring now…")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });

    // Tool starts. Deliberately no result — it is still executing.
    ctrl.emit(toolEvent);

    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      const live = sessions.getJob(job.jobId)!;
      expect(live.status).toBe("running");
      expect(live.summary).toBeUndefined();
    }
    // Knowing a tool is outstanding, there is nothing upstream can add.
    expect(ctrl.reconcileCalls).toHaveLength(0);

    // The busy guard is still held: a colliding submit here would abort the
    // live run mid-tool.
    const colliding = sessions.submitTask({ task: "colliding ask", sessionKey: job.sessionKey });
    expect(colliding.status).toBe("error");
    expect(colliding.errorInfo?.message).toBe("session busy");

    // The tool finally returns and the run delivers its real answer.
    ctrl.emit(toolResultEvent);
    ctrl.finishChat("the real answer, after the long tool");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real answer, after the long tool");
  });

  it("a reconciled completion is provisional — a late live final replaces its summary", async () => {
    vi.useFakeTimers();
    // Belt to the tool-tracking brace: when reconciliation completes a job
    // from text that turns out not to have been final, the run's real
    // terminal text must still win rather than being refused as a
    // "downgrade" of an already-summarized job.
    const ctrl = fakeGateway({ observations: [settled("interim line"), settled("interim line")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe("interim line");

    ctrl.finishChat("the real final answer");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real final answer");
  });

  it("does not complete on an interim status line the run later moves past", async () => {
    vi.useFakeTimers();
    // The documented hazard: chat.history exposes whatever the agent last
    // wrote. A run can flash a short status line, keep working for minutes,
    // and only then produce its real answer.
    const ctrl = fakeGateway({
      observations: [
        settled("I'm tracing the live wiring now…", "k1"),
        advancing("k2"),
        settled("the real answer", "k3"),
        settled("the real answer", "k3"),
      ],
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    // Rounds 1-4: the interim line is seen but never confirmed; the run then
    // visibly advances (k2, k3), which resets the accumulated evidence each
    // time. Nothing here may finalize the job.
    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }

    // Only when the real answer repeats against an unmoved transcript.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    // Never the status line — the interim text was never confirmed.
    expect(live.summary).toBe("the real answer");
  });

  it("treats progress BETWEEN rounds as activity, even when each round looks internally stable", async () => {
    vi.useFakeTimers();
    // A run advancing one slow tool round at a time looks unchanged inside
    // any single 15s observation window; only the cross-round snapshot
    // comparison reveals it.
    const ctrl = fakeGateway({
      observations: [settled("", "round-1"), settled("", "round-2"), settled("", "round-3")],
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "slow tool loop" });
    emitToolRound(ctrl);

    for (let round = 0; round < 3; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }
  });

  it("never completes on unconfirmed text — one unreadable round plus one interim line is not evidence", async () => {
    vi.useFakeTimers();
    // Reaching the round cap is not a substitute for confirmation: the first
    // round told us nothing at all, so the interim line the second round
    // happens to see has been observed exactly once.
    const ctrl = fakeGateway({ observations: [unreadable(), settled("I'm tracing the live wiring now…")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    const live = sessions.getJob(job.jobId)!;
    // Bounded and self-healing: the lazy terminal recheck upgrades this to
    // `completed` later if the text really was final.
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).not.toContain("tracing the live wiring");
  });

  it("resets accumulated quiet rounds when live activity arrives between them", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "bursty job" });
    emitToolRound(ctrl);

    // Quiet gap #1 — one round against the cap.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Real activity: the run is demonstrably alive, so the earlier quiet
    // round must not still count toward forcing it terminal.
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Only two genuinely consecutive quiet rounds end it.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
  });
});

describe("completion reconciliation — handing the job off safely", () => {
  it("an in-flight round that loses ownership to late-recovery neither finalizes nor re-arms", async () => {
    vi.useFakeTimers();
    const reconcileGate = deferred<RunObservation>();
    const recoveryGate = deferred<string | undefined>();
    const ctrl = fakeGateway({
      // The blocked round is the SECOND one, so it is a round that would
      // otherwise reach the cap and finalize the job — the case where losing
      // ownership silently costs the caller the real answer.
      observations: [settled(""), () => reconcileGate.promise],
      pollTranscriptForFinalText: () => recoveryGate.promise,
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Round two starts and blocks on the transcript read.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(ctrl.reconcileCalls).toHaveLength(2);

    // Meanwhile chat() resolves with the empty sentinel: the watchdog is
    // cleared and recoverLateFinalText takes ownership, keeping the job
    // `running` while it long-polls.
    ctrl.finishChat(SENTINEL);
    await vi.advanceTimersByTimeAsync(0);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("running");
    expect(live.recovery).toBeDefined();

    // The stale round now comes back with a verdict that would, on its own,
    // have forced the job terminal at the round cap.
    reconcileGate.resolve(settled(""));
    await vi.advanceTimersByTimeAsync(0);

    expect(live.status).toBe("running");
    expect(live.summary).toBeUndefined();
    expect(live.recovery).toBeDefined();

    // ...and it must not have re-armed a watchdog it no longer owns.
    await vi.advanceTimersByTimeAsync(4 * PAST_QUIET_MS);
    expect(ctrl.reconcileCalls).toHaveLength(2);

    // Late recovery, still the owner, finishes the job. A stale round that
    // had marked it terminal would have made recovery drop this answer.
    recoveryGate.resolve("the recovered answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the recovered answer");
  });

  it("a round that overlaps live activity is stale — it must not finalize a demonstrably live run", async () => {
    vi.useFakeTimers();
    const gate = deferred<RunObservation>();
    // Round 1 banks a quiet round; round 2 is the one that would reach the
    // cap — and it is blocked when the run proves it is still alive.
    const ctrl = fakeGateway({ observations: [settled(""), () => gate.promise] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(ctrl.reconcileCalls).toHaveLength(2);

    // Live event lands while the transcript read is still in flight, after
    // the round already captured its round number.
    emitToolRound(ctrl);

    // The now-stale observation comes back with a verdict that, taken at
    // face value, reaches the round cap.
    gate.resolve(settled(""));
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("running");
    expect(live.summary).toBeUndefined();

    // ...and the busy-session guard is still held, so nothing can collide
    // with the run that is genuinely still going.
    const colliding = sessions.submitTask({ task: "colliding ask", sessionKey: job.sessionKey });
    expect(colliding.status).toBe("error");
    expect(colliding.errorInfo?.message).toBe("session busy");
  });

  it("a late live final upgrades a reconciled completed_no_summary", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");

    ctrl.finishChat("the answer, arriving very late");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the answer, arriving very late");
  });

  it("a late live final never overwrites the continuation state of a newer job on the same session", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:handoff";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(first.jobId)?.status).toBe("completed_no_summary");

    // The session is free again, so the caller starts new work on it.
    const second = sessions.submitTask({ task: "second ask", sessionKey });
    expect(second.status).toBe("running");

    // Only now does the abandoned first stream deliver its answer.
    ctrl.finishChat("the stale first answer", 0);
    await vi.advanceTimersByTimeAsync(0);

    // The old job records its own outcome...
    expect(sessions.getJob(first.jobId)?.summary).toBe("the stale first answer");
    // ...but the session still belongs to the job that is actually running.
    const continuation = sessions.getSessionState(sessionKey);
    expect(continuation?.lastJobId).toBe(second.jobId);
    expect(continuation?.lastSummary).not.toBe("the stale first answer");
  });

  it("a superseded terminal job never consumes the newer job's transcript on recheck", async () => {
    vi.useFakeTimers();
    // Reconciliation ends abandoned runs, which frees the session — so a
    // terminal job can now be polled while a NEWER job runs on the same
    // sessionKey. The old job's lazy recheck must not read (and claim) the
    // new run's answer.
    const pollSpy = vi.fn(async () => "the newer job's answer");
    const ctrl = fakeGateway({ observations: [settled("")], pollTranscriptForFinalText: pollSpy });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:supersede";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(first.jobId)?.status).toBe("completed_no_summary");

    const second = sessions.submitTask({ task: "second ask", sessionKey });
    expect(second.status).toBe("running");

    // Polling the OLD job: the recheck must not fire at all.
    await sessions.waitForJob(first.jobId, 0, undefined, "wait", 1_000);

    expect(pollSpy).not.toHaveBeenCalled();
    expect(sessions.getJob(first.jobId)?.status).toBe("completed_no_summary");
    expect(sessions.getJob(first.jobId)?.summary).not.toBe("the newer job's answer");
    expect(sessions.getSessionState(sessionKey)?.lastJobId).toBe(second.jobId);
  });

  it("the abandoned live stream timing out does not overwrite a reconciled completion", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("the real answer"), settled("the real answer")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");

    ctrl.failChat(new Error("OpenClaw task timed out"));
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real answer");
    expect(live.error).toBeUndefined();
  });
});

describe("completion reconciliation — caller-visible effects", () => {
  it("repeated check_task calls after a reconciled completion are idempotent", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("the real answer"), settled("the real answer")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    const callsAfterReconcile = ctrl.reconcileCalls.length;
    const snapshots = [];
    for (let i = 0; i < 3; i++) {
      const polled = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 45_000);
      snapshots.push(sessions.buildSnapshot(polled!));
    }

    for (const snapshot of snapshots) {
      expect(snapshot.status).toBe("completed");
      expect(snapshot.summary).toBe("the real answer");
      expect(snapshot.continuePolling).toBe(false);
      expect(snapshot.nextAction).toBeNull();
    }
    // Polling a settled job must not re-open the reconciliation loop.
    expect(ctrl.reconcileCalls).toHaveLength(callsAfterReconcile);
  });

  it("repeated check_task calls after a reconciled completed_no_summary stay stable", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      observations: [settled("")],
      pollTranscriptForFinalText: async () => undefined,
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    for (let i = 0; i < 3; i++) {
      const polled = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 45_000);
      const snapshot = sessions.buildSnapshot(polled!);
      expect(snapshot.status).toBe("completed_no_summary");
      expect(snapshot.continuePolling).toBe(false);
    }
  });

  it("releases the busy-session guard once the job is reconciled terminal", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("the real answer"), settled("the real answer")] });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:busy-release";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    emitToolRound(ctrl);

    // While it's running, a second submit on the same session is refused —
    // a colliding chat.send would abort the in-flight run.
    const blocked = sessions.submitTask({ task: "second ask", sessionKey });
    expect(blocked.status).toBe("error");
    expect(blocked.errorInfo?.message).toBe("session busy");

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(first.jobId)?.status).toBe("completed");

    // Reconciliation ended the run, so the session is usable again —
    // otherwise a dropped terminal event would wedge the session for the
    // full 30-minute chat() timeout.
    const next = sessions.submitTask({ task: "third ask", sessionKey });
    expect(next.status).toBe("running");
    expect(next.errorInfo).toBeUndefined();
  });
});
