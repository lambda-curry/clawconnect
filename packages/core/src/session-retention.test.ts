import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonFileAttachmentStore } from "./attachment-store.ts";
import { GatewayPool } from "./gateway-pool.ts";
import type { OpenClawGateway } from "./gateway.ts";
import { SessionManager } from "./session.ts";
import type { SessionAttachmentState } from "./types.ts";

const managers: SessionManager[] = [];
const directories: string[] = [];
const pools: GatewayPool[] = [];

function manager(attachmentStore?: JsonFileAttachmentStore) {
  const replies: ((value: string) => void)[] = [];
  const gateway = {
    chat: vi.fn(() => new Promise<string>((resolve) => replies.push(resolve))),
    abort: vi.fn(async () => ({ aborted: true })),
    stopTranscriptWatch: vi.fn(),
  } as unknown as OpenClawGateway;
  const sessions = new SessionManager(gateway, "main", undefined, attachmentStore);
  managers.push(sessions);
  return { sessions, replies };
}

async function finish(reply: (value: string) => void) {
  reply("done");
  await Promise.resolve();
}

function attachmentState(
  key: string,
  at: number,
  status: "completed" | "detached" = "completed",
): SessionAttachmentState {
  return {
    sessionKey: key,
    currentAttachmentId: status === "detached" ? undefined : key,
    attachments: {
      [key]: { id: key, runtime: "example", handle: key, attachedAt: at, status },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});

afterEach(() => {
  for (const sessions of managers.splice(0)) sessions.close();
  for (const pool of pools.splice(0)) pool.closeAll();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("finished job retention", () => {
  it("evicts oldest finished jobs and every session index while preserving active turns", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "2");
    const { sessions, replies } = manager();
    const first = sessions.submitTask({ task: "one" });
    await finish(replies[0]);
    const second = sessions.submitTask({ task: "two", sessionKey: first.sessionKey });
    await finish(replies[1]);
    const active = sessions.submitTask({ task: "active" });
    sessions.submitTask({ task: "three" });
    await finish(replies[3]);
    expect(sessions.getJob(first.jobId)).toBeUndefined();
    expect(sessions.getJobHistory(first.sessionKey).map((job) => job.jobId)).toEqual([
      second.jobId,
    ]);
    sessions.submitTask({ task: "four" });
    await finish(replies[4]);
    expect(sessions.getSessionState(first.sessionKey)).toBeUndefined();
    expect(sessions.getJobHistory(first.sessionKey)).toEqual([]);
    expect(sessions.getLatestJobForSession(first.sessionKey)).toBeUndefined();
    expect(sessions.getJob(active.jobId)?.status).toBe("running");
    expect(sessions.retentionStats()).toMatchObject({
      jobs: 3,
      finishedJobs: 2,
      historyEntries: 3,
      historySessions: 3,
      latestJobIndex: 3,
      sessionStates: 3,
      provisionalOutcomes: 0,
    });
  });

  it("starts age retention at completion and sweeps idle sessions without traffic", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_AGE_MS", "1000");
    const { sessions, replies } = manager();
    const job = sessions.submitTask({ task: "long run" });
    vi.setSystemTime(Date.now() + 10_000);
    expect(sessions.getJob(job.jobId)).toBe(job);
    await finish(replies[0]);
    vi.setSystemTime(Date.now() + 999);
    expect(sessions.getJob(job.jobId)).toBe(job);
    await vi.advanceTimersByTimeAsync(60_000);
    // Observe the callback itself, before a read can trigger lazy eviction.
    expect((sessions as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0);
    expect(sessions.retentionStats()).toMatchObject({
      jobs: 0,
      sessionStates: 0,
      historyEntries: 0,
      latestJobIndex: 0,
    });
  });

  it("bounds busy rejections without changing the real session history", () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "2");
    const { sessions } = manager();
    const job = sessions.submitTask({ task: "active" });
    const rejected = Array.from({ length: 10 }, () =>
      sessions.submitTask({ task: "collision", sessionKey: job.sessionKey }),
    );
    expect(sessions.getJob(rejected[0].jobId)).toBeUndefined();
    expect(sessions.getLatestJobForSession(job.sessionKey)).toBe(job);
    expect(sessions.getJobHistory(job.sessionKey)).toEqual([job]);
    expect(sessions.retentionStats()).toMatchObject({
      jobs: 3,
      finishedJobs: 2,
      historyEntries: 1,
    });
  });

  it("does not recreate evicted indexes when an abandoned live stream settles late", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "1");
    const { sessions, replies } = manager();
    const old = sessions.submitTask({ task: "cancel me" });
    await sessions.requestCancel(old.jobId);
    const current = sessions.submitTask({ task: "replacement", sessionKey: old.sessionKey });
    await finish(replies[1]);
    expect(sessions.getJob(old.jobId)).toBeUndefined();
    const before = sessions.retentionStats();
    await finish(replies[0]);
    expect(sessions.retentionStats()).toEqual(before);
    expect(sessions.getLatestJobForSession(old.sessionKey)).toBe(current);
    expect(sessions.getJobHistory(old.sessionKey)).toEqual([current]);
  });

  it("removes routing entries on eviction and exposes the retained counts", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "1");
    const pool = new GatewayPool({
      default: "example",
      agents: [{ id: "example", openclawAgentId: "main", url: "ws://localhost", password: "" }],
      groups: {},
      groupLabels: {},
      source: "env",
    });
    pools.push(pool);
    const entry = pool.forAgent();
    vi.spyOn(entry.gateway, "chat").mockResolvedValue("done");
    const first = entry.sessions.submitTask({ task: "one" });
    pool.rememberJob(first.jobId, entry.agent.id);
    await Promise.resolve();
    const second = entry.sessions.submitTask({ task: "two" });
    pool.rememberJob(second.jobId, entry.agent.id);
    await Promise.resolve();
    expect(pool.forJob(first.jobId)).toBeUndefined();
    expect(pool.forJob(second.jobId)).toBe(entry);
    expect(pool.retentionStats()).toMatchObject({ jobs: 1, jobRoutingIndex: 1, historyEntries: 1 });
  });

  it("falls back to bounded defaults for invalid environment settings", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "0");
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_AGE_MS", "NaN");
    const { sessions, replies } = manager();
    const job = sessions.submitTask({ task: "one" });
    await finish(replies[0]);
    expect(sessions.getJob(job.jobId)).toBe(job);
    vi.setSystemTime(Date.now() + 86_400_000);
    expect(sessions.getJob(job.jobId)).toBeUndefined();
  });
});

