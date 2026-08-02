import { describe, expect, it, vi } from "vitest";
import { GatewayPool } from "./gateway-pool.ts";
import {
  runTask,
  checkTask,
  getTask,
  getTaskPrompt,
  getSession,
  listTasks,
  listSessions,
  TASK_SUMMARY_PREVIEW_MAX,
} from "./tools.ts";
import type { AgentRegistry } from "./agent-registry.ts";

/**
 * Mocks OpenClawGateway at the constructor level so GatewayPool's real
 * multi-agent routing (forJob/forSession/allEntries) runs unmodified while
 * chat() never touches a real WebSocket. chat() fires a few synthetic
 * events synchronously (so get_session pagination has something to
 * paginate over) and then never resolves — every job in this file stays
 * "running", which is exactly the state these fixtures need to exercise
 * concurrent taskId/sessionKey resolution.
 */
vi.mock("./gateway.ts", () => {
  // A regular function, not an arrow function — arrow functions have no
  // [[Construct]] internal method, so `new OpenClawGateway(...)` (as
  // GatewayPool does) would throw "is not a constructor" otherwise.
  function FakeOpenClawGateway() {
    return {
      chat(
        _sessionKey: string,
        _message: string,
        _timeoutMs: number,
        onEvent?: (e: { type: string; text: string; toolName?: string; args?: Record<string, unknown>; isError?: boolean }) => void,
      ) {
        onEvent?.({ type: "tool", text: "ran a command", toolName: "Bash", args: { command: "echo hi" } });
        onEvent?.({ type: "tool-result", text: "hi", toolName: "Bash", isError: false });
        onEvent?.({ type: "lifecycle", text: "Agent lifecycle: end" });
        return new Promise<string>(() => {});
      },
      close() {},
      pollTranscriptForFinalText: () => Promise.resolve(undefined),
    };
  }
  return { OpenClawGateway: FakeOpenClawGateway };
});

function multiAgentRegistry(): AgentRegistry {
  return {
    default: "clawdy",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [
      { id: "clawdy", url: "ws://fake-clawdy", password: "x", openclawAgentId: "main" },
      { id: "hank", url: "ws://fake-hank", password: "x", openclawAgentId: "main" },
    ],
  };
}

function freshPool() {
  return new GatewayPool(multiAgentRegistry());
}

/**
 * Drives a job to a terminal state without a gateway. The fake gateway's
 * chat() never resolves (every fixture job stays "running"), so anything that
 * asserts on a finished task's summary has to land the terminal state
 * directly on the job record the way the real completion path does.
 */
function completeJob(pool: GatewayPool, jobId: string, summary: string) {
  const job = pool.forJob(jobId)?.sessions.getJob(jobId);
  if (!job) throw new Error(`fixture job ${jobId} not found`);
  job.status = "completed";
  job.summary = summary;
  return job;
}

