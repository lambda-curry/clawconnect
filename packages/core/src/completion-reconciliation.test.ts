import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONCILE_QUIET_MS, SessionManager } from "./session.ts";
import type { OpenClawGateway, RunObservation } from "./gateway.ts";
import { NO_SUMMARY_SENTINEL, ParentObservationTimeoutError, type GatewayEvent } from "./types.ts";

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

type Upstream = RunObservation["upstream"];
// `unknown` by default: an openclaw that reports no run state, which is the
// conservative inference-only path every pre-existing fixture exercises.
const settled = (
  trailingText: string,
  snapshotKey = "settled-1",
  upstream: Upstream = "unknown",
): RunObservation => ({ ok: true, changed: false, trailingText, snapshotKey, upstream });
const advancing = (snapshotKey = "advancing-1", upstream: Upstream = "unknown"): RunObservation => ({
  ok: true,
  changed: true,
  trailingText: "",
  snapshotKey,
  upstream,
});
const unreadable = (): RunObservation => ({
  ok: false,
  changed: false,
  trailingText: "",
  snapshotKey: "",
  upstream: "unknown",
});

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
    abort?: (sessionKey: string, runId?: string) => Promise<{ ok: boolean; aborted: boolean }>;
  } = {},
) {
  const calls: {
    sessionKey: string;
    message: string;
    onEvent?: (e: GatewayEvent) => void;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  const abortCalls: { sessionKey: string; runId?: string }[] = [];
  const reconcileCalls: string[] = [];
  const reconcileRunIds: (string | undefined)[] = [];
  let observationIndex = 0;

  const gateway = {
    chat(
      sessionKey: string,
      message: string,
      _timeoutMs: number,
      onEvent?: (e: GatewayEvent) => void,
      onRunId?: (runId: string) => void,
    ) {
      // Mirrors the real signature: openclaw hands back a runId once
      // chat.send resolves. A fake that drops this silently leaves every
      // correlation path untested.
      onRunId?.(`run-for-${sessionKey.slice(-8)}`);
      // Never settles on its own: every fixture here is about a run whose
      // terminal event never reaches the connector.
      return new Promise<string>((resolve, reject) => {
        calls.push({ sessionKey, message, onEvent, resolve, reject });
      });
    },
    abort(sessionKey: string, runId?: string) {
      abortCalls.push({ sessionKey, runId });
      return opts.abort?.(sessionKey, runId) ?? Promise.resolve({ ok: true, aborted: true });
    },
    async reconcileRun(sessionKey: string, options?: { runId?: string }): Promise<RunObservation> {
      reconcileCalls.push(sessionKey);
      reconcileRunIds.push(options?.runId);
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
    abortCalls,
    reconcileCalls,
    reconcileRunIds,
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
// The real constant, not a copy — so a change to it fails here rather than
// silently decoupling the fixtures from what the connector actually emits.
const SENTINEL = NO_SUMMARY_SENTINEL;

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

describe("task cancellation — upstream and recovery share one terminal path", () => {
  it("aborts a normal running task and releases the session for reuse", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ abort: async () => ({ ok: true, aborted: true }) });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "cancel this", sessionKey: "agent:main:main:thread:cancel" });

    await sessions.requestCancel(job.jobId);
    await sessions.requestCancel(job.jobId);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctrl.abortCalls).toEqual([
      { sessionKey: job.sessionKey, runId: `run-for-${job.sessionKey.slice(-8)}` },
    ]);
    expect(sessions.getJob(job.jobId)).toMatchObject({
      status: "cancelled",
      terminalReason: "cancelled-by-request",
    });
    expect(sessions.buildSnapshot(sessions.getJob(job.jobId)!)).toMatchObject({
      status: "cancelled",
      continuePolling: false,
      nextAction: null,
    });
    expect(sessions.submitTask({ task: "reuse after cancel", sessionKey: job.sessionKey }).status).toBe("running");
  });

  it("cancels a job already inside no-live-final-text recovery", async () => {
    vi.useFakeTimers();
    const recoveryGate = deferred<string | undefined>();
    const ctrl = fakeGateway({
      pollTranscriptForFinalText: () => recoveryGate.promise,
      abort: async () => ({ ok: true, aborted: true }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "recover then cancel" });

    ctrl.finishChat(SENTINEL);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.recovery?.reason).toBe("no_live_final_text");

    await sessions.requestCancel(job.jobId);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)).toMatchObject({
      status: "cancelled",
      terminalReason: "cancelled-by-request",
    });

    // The in-flight recovery read may resolve after cancellation, but it must
    // observe the terminal state and never reopen or overwrite the job.
    recoveryGate.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.status).toBe("cancelled");
  });

  it("terminalizes an unconfirmed upstream cancellation instead of wedging running forever", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ abort: async () => ({ ok: true, aborted: false }) });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "upstream disappeared" });

    await sessions.requestCancel(job.jobId);
    await vi.advanceTimersByTimeAsync(0);

    const terminal = sessions.getJob(job.jobId)!;
    expect(terminal.status).toBe("error");
    expect(terminal.terminalReason).toBe("cancellation-not-confirmed");
    expect(terminal.error).toMatch(/no active run/);
    expect(sessions.buildSnapshot(terminal).continuePolling).toBe(false);
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

  it("never terminates on silence alone — upstream showing no text is not evidence the run ended", async () => {
    vi.useFakeTimers();
    // An empty trailing slot is exactly what a run composing its final
    // answer looks like: openclaw writes the assistant message only once it
    // is complete, so the transcript sits on the last toolResult the whole
    // time. No number of stable rounds may turn that into a terminal status.
    const ctrl = fakeGateway({ observations: [settled("")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    for (let round = 0; round < 6; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }
    expect(ctrl.reconcileCalls).toHaveLength(6);
    expect(sessions.getJob(job.jobId)?.summary).toBeUndefined();
  });

  it("an unreadable upstream never forces a terminal status — the bound is the transcript recovery chat()'s timeout hands off to", async () => {
    vi.useFakeTimers();
    // The default fake transcript poll yields nothing, so recovery exhausts
    // immediately once it takes over.
    const ctrl = fakeGateway({ observations: [unreadable()] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }

    // Boundedness is not lost, it just isn't chat()'s to declare: the wait
    // window elapsing says the parent stopped watching, not that the run
    // failed, so the job goes to transcript recovery and ends there — with a
    // non-error terminal status when the transcript has nothing to give.
    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.error).toBeUndefined();
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
    expect(live.status).toBe("running");
    expect(live.summary).toBeUndefined();
  });

  it("resets accumulated quiet rounds when live activity arrives between them", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("the answer")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "bursty job" });
    emitToolRound(ctrl);

    // Quiet round #1 banks "the answer" as a confirmation candidate.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Real activity proves the run moved on, so that candidate is stale and
    // must not pair with a later sighting to confirm a completion.
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Two fresh consecutive sightings are needed after the activity.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe("the answer");
  });
});

