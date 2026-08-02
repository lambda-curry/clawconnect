import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session.ts";
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
 * outcome. See SessionManager.reconcileQuietRun.
 */

const QUIET_MS = 120_000; // RECONCILE_QUIET_MS in session.ts
const PAST_QUIET_MS = QUIET_MS + 1_000;

function fakeGateway(
  opts: {
    reconcile?: () => Promise<RunObservation>;
    pollTranscriptForFinalText?: () => Promise<string | undefined>;
  } = {},
) {
  let onEventCb: ((e: GatewayEvent) => void) | undefined;
  let resolveChat: ((v: string) => void) | undefined;
  let rejectChat: ((e: Error) => void) | undefined;
  const reconcileCalls: string[] = [];
  const gateway = {
    chat(_sessionKey: string, _message: string, _timeoutMs: number, onEvent?: (e: GatewayEvent) => void) {
      onEventCb = onEvent;
      // Never settles on its own: every fixture here is about a run whose
      // terminal event never reaches the connector.
      return new Promise<string>((resolve, reject) => {
        resolveChat = resolve;
        rejectChat = reject;
      });
    },
    async reconcileRun(sessionKey: string): Promise<RunObservation> {
      reconcileCalls.push(sessionKey);
      if (opts.reconcile) return opts.reconcile();
      return { ok: true, changed: true, trailingText: "" };
    },
    pollTranscriptForFinalText: opts.pollTranscriptForFinalText ?? (async () => undefined),
    close() {},
  } as unknown as OpenClawGateway;

  return {
    gateway,
    reconcileCalls,
    emit: (e: GatewayEvent) => onEventCb?.(e),
    finishChat: (text: string) => resolveChat?.(text),
    failChat: (err: Error) => rejectChat?.(err),
  };
}

const toolEvent: GatewayEvent = { type: "tool", text: "Bash: pnpm test", toolName: "Bash", args: {} };
const toolResultEvent: GatewayEvent = { type: "tool-result", text: "Bash done", toolName: "Bash", isError: false };

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

    // Steady activity at half the quiet window, for well past it.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
      ctrl.emit(toolEvent);
    }

    expect(ctrl.reconcileCalls).toHaveLength(0);
  });
});

describe("completion reconciliation — a terminal event that never arrived", () => {
  it("recovers the final response from the transcript and completes the job", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "the real answer" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });

    ctrl.emit(toolEvent);
    ctrl.emit(toolResultEvent);
    // ...and then the live stream goes silent, terminal event never delivered.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the real answer");
    expect(ctrl.reconcileCalls).toEqual([job.sessionKey]);
    expect(live.logs.some((l) => l.type === "recovery")).toBe(true);
  });

  it("settles to completed_no_summary when upstream is terminal with no visible text — after a bounded number of rounds", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);

    // One quiet round is not enough — a single stalled read shouldn't end a job.
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("running");
    expect(ctrl.reconcileCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).toBe("Stream finished with no response collected.");
    expect(ctrl.reconcileCalls).toHaveLength(2);
  });

  it("still ends the job when upstream can't be read at all — never indefinite running", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: () => Promise.reject(new Error("gateway disconnected")),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed_no_summary");
    expect(live.summary).toContain("could not be read");
  });

  it("leaves a genuinely active run alone — an advancing transcript means still running, indefinitely", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      // Quiet on the live stream, but upstream is visibly still writing.
      reconcile: async () => ({ ok: true, changed: true, trailingText: "" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long quiet thinking job" });
    ctrl.emit(toolEvent);

    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
      expect(sessions.getJob(job.jobId)?.status).toBe("running");
    }
    // Every round re-armed the watchdog rather than counting toward the cap.
    expect(ctrl.reconcileCalls).toHaveLength(4);
  });

  it("waits a full quiet window on a continued session that has produced no events yet", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "" }),
    });
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

describe("completion reconciliation — interaction with the abandoned live stream", () => {
  it("a late live final upgrades a job reconciled to completed_no_summary", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);

    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    await vi.advanceTimersByTimeAsync(PAST_QUIET_MS);
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");

    ctrl.finishChat("the answer, arriving very late");
    await vi.advanceTimersByTimeAsync(0);

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");
    expect(live.summary).toBe("the answer, arriving very late");
  });

  it("the abandoned live stream timing out does not overwrite a reconciled completion", async () => {
    vi.useFakeTimers();
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "the real answer" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);

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
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "the real answer" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);
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
      reconcile: async () => ({ ok: true, changed: false, trailingText: "" }),
      pollTranscriptForFinalText: async () => undefined,
    });
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "tool-heavy job" });
    ctrl.emit(toolEvent);
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
    const ctrl = fakeGateway({
      reconcile: async () => ({ ok: true, changed: false, trailingText: "the real answer" }),
    });
    const sessions = new SessionManager(ctrl.gateway);
    const sessionKey = "agent:main:main:thread:busy-release";
    const first = sessions.submitTask({ task: "first ask", sessionKey });
    ctrl.emit(toolEvent);

    // While it's running, a second submit on the same session is refused —
    // a colliding chat.send would abort the in-flight run.
    const blocked = sessions.submitTask({ task: "second ask", sessionKey });
    expect(blocked.status).toBe("error");
    expect(blocked.errorInfo?.message).toBe("session busy");

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