describe("concurrent taskId/sessionKey safety", () => {
  it("two run_task calls with no sessionKey produce independent jobs on independent sessions", () => {
    const pool = freshPool();
    const a = runTask(pool, { task: "task A" });
    const b = runTask(pool, { task: "task B" });
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });

  it("run_task calls to different agents are independently routed and both pollable by jobId", async () => {
    // waitMs clamps to a 1s floor, so drive this with fake timers instead of
    // eating ~1s of real wall-clock per checkTask call.
    vi.useFakeTimers();
    try {
      const pool = freshPool();
      const a = runTask(pool, { task: "task A", agent: "clawdy" });
      const b = runTask(pool, { task: "task B", agent: "hank" });
      expect(a.agent).toBe("clawdy");
      expect(b.agent).toBe("hank");

      const checkAPromise = checkTask(pool, { jobId: a.jobId, mode: "wait", waitMs: 1_000 });
      const checkBPromise = checkTask(pool, { jobId: b.jobId, mode: "wait", waitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const [checkA, checkB] = await Promise.all([checkAPromise, checkBPromise]);

      expect(checkA.found).toBe(true);
      expect(checkB.found).toBe(true);
      if (checkA.found) expect(checkA.snapshot.agent).toBe("clawdy");
      if (checkB.found) expect(checkB.snapshot.agent).toBe("hank");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second run_task on the same still-running session is rejected as busy — the original job stays intact and pollable", () => {
    const pool = freshPool();
    const first = runTask(pool, { task: "first" });
    const second = runTask(pool, { task: "second", sessionKey: first.sessionKey });

    expect(second.jobId).not.toBe(first.jobId);
    expect(pool.forJob(first.jobId)).toBeDefined();
  });

  it("get_task never confuses two concurrent taskIds on the same agent", () => {
    const pool = freshPool();
    const a = runTask(pool, { task: "task A" });
    const b = runTask(pool, { task: "task B" });
    const resultA = getTask(pool, { jobId: a.jobId });
    const resultB = getTask(pool, { jobId: b.jobId });
    expect(resultA.found && resultA.snapshot.jobId).toBe(a.jobId);
    expect(resultB.found && resultB.snapshot.jobId).toBe(b.jobId);
    // Cross-contamination check: A's snapshot must not resolve to B's session.
    if (resultA.found && resultB.found) {
      expect(resultA.snapshot.sessionKey).not.toBe(resultB.snapshot.sessionKey);
    }
  });
});

describe("get_session read model", () => {
  it("snapshot mode (default) returns current state without an events array", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    const result = getSession(pool, { sessionId: run.sessionKey });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.status).toBe("running");
    expect(result.events).toBeUndefined();
  });

  it("events mode returns a bounded slice of the log", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    const result = getSession(pool, { sessionId: run.sessionKey, mode: "events", limit: 2 });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.events?.length).toBe(2);
  });

  it("tail mode returns a nextAfter cursor that advances across pages", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    const first = getSession(pool, { sessionId: run.sessionKey, mode: "tail", limit: 2, after: 0 });
    expect(first.found).toBe(true);
    if (!first.found) return;
    expect(first.nextAfter).toBe(2);

    const second = getSession(pool, { sessionId: run.sessionKey, mode: "tail", limit: 2, after: first.nextAfter });
    expect(second.found).toBe(true);
    if (!second.found) return;
    expect(second.nextAfter).toBeGreaterThanOrEqual(first.nextAfter!);
  });

  it("unknown sessionId returns found:false", () => {
    const pool = freshPool();
    const result = getSession(pool, { sessionId: "does-not-exist" });
    expect(result.found).toBe(false);
  });

  it("tasks mode surfaces the session's job history through the pool, same TaskSummary shape as list_tasks", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it", agent: "hank" });
    const result = getSession(pool, { sessionId: run.sessionKey, mode: "tasks" });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.events).toBeUndefined();
    expect(result.tasks).toEqual([
      expect.objectContaining({ taskId: run.jobId, jobId: run.jobId, sessionKey: run.sessionKey, agent: "hank", status: "running" }),
    ]);
  });
});