describe("completion reconciliation — upstream liveness keeps a job alive, never ends it", () => {
  it("never terminates a run upstream reports as still executing, however long the transcript is frozen", async () => {
    vi.useFakeTimers();
    // The job 9f21545a shape, now with the signal that actually resolves it.
    // Verified on the wire 2026-08-02: a sleeping run reported
    // hasActiveRun=true with its runId listed while chat.history sat at a
    // single user message — transcript-identical to a dead run.
    // trailingText is deliberately NON-empty and stable: under the `unknown`
    // fallback two such rounds would confirm and complete the job, so only
    // the upstream-active branch can keep it running. With an empty string
    // this fixture would pass even with that branch deleted.
    const ctrl = fakeGateway({ observations: [settled("an interim line", "frozen", "active")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long silent composition" });
    for (let i = 0; i < 20; i++) emitToolRound(ctrl);

    for (let round = 0; round < 10; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
      expect(sessions.getJob(job.jobId)?.summary).toBeUndefined();
    }
    // ...and the runId was actually correlated, not dropped.
    expect(ctrl.reconcileRunIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    const colliding = sessions.submitTask({ task: "colliding", sessionKey: job.sessionKey });
    expect(colliding.errorInfo?.message).toBe("session busy");

    ctrl.finishChat("the real answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the real answer");
  });

  it("falls back to conservative two-round confirmation when upstream reports no run state", async () => {
    vi.useFakeTimers();
    // An openclaw without hasActiveRun must not get the fast path.
    const ctrl = fakeGateway({ observations: [settled("some text", "k", "unknown")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "older upstream" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
  });
});

describe("completion reconciliation — the live job 9f21545a shape", () => {
  it("never terminates a healthy run that goes silent for 21 minutes while composing its final answer", async () => {
    vi.useFakeTimers();
    // Reproduced from live evidence (job 9f21545a-7998-4b49-8a82-a60b541faa13,
    // 2026-08-02): 20 tool rounds with every start matched by a result, then
    // 20.9 minutes with zero live events and a transcript frozen on the last
    // toolResult — openclaw's chat.history for that session carried only
    // ["toolResult","assistant"] roles and every tool-calling assistant
    // message had visibleTextLen 0, so trailing assistant text was "" the
    // whole time. Then the run returned a 6942-char report and completed
    // normally. Nothing was missing: no dropped tool-result, no dropped
    // lifecycle event, no gateway disconnect.
    const LONG_REPORT = "## Objective A — second cleanup complete\n\n" + "x".repeat(6900);
    const ctrl = fakeGateway({ observations: [settled("", "frozen-on-toolresult")] });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "audit disk usage across the fleet" });
    for (let i = 0; i < 20; i++) emitToolRound(ctrl);

    // Ten quiet windows — far longer than the observed 20.9-minute silence.
    for (let round = 0; round < 10; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      const live = sessions.getJob(job.jobId)!;
      expect(live.status).toBe("running");
      expect(live.summary).toBeUndefined();
    }

    // The session guard must hold for the entire composition window: a
    // colliding chat.send would abort the run that is still writing.
    const colliding = sessions.submitTask({ task: "colliding ask", sessionKey: job.sessionKey });
    expect(colliding.errorInfo?.message).toBe("session busy");

    ctrl.finishChat(LONG_REPORT);
    await vi.advanceTimersByTimeAsync(0);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe(LONG_REPORT);
  });

  /** Drive a job to a provisional reconciled `completed` carrying `text`. */
  async function reconcileToProvisionalCompleted(
    text: string,
    pollTranscriptForFinalText: () => Promise<string | undefined>,
  ) {
    const ctrl = fakeGateway({ observations: [settled(text)], pollTranscriptForFinalText });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe(text);
    return { ctrl, sessions, job };
  }

  it("re-reads a provisional reconciled completion on a later poll and corrects its summary", async () => {
    vi.useFakeTimers();
    // A reconciled `completed` is inferred from a transcript read, never from
    // a terminal event, so it must not be treated as settled truth the way a
    // live completion is.
    const pollSpy = vi.fn(async () => "the corrected final answer");
    const { sessions, job } = await reconcileToProvisionalCompleted("an early guess", pollSpy);

    const polled = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(polled?.status).toBe("completed");
    expect(polled?.summary).toBe("the corrected final answer");
    expect(pollSpy).toHaveBeenCalledTimes(1);

    // The read CHANGED the summary, so the outcome is genuinely healed and
    // stops being re-read.
    await vi.advanceTimersByTimeAsync(21_000); // past the recheck cooldown
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it("never lets a re-read that was already in flight clobber the live final that landed during it", async () => {
    vi.useFakeTimers();
    // Reviewer blocker D2, the ordering sibling of D1. The re-read guard only
    // re-checked session ownership across its await, not whether the outcome
    // had changed underneath it — so a read that started BEFORE the run
    // delivered its terminal text could still write that older inference back
    // on top of it. Permanently: chat() settling has already retired the
    // provisional flag, so nothing replaces the summary again and no later
    // poll re-reads it.
    const readGate = deferred<string | undefined>();
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted(
      "an early guess",
      () => readGate.promise,
    );

    // A lazy re-check starts and blocks on the transcript read.
    const polling = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);

    // While it is in flight, the run's real final answer arrives on chat().
    ctrl.finishChat("the real final answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the real final answer");

    // The stale read now resolves, carrying transcript text from before the
    // run finished. It must be discarded, not written back.
    readGate.resolve("stale text from the transcript");
    await polling;
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the real final answer");

    // ...and it must still be the real answer once the cooldown has passed —
    // the damage this guards against is permanent, not transient.
    await vi.advanceTimersByTimeAsync(21_000);
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real final answer");
  });

  it("still applies an in-flight re-read's correction when chat() rejects while it is reading", async () => {
    vi.useFakeTimers();
    // The superseded-while-reading guard must key on the OUTCOME changing, not
    // on the provisional flag being retired. A chat() that rejects retires the
    // flag while producing no answer at all, so there is nothing to be
    // superseded BY — and this read's correction is the best evidence the job
    // will ever get. Suppressing it here would be permanent.
    const readGate = deferred<string | undefined>();
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted(
      "an early guess",
      () => readGate.promise,
    );

    const polling = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
    await vi.advanceTimersByTimeAsync(0);

    readGate.resolve("the corrected final from the transcript");
    await polling;
    await vi.advanceTimersByTimeAsync(0);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the corrected final from the transcript");
    expect(live.error).toBeUndefined();
  });

  it("still applies an in-flight re-read's correction when chat() settles with the sentinel while it is reading", async () => {
    vi.useFakeTimers();
    // Same rule, the other empty settlement: the sentinel carries no answer,
    // so it supersedes nothing and must not suppress the read.
    const readGate = deferred<string | undefined>();
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted(
      "an early guess",
      () => readGate.promise,
    );

    const polling = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    ctrl.finishChat(SENTINEL);
    await vi.advanceTimersByTimeAsync(0);

    readGate.resolve("the corrected final from the transcript");
    await polling;
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the corrected final from the transcript");
  });

  it("refuses to start a second re-read while one is still in flight", async () => {
    vi.useFakeTimers();
    // A read can outlive the cooldown that spaces reads apart: its own budget
    // is attempts*intervalMs (12s), but that is only checked BETWEEN attempts,
    // so one slow chat.history (20s RPC timeout) overruns it — ~32s against a
    // 20s cooldown. Two reads in flight then race to write the outcome, and
    // every ordering question that follows ("which started first?", "what if
    // the newer one comes back empty?") is only answerable by arbitration.
    // Forbidding the overlap deletes all of them at once, so THIS is the
    // property worth pinning.
    const inFlight = deferred<string | undefined>();
    let reads = 0;
    const { sessions, job } = await reconcileToProvisionalCompleted("an early guess", () => {
      reads += 1;
      return inFlight.promise;
    });

    const pollingA = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);

    // Cooldown elapses while the first read is STILL out. Without the
    // in-flight guard this second poll starts a competing read.
    await vi.advanceTimersByTimeAsync(21_000);
    const pollingB = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await pollingB;

    // Resolve with the SAME text the job already holds: that heals nothing, so
    // the job stays eligible for re-reading and the gate reopening is what the
    // next assertion actually measures (a healing read deliberately ends the
    // re-read loop, which would mask it).
    inFlight.resolve("an early guess");
    await pollingA;
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("an early guess");

    // The gate is a gate, not a latch — once the read is done another may run.
    await vi.advanceTimersByTimeAsync(21_000);
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(reads).toBe(2);
  });

  it("clears the in-flight flag when the read throws, so the job can still be re-read", async () => {
    vi.useFakeTimers();
    // The flag is reset in a `finally` precisely so a throwing read cannot
    // strand it. Without that, one transient chat.history failure would wedge
    // the job out of ever being re-read again — permanently, and silently.
    let reads = 0;
    const { sessions, job } = await reconcileToProvisionalCompleted("an early guess", async () => {
      reads += 1;
      if (reads === 1) throw new Error("chat.history blew up");
      return "the recovered answer";
    });

    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(reads).toBe(1);
    expect(sessions.getJob(job.jobId)?.summary).toBe("an early guess");

    await vi.advanceTimersByTimeAsync(21_000); // past the recheck cooldown
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(reads).toBe(2);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the recovered answer");
  });

  it("discards a stale read even when the live final carried byte-identical text", async () => {
    vi.useFakeTimers();
    // The version counter exists for exactly this: comparing summary values
    // before and after the read cannot see a superseding write that happens
    // to carry the same string, so the stale read would sail past the guard
    // and overwrite the run's own terminal answer with older transcript text.
    const readGate = deferred<string | undefined>();
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted(
      "an early guess",
      () => readGate.promise,
    );

    const polling = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    await vi.advanceTimersByTimeAsync(0);

    // chat() settles with text IDENTICAL to what the job already holds.
    ctrl.finishChat("an early guess");
    await vi.advanceTimersByTimeAsync(0);

    readGate.resolve("stale text from the transcript");
    await polling;
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.summary).toBe("an early guess");
  });

  it("still lets a later real live final replace an outcome a transcript re-read already corrected", async () => {
    vi.useFakeTimers();
    // Reviewer blocker D1. The re-read is itself an inference; the live final
    // is the run's own terminal text. Letting the former retire the guard
    // that protects the latter silently discarded the real answer.
    const pollSpy = vi.fn(async () => "text from the transcript re-read");
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted("an early guess", pollSpy);

    // A re-read lands first and corrects the summary.
    const afterRecheck = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(afterRecheck?.summary).toBe("text from the transcript re-read");

    // Having corrected it, the loop stops re-reading...
    await vi.advanceTimersByTimeAsync(21_000); // past the recheck cooldown
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);

    // ...but the run's actual final answer, arriving afterwards, still wins.
    ctrl.finishChat("the real final answer");
    await vi.advanceTimersByTimeAsync(0);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real final answer");
  });

  it("stops re-reading a provisional completion once chat() settles with the no-summary sentinel", async () => {
    vi.useFakeTimers();
    // The re-read loop exists to catch a text that changes. A transcript that
    // never changes would otherwise keep it alive on every poll forever, so
    // chat() settling — the last live evidence the job can ever get — has to
    // close it out.
    const pollSpy = vi.fn(async () => "an early guess");
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted("an early guess", pollSpy);

    // Still provisional while chat() is outstanding: the re-read happens.
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);

    ctrl.finishChat(SENTINEL);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(21_000); // past the recheck cooldown
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
    // The sentinel carries nothing, so the reconciled outcome is untouched.
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe("an early guess");
  });

  it("stops re-reading a provisional completion once chat() rejects", async () => {
    vi.useFakeTimers();
    const pollSpy = vi.fn(async () => "an early guess");
    const { ctrl, sessions, job } = await reconcileToProvisionalCompleted("an early guess", pollSpy);

    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);

    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(21_000);
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
    // The abandoned stream's timeout must not overwrite the outcome either.
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.error).toBeUndefined();
  });

  it("stays provisional when a re-read returns the identical text off a still-frozen transcript", async () => {
    vi.useFakeTimers();
    // Reading the same text twice is the same inference twice, not
    // confirmation — and a frozen transcript is precisely the condition that
    // made the first inference unsafe. The job must remain eligible for
    // later re-reads rather than being locked to a possibly-interim summary.
    const pollSpy = vi.fn(async () => "an early guess");
    const { sessions, job } = await reconcileToProvisionalCompleted("an early guess", pollSpy);

    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(sessions.getJob(job.jobId)?.summary).toBe("an early guess");

    await vi.advanceTimersByTimeAsync(21_000); // past the recheck cooldown
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(pollSpy).toHaveBeenCalledTimes(2);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
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

  it("a round that overlaps live activity is stale — its observation must not be written back", async () => {
    vi.useFakeTimers();
    const gate = deferred<RunObservation>();
    // Round 1 banks "T" as a confirmation candidate. Round 2 is blocked when
    // live activity lands, which resets that candidate — so round 2's
    // observation predates the run moving on and must not be written back
    // into the reconciler state, or it would pair with round 3 and complete
    // the job a round early on evidence older than the activity.
    const ctrl = fakeGateway({
      observations: [settled("T", "k1"), () => gate.promise, settled("T", "k1")],
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Round two starts and blocks on the transcript read.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(ctrl.reconcileCalls).toHaveLength(2);

    // Live event lands while that read is still in flight.
    emitToolRound(ctrl);
    gate.resolve(settled("T", "k1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    // Round three is the FIRST post-activity sighting of "T". Had the stale
    // round seeded the candidate, this would confirm and complete here.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");
    expect(sessions.getJob(job.jobId)?.summary).toBeUndefined();

    // The busy-session guard is held throughout.
    const colliding = sessions.submitTask({ task: "colliding ask", sessionKey: job.sessionKey });
    expect(colliding.errorInfo?.message).toBe("session busy");

    // Two genuinely post-activity sightings do complete it.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.getJob(job.jobId)?.summary).toBe("T");
  });

  it("a late live final never overwrites the continuation state of a newer job on the same session", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ observations: [settled("recovered text")] });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:handoff";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    emitToolRound(ctrl);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(first.jobId)?.status).toBe("completed");

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
    const ctrl = fakeGateway({ observations: [settled("first answer")], pollTranscriptForFinalText: pollSpy });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:supersede";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    emitToolRound(ctrl);

    // A reconciled completion is provisional, so it stays eligible for the
    // lazy transcript recheck — which makes the ownership guard load-bearing.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(first.jobId)?.status).toBe("completed");

    const second = sessions.submitTask({ task: "second ask", sessionKey });
    expect(second.status).toBe("running");

    // Polling the OLD job: the recheck must not fire at all.
    await sessions.waitForJob(first.jobId, 0, undefined, "wait", 1_000);

    expect(pollSpy).not.toHaveBeenCalled();
    expect(sessions.getJob(first.jobId)?.summary).toBe("first answer");
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

    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
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
    // completed_no_summary is still reachable — from the live stream itself
    // resolving with the sentinel, where chat() HAS delivered a terminal
    // event and recoverLateFinalText then finds nothing.
    const ctrl = fakeGateway({
      observations: [settled("")],
      pollTranscriptForFinalText: async () => undefined,
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    emitToolRound(ctrl);
    ctrl.finishChat(SENTINEL);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");

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

/**
 * The parent's 30-minute observation window (TIMEOUT_MS) elapsing is the ONE
 * chat() rejection that carries no verdict about the run: nothing aborted it,
 * openclaw is very likely still executing, and the answer lands in the durable
 * transcript afterwards. Every other rejection — error/aborted/RPC/connection
 * — IS an upstream verdict and must stay terminal.
 */
describe("completion reconciliation — a parent observation timeout is not the run's verdict", () => {
  it("keeps the job pollable across the timeout boundary and completes it from the transcript the still-running run later writes", async () => {
    vi.useFakeTimers();
    // The run is demonstrably alive the whole time the parent is watching:
    // upstream keeps reporting an advancing transcript.
    const recoveryGate = deferred<string | undefined>();
    const ctrl = fakeGateway({
      observations: [advancing("advancing-1", "active")],
      pollTranscriptForFinalText: () => recoveryGate.promise,
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "a two-hour refactor" });
    emitToolRound(ctrl);

    for (let round = 0; round < 3; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }

    // The parent gives up watching. The run does not stop.
    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("running");
    expect(live.error).toBeUndefined();
    expect(live.errorInfo).toBeUndefined();
    expect(live.recovery?.reason).toBe("parent_observation_timeout");

    // ...and the caller sees a job it is told to keep polling, not a failure.
    const crossing = sessions.buildSnapshot(live);
    expect(crossing.status).toBe("running");
    expect(crossing.continuePolling).toBe(true);
    expect(crossing.nextAction).toEqual({
      tool: "check_task",
      args: { jobId: job.jobId, sessionKey: job.sessionKey },
    });
    expect(crossing.error).toBeUndefined();

    // A check_task wait window elapsing on the far side of the boundary is
    // still just a timeout: same job, still running, no duplicate submitted.
    const polling = sessions.waitForJob(job.jobId, 0, undefined, "wait", 2_000);
    await vi.advanceTimersByTimeAsync(2_500);
    const polled = await polling;
    expect(polled?.jobId).toBe(job.jobId);
    expect(polled?.status).toBe("running");
    expect(sessions.buildSnapshot(polled!).continuePolling).toBe(true);
    expect(sessions.getJobHistory(job.sessionKey).map((j) => j.jobId)).toEqual([job.jobId]);

    // The run finally writes its answer to the durable transcript.
    recoveryGate.resolve("the answer the run wrote 40 minutes in");
    await vi.advanceTimersByTimeAsync(0);

    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the answer the run wrote 40 minutes in");
    expect(live.resultSource).toBe("parent");
    expect(live.terminalReason).toBe("late-recovery-transcript");
    expect(live.error).toBeUndefined();
    expect(live.recovery).toBeUndefined();
    const settledSnapshot = sessions.buildSnapshot(live);
    expect(settledSnapshot.continuePolling).toBe(false);
    expect(settledSnapshot.nextAction).toBeNull();
  });

  it("holds the session's busy guard while the timed-out run is still being recovered", async () => {
    vi.useFakeTimers();
    // The corollary of staying `running`: a second submit would collide with
    // the live upstream run and abort it. check_task's contract already tells
    // callers never to re-submit because a wait timed out — this is what
    // enforces it.
    const recoveryGate = deferred<string | undefined>();
    const ctrl = fakeGateway({ pollTranscriptForFinalText: () => recoveryGate.promise });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:parent-timeout";
    const job = sessions.submitTask({ task: "a two-hour refactor", sessionKey });
    emitToolRound(ctrl);

    ctrl.failChat(new ParentObservationTimeoutError(30 * 60_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");

    const blocked = sessions.submitTask({ task: "same session, again", sessionKey });
    expect(blocked.status).toBe("error");
    expect(blocked.errorInfo?.message).toBe("session busy");

    // Once recovery lands the answer, the session is usable again.
    recoveryGate.resolve("the recovered answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed");
    expect(sessions.submitTask({ task: "next ask", sessionKey }).status).toBe("running");
  });

  it("still ends the job in error when the gateway reports the run itself failed", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => "text that must never be used" });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "doomed job" });
    emitToolRound(ctrl);

    ctrl.failChat(new Error("provider returned 500"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("error");
    expect(live.error).toBe("provider returned 500");
    expect(live.terminalReason).toBe("chat-error");
    expect(live.recovery).toBeUndefined();
    const snapshot = sessions.buildSnapshot(live);
    expect(snapshot.continuePolling).toBe(false);
    expect(snapshot.nextAction).toBeNull();
  });

  it("still ends the job in error when the run is aborted", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "aborted job" });

    ctrl.failChat(new Error("OpenClaw task aborted"));
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.getJob(job.jobId)?.status).toBe("error");
    expect(sessions.getJob(job.jobId)?.error).toBe("OpenClaw task aborted");
  });

  it("does not treat a message that merely mentions a timeout as the parent's own window", async () => {
    vi.useFakeTimers();
    // "OpenClaw handshake timeout" and "RPC timeout: chat.send" are real
    // connection failures. Only the typed rejection chat()'s own timer raises
    // means "the run is probably still going".
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "unreachable gateway" });

    ctrl.failChat(new Error("RPC timeout: chat.send"));
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.getJob(job.jobId)?.status).toBe("error");
    expect(sessions.getJob(job.jobId)?.recovery).toBeUndefined();
  });
});

describe("completion reconciliation — the one-writer invariant is enforced, not remembered", () => {
  it("nothing outside setOutcome assigns a job's outcome fields", () => {
    // The version guard in maybeRecoverTerminalJob is only sound if EVERY
    // outcome write bumps the version, and the only thing that bumps it is
    // setOutcome. A stray write added later would silently punch a hole in
    // that guard and no behavioural test would notice — the race it protects
    // against needs precise interleaving to reproduce. So assert it
    // structurally.
    //
    // What this deliberately does NOT catch, so nobody mistakes it for proof:
    // Object.assign(job, …), computed access job["status"], and writes in
    // other files. Catching those needs a real parse; this is a tripwire for
    // the ordinary case, not a proof of the invariant.
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
    const start = source.indexOf("private setOutcome(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  }\n", start);
    expect(end).toBeGreaterThan(start);
    const code = (source.slice(0, start) + source.slice(end))
      // Strings BEFORE comments: a "//" inside a URL literal, or a "/*" inside
      // a string, would otherwise blank out real code after it and hide a
      // stray write. Order matters here and is the reason this is spelled out.
      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // Any receiver, not just `job` — an alias (`const j = job; j.status = …`)
    // punches the same hole. Compound forms (??=, ||=, +=) too.
    const strays = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) =>
        /[\w$)\]]\s*\.\s*(status|summary|error|errorInfo)\s*(\?\?|\|\||&&|\+|-)?=(?!=)/.test(line),
      )
      .map(({ line, n }) => `line ${n}: ${line}`);
    expect(strays).toEqual([]);
  });
});
