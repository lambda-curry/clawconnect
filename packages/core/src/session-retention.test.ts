import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonFileAttachmentStore } from "./attachment-store.ts";
import { GatewayPool } from "./gateway-pool.ts";
import { buildCapabilities } from "./capability.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { OpenClawGateway } from "./gateway.ts";
import { SessionManager } from "./session.ts";
import type { GatewayEvent, SessionAttachmentState, TranscriptTransportUpdate } from "./types.ts";

const managers: SessionManager[] = [];
const directories: string[] = [];
const pools: GatewayPool[] = [];

function manager(attachmentStore?: JsonFileAttachmentStore) {
  const replies: ((value: string) => void)[] = [];
  const emitters: (((event: GatewayEvent) => void) | undefined)[] = [];
  const updates: (((update: TranscriptTransportUpdate) => void) | undefined)[] = [];
  const gateway = {
    chat: vi.fn(
      (
        _key: string,
        _message: string,
        _timeout: number,
        onEvent?: (event: GatewayEvent) => void,
        _runId?: unknown,
        onState?: (update: TranscriptTransportUpdate) => void,
      ) => {
        emitters.push(onEvent);
        updates.push(onState);
        return new Promise<string>((resolve) => replies.push(resolve));
      },
    ),
    abort: vi.fn(async () => ({ aborted: true })),
    stopTranscriptWatch: vi.fn(),
  } as unknown as OpenClawGateway;
  const sessions = new SessionManager(gateway, "main", undefined, attachmentStore);
  managers.push(sessions);
  return { sessions, replies, emitters, updates };
}

async function finish(reply: (value: string) => void) {
  reply("done");
  await Promise.resolve();
}

