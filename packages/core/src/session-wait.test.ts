import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session.ts";
import type { OpenClawGateway } from "./gateway.ts";

/**
 * Fake gateway whose chat() never resolves on its own — lets tests control
 * job completion (or non-completion) explicitly instead of racing a real
 * WebSocket. Matches the wait/get_task fake-clock test matrix in
 * docs/architecture/2026-07-27-multi-client-compatibility.md §7.
 */
function fakeGateway(chatImpl: (sessionKey: string, message: string, timeoutMs: number) => Promise<string>) {
  return { chat: chatImpl, close: () => {} } as unknown as OpenClawGateway;
}

function neverResolvingGateway() {
  return fakeGateway(() => new Promise<string>(() => {}));
}

describe("SessionManager.waitForJob — check_task wait semantics", () => {
  it("defaults to a 45s wait window when waitMs is omitted", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionManager(neverResolvingGateway());
      const job = sessions.submitTask({ task: "do the thing" });

      const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait");
      await vi.advanceTimersByTimeAsync(44_999);
      // Still running just before the deadline — the promise must not have settled.
      let settled = false;
      waitPromise.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an explicit waitMs override, shorter than the default", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionManager(neverResolvingGateway());
      const job = sessions.submitTask({ task: "do the thing" });

      const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait", 3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await waitPromise;
      expect(result?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps an invalid (negative/NaN/huge) waitMs instead of erroring", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionManager(neverResolvingGateway());

      // Negative clamps up to the 1s floor.
      const jobA = sessions.submitTask({ task: "a" });
      const waitA = sessions.waitForJob(jobA.jobId, 0, undefined, "wait", -50);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await waitA)?.status).toBe("running");

      // NaN falls back to the 45s default, not an error.
      const jobB = sessions.submitTask({ task: "b" });
      const waitB = sessions.waitForJob(jobB.jobId, 0, undefined, "wait", Number.NaN);
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await waitB)?.status).toBe("running");

      // A huge request clamps down to the 120s ceiling, not held open forever.
      const jobC = sessions.submitTask({ task: "c" });
      const waitC = sessions.waitForJob(jobC.jobId, 0, undefined, "wait", 999_999_999);
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await waitC)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately on a terminal status, regardless of waitMs", async () => {
    const sessions = new SessionManager(fakeGateway(async () => "the answer"));
    const job = sessions.submitTask({ task: "do the thing" });

    // Real timers: chat() above resolves on a normal microtask/macrotask,
    // no fake-clock advancing needed — proves this doesn't wait for the window.
    await new Promise((r) => setTimeout(r, 20));
    const result = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 45_000);
    expect(result?.status).toBe("completed");
  });

  it("a timeout is non-terminal: continuePolling stays true and no duplicate job is created on re-poll", async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionManager(neverResolvingGateway());
      const job = sessions.submitTask({ task: "do the thing" });

      const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait", 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await waitPromise;
      expect(result?.status).toBe("running");

      const snapshot = sessions.buildSnapshot(result!);
      expect(snapshot.continuePolling).toBe(true);
      expect(snapshot.nextAction).toEqual({ tool: "check_task", args: { taskId: job.jobId, sessionKey: job.sessionKey } });

      // Re-polling the same job is safe and does not spawn a second job —
      // submitting a new task on the same (still-running) session is refused.
      const resubmit = sessions.submitTask({ task: "do the thing again", sessionKey: job.sessionKey });
      expect(resubmit.jobId).not.toBe(job.jobId);
      expect(resubmit.status).toBe("error");
      expect(resubmit.errorInfo?.message).toBe("session busy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("increments pollCount on every waitForJob call", async () => {
    const sessions = new SessionManager(fakeGateway(async () => "done"));
    const job = sessions.submitTask({ task: "do the thing" });
    await new Promise((r) => setTimeout(r, 20));

    // waitForJob mutates and returns the same underlying Job record, so the
    // pollCount snapshot must be captured immediately after each call —
    // reading `first.pollCount` after the second call would see the later
    // mutation via the shared reference.
    const first = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    const firstPollCount = first?.pollCount;
    const second = await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1_000);
    expect(firstPollCount).toBe(1);
    expect(second?.pollCount).toBe(2);
  });
});

describe("get_task-equivalent immediate reads never wait", () => {
  it("resolveJob + buildSnapshot (the getTask code path) returns instantly for a running job, no waiting", async () => {
    const sessions = new SessionManager(neverResolvingGateway());
    const job = sessions.submitTask({ task: "do the thing" });

    const start = performance.now();
    const resolved = sessions.resolveJob(job.jobId);
    const snapshot = sessions.buildSnapshot(resolved!);
    const elapsedMs = performance.now() - start;

    expect(snapshot.status).toBe("running");
    expect(elapsedMs).toBeLessThan(50);
    // Unlike waitForJob, a plain resolveJob() call must not bump pollCount —
    // get_task is a read, not a poll.
    expect(resolved?.pollCount).toBe(0);
  });
});

describe("prompt storage", () => {
  it("stores the original task/context/senderName on the job, retrievable but not part of the snapshot", async () => {
    const sessions = new SessionManager(neverResolvingGateway());
    const job = sessions.submitTask({ task: "investigate the bug", context: "seen in prod", senderName: "Jake" });

    expect(job.prompt).toEqual({ task: "investigate the bug", context: "seen in prod", senderName: "Jake" });

    const snapshot = sessions.buildSnapshot(job);
    expect(snapshot).not.toHaveProperty("prompt");
  });
});