describe("prompt retrieval authorization (getTaskPrompt)", () => {
  it("returns the original task/context/senderName for a resolvable taskId", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "investigate the bug", context: "seen in prod", senderName: "Jake" });
    const result = getTaskPrompt(pool, { jobId: run.jobId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.prompt).toEqual({ task: "investigate the bug", context: "seen in prod", senderName: "Jake" });
  });

  it("resolves the prompt by sessionKey too, matching check_task/get_task's dual jobId/sessionKey resolution", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "by session key" });
    const result = getTaskPrompt(pool, { sessionKey: run.sessionKey });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.prompt.task).toBe("by session key");
  });

  it("get_task's normal read path never includes the prompt, at any detail level — it's a distinct read", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "secret task text" });
    const result = getTask(pool, { jobId: run.jobId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(JSON.stringify(result.snapshot)).not.toContain("secret task text");
    expect(result.snapshot).not.toHaveProperty("prompt");
  });

  it("returns not-found for an unknown taskId — same authorization boundary as any other field", () => {
    const pool = freshPool();
    const result = getTaskPrompt(pool, { jobId: "does-not-exist" });
    expect(result.found).toBe(false);
  });

  it("does not cross-resolve prompts between two concurrent tasks on the same agent", () => {
    const pool = freshPool();
    const a = runTask(pool, { task: "task A prompt" });
    const b = runTask(pool, { task: "task B prompt" });
    const promptA = getTaskPrompt(pool, { jobId: a.jobId });
    const promptB = getTaskPrompt(pool, { jobId: b.jobId });
    expect(promptA.found && promptA.prompt.task).toBe("task A prompt");
    expect(promptB.found && promptB.prompt.task).toBe("task B prompt");
  });
});

describe("nextAction identifier consistency", () => {
  it("run_task's nextAction.args is exactly check_task's parameter set — jobId, not the taskId alias", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    expect(run.nextAction).toEqual({
      tool: "check_task",
      args: { jobId: run.jobId, sessionKey: run.sessionKey },
    });
    // The whole point of the field: the args object is the call, so its keys
    // must be exactly what check_task accepts — no rename step in between.
    expect(Object.keys(run.nextAction!.args).sort()).toEqual(["jobId", "sessionKey"]);
  });

  it("a running snapshot's nextAction.args feeds check_task directly and resolves the same job", async () => {
    vi.useFakeTimers();
    try {
      const pool = freshPool();
      const run = runTask(pool, { task: "do it" });
      const snap = getTask(pool, { jobId: run.jobId });
      expect(snap.found).toBe(true);
      if (!snap.found) return;
      const next = snap.snapshot.nextAction;
      expect(next).not.toBeNull();

      // Spread verbatim — if the key names ever drift from check_task's
      // parameters this stops resolving by jobId.
      const followUp = checkTask(pool, { ...next!.args, mode: "wait", waitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await followUp;
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.snapshot.jobId).toBe(run.jobId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nextAction is null once terminal — nothing left to poll", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, "done");
    const snap = getTask(pool, { jobId: run.jobId });
    expect(snap.found && snap.snapshot.nextAction).toBeNull();
  });
});

describe("log cursor handoff", () => {
  it("logCursor is the resume token, and is NOT the number of entries the response carried", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    const first = getTask(pool, { jobId: run.jobId });
    expect(first.found).toBe(true);
    if (!first.found) return;

    // The fake gateway emits a tool/tool-result pair plus a lifecycle line;
    // the projection collapses the pair, so the returned entry count is
    // already smaller than the cursor. Deriving knownLogCount from
    // logs.length would silently re-request events the caller already saw.
    expect(first.snapshot.logCursor).toBe(first.snapshot.logEventCount);
    expect(first.snapshot.logs.length).toBeLessThan(first.snapshot.logCursor);
  });

  it("passing the previous logCursor back verbatim returns no duplicates and holds the cursor steady when nothing new landed", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    const first = getTask(pool, { jobId: run.jobId });
    if (!first.found) throw new Error("expected a snapshot");

    const second = getTask(pool, { jobId: run.jobId, knownLogCount: first.snapshot.logCursor });
    if (!second.found) throw new Error("expected a snapshot");
    expect(second.snapshot.logs).toEqual([]);
    expect(second.snapshot.logCursor).toBe(first.snapshot.logCursor);
  });
});