function attachmentState(
  key: string,
  at: number,
  status: "completed" | "detached" | "superseded" = "completed",
): SessionAttachmentState {
  return {
    sessionKey: key,
    currentAttachmentId: status === "completed" ? key : undefined,
    attachments: {
      [key]: {
        id: key,
        runtime: "example",
        handle: key,
        attachedAt: at,
        retentionUpdatedAt: at,
        status,
      },
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
  it("bounds live and finished logs while polling cursors continue across truncation", async () => {
    vi.stubEnv("CLAWCONNECT_RUNNING_LOG_MAX_ENTRIES", "8");
    vi.stubEnv("CLAWCONNECT_RUNNING_LOG_MAX_BYTES", "1024");
    vi.stubEnv("CLAWCONNECT_FINISHED_LOG_MAX_ENTRIES", "3");
    vi.stubEnv("CLAWCONNECT_FINISHED_LOG_MAX_BYTES", "512");
    const { sessions, replies, emitters } = manager();
    const job = sessions.submitTask({ task: "many events", sessionKey: "log-budget-session" });
    for (let i = 1; i <= 100; i++)
      emitters[0]?.({ type: "lifecycle", text: `${i}: ${"😀".repeat(50)}` });
    expect(job.logs.length).toBeLessThanOrEqual(8);
    expect(job.logBytes).toBeLessThanOrEqual(1024);
    const snapshot = sessions.buildSnapshot(job);
    expect(snapshot.logs[0].type).toBe("truncation");
    expect(snapshot.logCursor).toBe(100);
    expect(snapshot.logEventCount).toBe(100);
    const waiting = sessions.waitForJob(job.jobId, snapshot.logCursor, undefined, "poll", 10_000);
    emitters[0]?.({ type: "lifecycle", text: "new state" });
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toBe(job);
    expect(sessions.buildSnapshot(job, snapshot.logCursor).logs.map((entry) => entry.seq)).toEqual([
      101,
    ]);
    await finish(replies[0]);
    expect(job.logs.length).toBeLessThanOrEqual(3);
    expect(job.logBytes).toBeLessThanOrEqual(512);
    expect(job.logs[0].type).toBe("truncation");
    expect(sessions.buildSnapshot(job).logCursor).toBe(101);
    expect(job.summary).toBe("done");
  });

  it("distinguishes transcript limits from transport failure in job logs", () => {
    const { sessions, updates } = manager();
    const job = sessions.submitTask({ task: "watch me" });
    updates[0]?.({
      upstream: "connected",
      transcript: "detached",
      reason: "limit_exceeded",
      skippedEvents: 2,
    });
    expect(job.logs.at(-1)?.text).toContain("Transcript memory limit reached");
    expect(job.logs.at(-1)?.text).toContain("2 known live records");
    updates[0]?.({
      upstream: "connected",
      transcript: "live",
      reason: "limit_recovered",
      skippedEvents: 2,
      skippedSequenceCount: 10,
      lastSeenSequence: 10,
    });
    expect(job.logs.at(-1)?.text).toContain("skipped 10 sequence positions");
    expect(job.lastSeenSequence).toBe(10);
    expect(job.status).toBe("running");
  });

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

  it("100 busy retries do not evict a completed unread job or its continuation", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "2");
    const { sessions, replies } = manager();
    const unread = sessions.submitTask({ task: "keep this result" });
    await finish(replies[0]);
    const job = sessions.submitTask({ task: "active" });
    const rejected = Array.from({ length: 100 }, () =>
      sessions.submitTask({ task: "collision", sessionKey: job.sessionKey }),
    );
    expect(sessions.getJob(rejected[0].jobId)).toBeUndefined();
    expect(sessions.getLatestJobForSession(job.sessionKey)).toBe(job);
    expect(sessions.getJobHistory(job.sessionKey)).toEqual([job]);
    expect(sessions.getJob(unread.jobId)?.summary).toBe("done");
    expect(sessions.getSessionState(unread.sessionKey)?.lastJobId).toBe(unread.jobId);
    expect(rejected.every((entry) => entry.errorInfo?.message === "session busy")).toBe(true);
    expect(sessions.retentionStats()).toMatchObject({
      jobs: 2,
      finishedJobs: 1,
      historyEntries: 2,
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

  it("evicts personal routing keys without changing other principals' indexes", async () => {
    vi.stubEnv("CLAWCONNECT_FINISHED_JOB_MAX_COUNT", "1");
    const pool = new GatewayPool({
      default: "example",
      agents: [{ id: "example", openclawAgentId: "main", url: "ws://localhost", password: "" }],
      groups: {},
      groupLabels: {},
      source: "env",
    });
    pools.push(pool);
    const views = [
      pool.forPrincipal(),
      pool.forPrincipal({ principalId: "p-alice", loginEmail: "alice@example.test" }),
      pool.forPrincipal({ principalId: "p-bob", loginEmail: "bob@example.test" }),
    ];
    const initial = views.map((view) => {
      const entry = view.forAgent();
      vi.spyOn(entry.gateway, "chat").mockResolvedValue("done");
      const job = entry.sessions.submitTask({ task: "first" });
      view.rememberJob(job.jobId, entry.agent.id);
      return job;
    });
    await Promise.resolve();
    const personal = views[1].forAgent();
    const next = personal.sessions.submitTask({ task: "next" });
    views[1].rememberJob(next.jobId, personal.agent.id);
    await Promise.resolve();
    personal.sessions.sweepRetention();
    // Check the actual index before a lookup can defensively remove stale keys.
    const index = (pool as unknown as { jobIndex: Map<string, string> }).jobIndex;
    expect(index.size).toBe(3);
    views[1].rememberJob(initial[1].jobId, personal.agent.id);
    expect(index.size).toBe(3);
    expect(views[1].forJob(initial[1].jobId)).toBeUndefined();
    expect(views[1].forJob(next.jobId)).toBe(personal);
    expect(views[0].forJob(initial[0].jobId)).toBeDefined();
    expect(views[2].forJob(initial[2].jobId)).toBeDefined();
    expect(views[2].forJob(next.jobId)).toBeUndefined();
    expect(pool.retentionStats()).toMatchObject({ jobs: 3, finishedJobs: 3, jobRoutingIndex: 3 });
    for (const view of views)
      expect(view.retentionStats()).toMatchObject({ jobs: 1, jobRoutingIndex: 1 });
  });

  it("scopes connection counters while aggregate health reads do not keep personal sockets alive", async () => {
    const registry: AgentRegistry = {
      default: "example",
      agents: [{ id: "example", openclawAgentId: "main", url: "ws://localhost", password: "" }],
      groups: {},
      groupLabels: {},
      source: "env",
    };
    const pool = new GatewayPool(registry, undefined, undefined, undefined, {
      principalIdleTimeoutMs: 1000,
    });
    pools.push(pool);
    const principal = { principalId: "p-alice", loginEmail: "alice@example.test" };
    const service = pool.forAgent();
    const personal = pool.forPrincipal(principal).forAgent();
    for (const entry of [service, personal]) {
      vi.spyOn(entry.gateway, "chat").mockResolvedValue("done");
      const job = entry.sessions.submitTask({ task: "done" });
      pool.rememberJob(job.jobId, entry.agent.id, entry.principal);
    }
    await Promise.resolve();
    const info = buildCapabilities({
      pool,
      registry,
      identity: { user: "Alice", principal },
      scope: { allowedIds: ["example"], defaultId: "example", serverName: "ClawConnect" },
      defaultCheckMode: "poll",
      protocol: () => ({ era: "modern" }),
    }).find((tool) => tool.name === "get_connection_info")!;
    expect((await info.handler({})).structuredContent).toMatchObject({
      retained: { jobs: 1, jobRoutingIndex: 1 },
    });
    const personalClose = vi.spyOn(personal.gateway, "close");
    const serviceClose = vi.spyOn(service.gateway, "close");
    await vi.advanceTimersByTimeAsync(500);
    expect(pool.retentionStats()).toMatchObject({ jobs: 2, jobRoutingIndex: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(personalClose).toHaveBeenCalledTimes(1);
    expect(serviceClose).not.toHaveBeenCalled();
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

  it("starts legacy age at first load, preserves original bytes, and does not reset age on restart", () => {
    vi.stubEnv("CLAWCONNECT_ATTACHMENT_MAX_AGE_MS", "1000");
    const directory = mkdtempSync(join(tmpdir(), "clawconnect-retention-"));
    directories.push(directory);
    const file = join(directory, "attachments.json");
    const legacy = attachmentState("legacy-current", 1);
    delete legacy.attachments["legacy-current"].retentionUpdatedAt;
    const original = JSON.stringify([legacy], null, 2);
    writeFileSync(file, original);
    const loadedAt = Date.now();
    const disk = new JsonFileAttachmentStore(file);
    const first = manager(disk).sessions;
    expect(first.getAgentSessionAttachment("legacy-current")).toMatchObject({
      attachedAt: 1,
      retentionUpdatedAt: loadedAt,
    });
    expect(readFileSync(`${file}.pre-retention`, "utf8")).toBe(original);
    vi.setSystemTime(loadedAt + 999);
    const restarted = manager(new JsonFileAttachmentStore(file)).sessions;
    expect(restarted.getAgentSessionAttachment("legacy-current")?.retentionUpdatedAt).toBe(
      loadedAt,
    );
    vi.setSystemTime(loadedAt + 1000);
    expect(restarted.retentionStats().attachments).toBe(0);
    expect(disk.load()).toEqual([]);
    expect(readFileSync(`${file}.pre-retention`, "utf8")).toBe(original);
  });

  it("evicts newer superseded and detached records before an idle current pointer", () => {
    vi.stubEnv("CLAWCONNECT_ATTACHMENT_MAX_COUNT", "1");
    const disk = store();
    disk.save([
      attachmentState("old-current", Date.now() - 100),
      attachmentState("recent-superseded", Date.now() - 2, "superseded"),
      attachmentState("recent-detached", Date.now() - 1, "detached"),
    ]);
    const sessions = manager(disk).sessions;
    expect(sessions.getAgentSessionAttachment("old-current")?.handle).toBe("old-current");
    expect(sessions.retentionStats().attachments).toBe(1);
    expect(disk.load().map((state) => state.sessionKey)).toEqual(["old-current"]);
  });

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
      "third",
    ]);
    expect(disk.load().flatMap((state) => Object.values(state.attachments))).toHaveLength(2);
    expect(sessions.getAgentSessionAttachment("newer")?.handle).toBe("newer");
    expect(sessions.retentionStats()).toMatchObject({ attachments: 2, attachmentSessions: 2 });
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