describe("durable attachment retention", () => {
  function store() {
    const directory = mkdtempSync(join(tmpdir(), "clawconnect-retention-"));
    directories.push(directory);
    return new JsonFileAttachmentStore(join(directory, "attachments.json"));
  }

  it("prunes expired current and detached records on load and persists the bounded set across restart", () => {
    vi.stubEnv("CLAWCONNECT_ATTACHMENT_MAX_AGE_MS", "1000");
    const disk = store();
    disk.save([
      attachmentState("expired-current", Date.now() - 1000),
      attachmentState("expired-detached", Date.now() - 1000, "detached"),
      attachmentState("recent", Date.now()),
    ]);
    const first = manager(disk).sessions;
    expect(first.getAgentSessionAttachment("expired-current")).toBeUndefined();
    expect(disk.load().map((state) => state.sessionKey)).toEqual(["recent"]);
    const restarted = manager(disk).sessions;
    expect(restarted.retentionStats()).toMatchObject({ attachments: 1, attachmentSessions: 1 });
    expect(restarted.getAgentSessionAttachment("recent")?.handle).toBe("recent");
  });

  it("caps records globally across sessions and within one replacement lineage", async () => {
    vi.stubEnv("CLAWCONNECT_ATTACHMENT_MAX_COUNT", "2");
    const disk = store();
    disk.save([attachmentState("old", Date.now() - 2), attachmentState("newer", Date.now() - 1)]);
    const { sessions, replies } = manager(disk);
    const context = (handle: string) =>
      `[[clawconnect:agent-session]]${JSON.stringify({ op: "replace", runtime: "example", host: "example", handle, reason: "new work" })}[[/clawconnect:agent-session]]`;
    const job = sessions.submitTask({ task: "attach", context: context("first") });
    await finish(replies[0]);
    sessions.submitTask({
      task: "replace",
      sessionKey: job.sessionKey,
      context: context("second"),
    });
    await finish(replies[1]);
    const third = sessions.submitTask({
      task: "replace",
      sessionKey: job.sessionKey,
      context: context("third"),
    });
    expect(sessions.getAgentSessionAttachment(third.sessionKey)?.handle).toBe("third");
    expect(sessions.getAgentSessionLineage(job.sessionKey).map((record) => record.handle)).toEqual([
      "second",
      "third",
    ]);
    expect(disk.load().flatMap((state) => Object.values(state.attachments))).toHaveLength(2);
    expect(sessions.retentionStats()).toMatchObject({ attachments: 2, attachmentSessions: 1 });
  });

  it("keeps attachments required by running jobs until those jobs finish", async () => {
    vi.stubEnv("CLAWCONNECT_ATTACHMENT_MAX_AGE_MS", "1000");
    const { sessions, replies } = manager();
    const context = `[[clawconnect:agent-session]]${JSON.stringify({ op: "attach", runtime: "example", host: "example", handle: "active" })}[[/clawconnect:agent-session]]`;
    const job = sessions.submitTask({ task: "active", context });
    vi.setSystemTime(Date.now() + 2000);
    expect(sessions.retentionStats().attachments).toBe(1);
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.handle).toBe("active");
    await finish(replies[0]);
    expect(sessions.retentionStats().attachments).toBe(0);
  });
});
