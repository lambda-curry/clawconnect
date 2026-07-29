import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "./session.ts";
import type { OpenClawGateway } from "./gateway.ts";
import type { JobStore, PersistedJob } from "./job-store.ts";

/**
 * Restart-recovery contract: an in-flight job survives a process restart by
 * reloading a small pointer (jobId/sessionKey/prompt, no logs) and
 * reattaching via the same transcript-recovery path an empty live
 * chat.final already uses (recoverLateFinalText) — see job-store.ts and
 * SessionManager.rehydrateFromStore/persistActiveJobs.
 */

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

function fakeGateway(opts: {
  chat?: (sessionKey: string, message: string, timeoutMs: number) => Promise<string>;
  pollTranscriptForFinalText?: () => Promise<string | undefined>;
}): OpenClawGateway {
  return {
    chat: opts.chat ?? (() => new Promise<string>(() => {})),
    pollTranscriptForFinalText: opts.pollTranscriptForFinalText ?? (async () => undefined),
  } as unknown as OpenClawGateway;
}

const persistedRunning: PersistedJob = {
  jobId: "old-job-1",
  sessionKey: "agent:main:main:thread:old-session",
  startedAt: 1_000,
  lastEventAt: 2_000,
  pollCount: 4,
  prompt: { task: "keep going", context: undefined, senderName: "jake" },
};

describe("SessionManager restart persistence", () => {
  it("with no store configured, behaves exactly as before — no crash, nothing persisted", async () => {
    const sessions = new SessionManager(fakeGateway({ chat: async () => "done" }));
    const job = sessions.submitTask({ task: "do the thing" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sessions.resolveJob(job.jobId)?.status).toBe("completed");
  });

  it("submitTask persists the new job as part of the active set immediately", () => {
    const store = new FakeJobStore();
    const sessions = new SessionManager(fakeGateway({}), "main", store);
    const job = sessions.submitTask({ task: "long task", context: "ctx", senderName: "jake" });

    expect(store.latestSave).toHaveLength(1);
    expect(store.latestSave?.[0]).toMatchObject({
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      pollCount: 0,
      prompt: { task: "long task", context: "ctx", senderName: "jake" },
    });
  });

  it("a job that resolves to completed is no longer in the next persisted snapshot", async () => {
    const store = new FakeJobStore();
    const sessions = new SessionManager(fakeGateway({ chat: async () => "the real answer" }), "main", store);
    const job = sessions.submitTask({ task: "quick thing" });
    expect(store.latestSave?.map((j) => j.jobId)).toContain(job.jobId);

    await new Promise((r) => setTimeout(r, 10));

    expect(sessions.resolveJob(job.jobId)?.status).toBe("completed");
    expect(store.latestSave?.map((j) => j.jobId)).not.toContain(job.jobId);
  });

  it("a job that errors is no longer in the next persisted snapshot", async () => {
    const store = new FakeJobStore();
    const sessions = new SessionManager(
      fakeGateway({ chat: async () => Promise.reject(new Error("boom")) }),
      "main",
      store,
    );
    const job = sessions.submitTask({ task: "will fail" });
    await new Promise((r) => setTimeout(r, 10));

    expect(sessions.resolveJob(job.jobId)?.status).toBe("error");
    expect(store.latestSave?.map((j) => j.jobId)).not.toContain(job.jobId);
  });

  it("reloads a persisted running job at construction time — resolvable and status=running before any recovery resolves", () => {
    const store = new FakeJobStore([persistedRunning]);
    const sessions = new SessionManager(fakeGateway({}), "main", store);

    const job = sessions.resolveJob(persistedRunning.jobId);
    expect(job).toBeDefined();
    expect(job?.status).toBe("running");
    expect(job?.sessionKey).toBe(persistedRunning.sessionKey);
    expect(job?.pollCount).toBe(persistedRunning.pollCount);
    // Logs are never persisted — reload starts empty except for the marker
    // recoverLateFinalText itself pushes when it starts watching (same as a
    // live "no summary" recovery, not something reload adds on top).
    expect(job?.logs).toHaveLength(1);
    expect(job?.logs[0].type).toBe("recovery");

    const snapshot = sessions.buildSnapshot(job!);
    expect(snapshot.continuePolling).toBe(true);
    expect(snapshot.nextAction).toEqual({
      tool: "check_task",
      args: { taskId: persistedRunning.jobId, sessionKey: persistedRunning.sessionKey },
    });
  });

  it("reattaches a reloaded job via transcript recovery, using the persisted sessionKey", () => {
    const pollSpy = vi.fn(async () => undefined);
    const store = new FakeJobStore([persistedRunning]);
    new SessionManager(fakeGateway({ pollTranscriptForFinalText: pollSpy }), "main", store);

    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it("when reattached recovery finds the final answer, the reloaded job completes and drops out of the persisted set", async () => {
    const store = new FakeJobStore([persistedRunning]);
    const sessions = new SessionManager(
      fakeGateway({ pollTranscriptForFinalText: async () => "recovered final answer" }),
      "main",
      store,
    );

    // recoverLateFinalText's promise chain settles on a microtask/macrotask
    // after construction — this doesn't touch the module's real setTimeout
    // scheduling (that's inside the mocked pollTranscriptForFinalText call,
    // not exercised here), so a short real wait is enough.
    await new Promise((r) => setTimeout(r, 10));

    const job = sessions.resolveJob(persistedRunning.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.summary).toBe("recovered final answer");
    expect(store.latestSave?.map((j) => j.jobId)).not.toContain(persistedRunning.jobId);
  });

  it("when reattached recovery finds nothing, the reloaded job settles to completed_no_summary rather than hanging forever", async () => {
    const store = new FakeJobStore([persistedRunning]);
    const sessions = new SessionManager(
      fakeGateway({ pollTranscriptForFinalText: async () => undefined }),
      "main",
      store,
    );

    await new Promise((r) => setTimeout(r, 10));

    const job = sessions.resolveJob(persistedRunning.jobId);
    expect(job?.status).toBe("completed_no_summary");
    expect(store.latestSave?.map((j) => j.jobId)).not.toContain(persistedRunning.jobId);
  });

  it("a reloaded job is discoverable via getLatestJobForSession and getJobHistory, same as a freshly-submitted one", () => {
    const store = new FakeJobStore([persistedRunning]);
    const sessions = new SessionManager(fakeGateway({}), "main", store);

    expect(sessions.getLatestJobForSession(persistedRunning.sessionKey)?.jobId).toBe(persistedRunning.jobId);
    expect(sessions.getJobHistory(persistedRunning.sessionKey).map((j) => j.jobId)).toEqual([persistedRunning.jobId]);
  });
});
