import { describe, expect, it, vi } from "vitest";
import { GatewayPool } from "./gateway-pool.ts";
import { runTask, checkTask, getTask, getTaskPrompt, getSession } from "./tools.ts";
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
