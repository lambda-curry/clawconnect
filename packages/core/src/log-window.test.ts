import { describe, expect, it } from "vitest";
import { SessionManager } from "./session.ts";
import { INITIAL_WINDOW_MAX, DELTA_WINDOW_MAX } from "./log-projection.ts";
import type { OpenClawGateway } from "./gateway.ts";
import type { GatewayEvent } from "./types.ts";

/**
 * Unlike session-wait.test.ts's neverResolvingGateway (chat() never resolves,
 * no control over events), this fake exposes both hooks a poll/reconnect/
 * missed-poll/terminal test matrix needs: emit(event) to simulate live
 * activity landing between polls, and finish(text) to simulate the run
 * completing — both independent of when the test happens to call buildSnapshot.
 */
function controllableGateway() {
  let onEventCb: ((e: GatewayEvent) => void) | undefined;
  let resolveChat: ((v: string) => void) | undefined;
  const gateway = {
    chat(_sessionKey: string, _message: string, _timeoutMs: number, onEvent?: (e: GatewayEvent) => void) {
      onEventCb = onEvent;
      return new Promise<string>((resolve) => {
        resolveChat = resolve;
      });
    },
    close() {},
  } as unknown as OpenClawGateway;
  return {
    gateway,
    emit: (e: GatewayEvent) => onEventCb?.(e),
    emitMany: (n: number, make: (i: number) => GatewayEvent) => {
      for (let i = 0; i < n; i++) onEventCb?.(make(i));
    },
    finish: (text: string) => resolveChat?.(text),
  };
}

const lifecycleEvent = (i: number): GatewayEvent => ({ type: "lifecycle", text: `working on step ${i}` });

describe("check_task/get_task log window — long tasks stay bounded, cursor is stable across polls", () => {
  it("initial read (no cursor) on a long-running job returns at most INITIAL_WINDOW_MAX events, not the full history", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long task", sessionKey: "fixed-session" });
    ctrl.emitMany(50, lifecycleEvent);

    const live = sessions.getJob(job.jobId)!;
    const snapshot = sessions.buildSnapshot(live);
    expect(snapshot.logs.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    expect(snapshot.logEventCount).toBe(50);
    expect(snapshot.logCursor).toBe(50);
  });

  it("a normal next poll (cursor = prior logCursor) with a few new events returns exactly the new ones", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long task", sessionKey: "fixed-session" });
    ctrl.emitMany(10, lifecycleEvent);

    const first = sessions.buildSnapshot(sessions.getJob(job.jobId)!);
    ctrl.emitMany(3, (i) => lifecycleEvent(10 + i));
    const second = sessions.buildSnapshot(sessions.getJob(job.jobId)!, first.logCursor);

    expect(second.logs.length).toBe(3);
    expect(second.logs.every((e) => (e.seq ?? 0) > first.logCursor)).toBe(true);
    expect(second.logCursor).toBe(13);
  });

  it("a missed poll (many events land before the next check_task call) caps the delta but the cursor still advances to head — no duplicate replay on the following call", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long task", sessionKey: "fixed-session" });
    ctrl.emitMany(5, lifecycleEvent);
    const first = sessions.buildSnapshot(sessions.getJob(job.jobId)!);

    // A whole burst landed while the caller wasn't polling.
    ctrl.emitMany(30, (i) => lifecycleEvent(5 + i));
    const missed = sessions.buildSnapshot(sessions.getJob(job.jobId)!, first.logCursor);
    expect(missed.logs.length).toBeLessThanOrEqual(DELTA_WINDOW_MAX);
    expect(missed.logCursor).toBe(35);

    // Following call with the new cursor sees nothing already delivered — no duplicate history.
    const after = sessions.buildSnapshot(sessions.getJob(job.jobId)!, missed.logCursor);
    expect(after.logs).toEqual([]);

    // Across the whole sequence, no seq was ever returned twice.
    const seenSeqs = [...first.logs, ...missed.logs, ...after.logs].map((e) => e.seq);
    expect(new Set(seenSeqs).size).toBe(seenSeqs.length);
  });

  it("keeps recording past the old 200-entry cap — Job.logs is authoritative full history, never silently trimmed", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "very long task", sessionKey: "fixed-session" });
    ctrl.emitMany(350, lifecycleEvent);

    const live = sessions.getJob(job.jobId)!;
    expect(live.logs.length).toBe(350); // nothing dropped past 200
    expect(live.logs.at(-1)?.seq).toBe(350); // seq stays monotonic well past the old cap

    // The response stays bounded regardless — only the storage is uncapped.
    const initial = sessions.buildSnapshot(live);
    expect(initial.logs.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    expect(initial.logEventCount).toBe(350);
    expect(initial.logCursor).toBe(350);

    // Cursor keeps advancing past 200 too — a client that polled the whole way
    // through still resumes correctly, no stall at the old cap.
    ctrl.emitMany(20, (i) => lifecycleEvent(350 + i));
    const next = sessions.buildSnapshot(sessions.getJob(job.jobId)!, initial.logCursor);
    expect(next.logCursor).toBe(370);
    expect(next.logEventCount).toBe(370);
    expect(next.logs.length).toBeLessThanOrEqual(DELTA_WINDOW_MAX);
  });

  it("reconnect/remount (client cursor lost, passes undefined again) gets the bounded recent window, not the full accumulated history", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long task", sessionKey: "fixed-session" });
    ctrl.emitMany(80, lifecycleEvent);
    sessions.buildSnapshot(sessions.getJob(job.jobId)!); // an earlier poll had advanced state server-side

    const reconnect = sessions.buildSnapshot(sessions.getJob(job.jobId)!, undefined);
    expect(reconnect.logs.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    expect(reconnect.logEventCount).toBe(80);
  });

  it("terminal transition includes the full summary/artifacts regardless of what cursor is passed", async () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "long task", sessionKey: "fixed-session" });
    ctrl.emitMany(20, lifecycleEvent);
    ctrl.finish("the complete final answer, in full");
    await new Promise((r) => setTimeout(r, 20));

    const live = sessions.getJob(job.jobId)!;
    expect(live.status).toBe("completed");

    // A stale/zero cursor from before the run finished must not truncate the
    // terminal content — summary/artifacts never ride the log-window cursor.
    const withStaleCursor = sessions.buildSnapshot(live, 0);
    const withCurrentCursor = sessions.buildSnapshot(live, live.logs.at(-1)?.seq);
    expect(withStaleCursor.summary).toBe("the complete final answer, in full");
    expect(withCurrentCursor.summary).toBe("the complete final answer, in full");
  });

  it("does not include the original prompt or the full log history in a running snapshot at any cursor value", () => {
    const ctrl = controllableGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "a secret task description", sessionKey: "fixed-session-2" });
    ctrl.emitMany(60, lifecycleEvent);

    for (const cursor of [undefined, 0, 10, 59]) {
      const snapshot = sessions.buildSnapshot(sessions.getJob(job.jobId)!, cursor);
      expect(JSON.stringify(snapshot)).not.toContain("a secret task description");
      expect(snapshot.logs.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    }
  });
});