describe("list_tasks summary bounds vs get_task's full read", () => {
  const longSummary = "x".repeat(TASK_SUMMARY_PREVIEW_MAX + 250);

  it("list_tasks truncates the summary preview and flags it", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, longSummary);

    const row = listTasks(pool).find((t) => t.taskId === run.jobId);
    expect(row).toBeDefined();
    expect(row!.summary!.length).toBe(TASK_SUMMARY_PREVIEW_MAX);
    expect(row!.summary!.endsWith("…")).toBe(true);
    expect(row!.summaryTruncated).toBe(true);
  });

  it("get_task keeps the full summary — that's the read path list_tasks points at", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, longSummary);

    const snap = getTask(pool, { jobId: run.jobId });
    expect(snap.found && snap.snapshot.summary).toBe(longSummary);
  });

  it("a summary already within the bound is passed through untouched, with no truncation flag", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, "short and complete");

    const row = listTasks(pool).find((t) => t.taskId === run.jobId);
    expect(row!.summary).toBe("short and complete");
    expect(row!.summaryTruncated).toBeUndefined();
  });

  it("get_session(mode:\"tasks\") rows follow the same listing bound as list_tasks", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, longSummary);

    const result = getSession(pool, { sessionId: run.sessionKey, mode: "tasks" });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.tasks?.[0].summary!.length).toBe(TASK_SUMMARY_PREVIEW_MAX);
    expect(result.tasks?.[0].summaryTruncated).toBe(true);
  });
});

describe("get_session tail is forward pagination", () => {
  it("pages oldest-first from `after`, and exhaustion shows as a short page with a non-advancing nextAfter", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });

    const everything = getSession(pool, { sessionId: run.sessionKey, mode: "events", limit: 200 });
    if (!everything.found) throw new Error("expected a session");
    const all = everything.events!;
    // A page size that can't divide the log evenly, so the last page is short.
    const limit = all.length - 1;

    const page1 = getSession(pool, { sessionId: run.sessionKey, mode: "tail", limit, after: 0 });
    if (!page1.found) throw new Error("expected a session");
    expect(page1.events).toEqual(all.slice(0, limit));
    expect(page1.nextAfter).toBe(limit);

    const page2 = getSession(pool, { sessionId: run.sessionKey, mode: "tail", limit, after: page1.nextAfter });
    if (!page2.found) throw new Error("expected a session");
    // Forward pagination: page 2 continues where page 1 stopped rather than
    // re-serving the newest entries, and a short page is the exhaustion signal.
    expect(page2.events).toEqual(all.slice(limit));
    expect(page2.events!.length).toBeLessThan(limit);
    expect(page2.nextAfter).toBe(all.length);

    const page3 = getSession(pool, { sessionId: run.sessionKey, mode: "tail", limit, after: page2.nextAfter });
    if (!page3.found) throw new Error("expected a session");
    expect(page3.events).toEqual([]);
    expect(page3.nextAfter).toBe(page2.nextAfter);
  });

  it("snapshot and tasks modes carry no events or nextAfter — pagination belongs to events/tail only", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    for (const mode of ["snapshot", "tasks"] as const) {
      const result = getSession(pool, { sessionId: run.sessionKey, mode });
      if (!result.found) throw new Error("expected a session");
      expect(result.events).toBeUndefined();
      expect(result.nextAfter).toBeUndefined();
    }
  });
});

describe("list_sessions returns known sessions, not just active ones", () => {
  it("keeps a session listed after its task reaches a terminal state", () => {
    const pool = freshPool();
    const run = runTask(pool, { task: "do it" });
    completeJob(pool, run.jobId, "done");

    const keys = listSessions(pool).map((s) => s.sessionKey);
    expect(keys).toContain(run.sessionKey);
  });

  it("lists sessions across every configured agent, each tagged with its agent", () => {
    const pool = freshPool();
    const a = runTask(pool, { task: "A", agent: "clawdy" });
    const b = runTask(pool, { task: "B", agent: "hank" });
    const byKey = new Map(listSessions(pool).map((s) => [s.sessionKey, s.agent]));
    expect(byKey.get(a.sessionKey)).toBe("clawdy");
    expect(byKey.get(b.sessionKey)).toBe("hank");
  });
});
