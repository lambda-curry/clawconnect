import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, defaultFormatCheckTask } from "./server.ts";
import type { AgentRegistry, CheckTaskResult, JobSnapshot } from "@clawconnect/core";

/**
 * Generic MCP compatibility fixtures for the stdio server (Claude Code,
 * Cursor, Codex, or any bare MCP client). Uses the SDK's InMemoryTransport
 * so these exercise the real protocol layer (schema validation, JSON-RPC
 * framing) without a live OpenClaw gateway — a fresh GatewayPool never opens
 * a WebSocket until a tool handler actually resolves an agent, and every
 * fixture below sticks to reads that resolve against an empty pool (unknown
 * jobId/taskId/sessionId), so nothing here does live network I/O.
 * See docs/architecture/2026-07-27-multi-client-compatibility.md §7.
 */

function fakeRegistry(): AgentRegistry {
  return {
    default: "test-agent",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [{ id: "test-agent", url: "ws://fake", password: "fake", openclawAgentId: "main" }],
  };
}

async function connectedClient() {
  const { server } = createMcpServer({ registry: fakeRegistry() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("generic MCP tools/list contract", () => {
  it("exposes the unversioned core surface — run_task/check_task/get_task/list_tasks, no _v2 names anywhere", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["run_task", "check_task", "get_task", "list_tasks"]));
    expect(names.some((n) => /_v\d/i.test(n))).toBe(false);
  });

  it("never leaks ChatGPT-only openai/* _meta into the generic stdio surface", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const metaKeys = Object.keys((tool as { _meta?: Record<string, unknown> })._meta ?? {});
      expect(metaKeys.filter((k) => k.startsWith("openai/"))).toEqual([]);
    }
  });

  it("check_task exposes waitMs/mode; get_task has no wait/mode escape hatch at all (it never waits)", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const checkTask = tools.find((t) => t.name === "check_task")!;
    expect(Object.keys(checkTask.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["waitMs", "mode"]));

    const getTask = tools.find((t) => t.name === "get_task")!;
    expect(getTask.inputSchema.properties).not.toHaveProperty("mode");
    expect(getTask.inputSchema.properties).not.toHaveProperty("waitMs");
    expect(Object.keys(getTask.inputSchema.properties ?? {})).toContain("detail");
  });

  it("annotations are declared as hints, not treated as guarantees — read-only tools are marked, run_task is not", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const runTask = tools.find((t) => t.name === "run_task")!;
    const checkTask = tools.find((t) => t.name === "check_task")!;
    expect(runTask.annotations?.readOnlyHint).toBe(false);
    expect(checkTask.annotations?.readOnlyHint).toBe(true);
    expect(checkTask.annotations?.idempotentHint).toBe(true);
  });
});

describe("generic MCP tools/call contract — read-only tools against an empty pool", () => {
  it("check_task on an unknown jobId returns a not-found error, not a crash", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "check_task", arguments: { jobId: "does-not-exist" } });
    expect(result.isError).toBe(true);
  });

  it("get_task on an unknown taskId returns a not-found error, and never blocks (immediate)", async () => {
    const client = await connectedClient();
    const start = Date.now();
    const result = await client.callTool({ name: "get_task", arguments: { taskId: "does-not-exist" } });
    expect(result.isError).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("get_task detail=\"prompt\" on an unknown taskId returns a not-found error, not a leak/crash", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_task", arguments: { taskId: "does-not-exist", detail: "prompt" } });
    expect(result.isError).toBe(true);
  });

  it("list_tasks / list_sessions / list_agents / list_collections resolve cleanly on a fresh pool", async () => {
    const client = await connectedClient();
    for (const name of ["list_tasks", "list_sessions", "list_agents", "list_collections"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBeFalsy();
    }
  });

  it("get_session on an unknown sessionId returns not-found", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_session", arguments: { sessionId: "nope" } });
    expect(result.isError).toBe(true);
  });
});

describe("Claude / Claude Code — extra-field and _meta tolerance", () => {
  it("tolerates unrecognized extra properties in tool arguments instead of rejecting the call", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "get_task",
      arguments: { taskId: "does-not-exist", unexpectedField: "some client sends this", nested: { a: 1 } },
    });
    // Zod object schemas strip unknown keys by default rather than throwing —
    // this must resolve to the normal not-found response, not a validation error.
    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
  });

  it("tolerates a request-level _meta block (progress tokens, related-task, etc.) without erroring", async () => {
    const client = await connectedClient();
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "list_tasks",
          arguments: {},
          _meta: { progressToken: "abc123", "io.modelcontextprotocol/related-task": { taskId: "unrelated" } },
        },
      },
      CallToolResultSchema,
    );
    expect(result.isError).toBeFalsy();
  });
});

/**
 * The tool descriptions ARE the contract for a model client — they're the
 * only thing a caller reads before choosing arguments. These pin the
 * corrections that a wrong description would silently undo: the cursor is
 * opaque, list_tasks previews are bounded, tail pages forward, and
 * list_sessions is not an "active only" view.
 */
describe("tool description contract", () => {
  async function toolsByName() {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t]));
  }

  it("check_task tells the caller to hand logCursor back verbatim, and warns against deriving it from the entry count", async () => {
    const tools = await toolsByName();
    const checkTask = tools.get("check_task")!;
    expect(checkTask.description).toMatch(/logCursor/);
    expect(checkTask.description).toMatch(/verbatim/i);
    const knownLogCount = (checkTask.inputSchema.properties as Record<string, { description?: string }>).knownLogCount;
    expect(knownLogCount.description).toMatch(/logCursor/);
    expect(knownLogCount.description).toMatch(/never/i);
  });

  it("check_task presents completed_no_summary/error as terminal, with late recovery as the exception", async () => {
    const tools = await toolsByName();
    const description = tools.get("check_task")!.description!;
    expect(description).toMatch(/completed_no_summary and error are terminal/i);
    expect(description).toMatch(/not as routine/i);
  });

  it("list_tasks advertises its summary preview bound and points at get_task for the full text", async () => {
    const tools = await toolsByName();
    const description = tools.get("list_tasks")!.description!;
    expect(description).toMatch(/preview/i);
    expect(description).toMatch(/summaryTruncated/);
    expect(description).toMatch(/get_task/);
  });

  it("get_task's detail preset describes the fields each level actually returns", async () => {
    const tools = await toolsByName();
    const detail = (tools.get("get_task")!.inputSchema.properties as Record<string, { description?: string }>).detail;
    // `updates` is the field name the payload uses; "logs" was the stale one.
    expect(detail.description).toMatch(/updates=core\+`updates`/);
    expect(detail.description).not.toMatch(/updates=\+logs/);
    // core is not "ids+status only" — it always carries polling metadata too.
    expect(detail.description).toMatch(/core=identifiers, status, and polling metadata/);
  });

  it("get_session describes tail as forward pagination and documents the tasks mode", async () => {
    const tools = await toolsByName();
    const mode = (tools.get("get_session")!.inputSchema.properties as Record<string, { description?: string }>).mode;
    expect(mode.description).toMatch(/FORWARD/);
    expect(mode.description).toMatch(/nextAfter/);
    expect(mode.description).toMatch(/"tasks"/);
    const after = (tools.get("get_session")!.inputSchema.properties as Record<string, { description?: string }>).after;
    expect(after.description).toMatch(/logCursor/);
  });

  it("list_sessions describes known sessions, not only active ones", async () => {
    const tools = await toolsByName();
    const description = tools.get("list_sessions")!.description!;
    expect(description).not.toMatch(/\bactive\b/i);
    expect(description).toMatch(/including finished/i);
  });

  it("only run_task's agent parameter carries routing prose — the inferred-agent tools don't repeat it", async () => {
    const tools = await toolsByName();
    const agentDesc = (name: string) =>
      (tools.get(name)!.inputSchema.properties as Record<string, { description?: string }>).agent?.description ?? "";
    expect(agentDesc("run_task")).toMatch(/list_agents/);
    for (const name of ["check_task", "get_session"]) {
      expect(agentDesc(name)).toMatch(/inferred/i);
      expect(agentDesc(name)).not.toMatch(/list_agents/);
    }
    // The agent enum is the machine-readable list; descriptions shouldn't
    // re-enumerate it on every tool.
    for (const name of ["check_task", "list_tasks", "list_sessions", "get_session"]) {
      expect(tools.get(name)!.description).not.toMatch(/Available agents/i);
    }
  });
});

describe("check_task model-facing text carries the resume cursor", () => {
  function runningResult(overrides: Partial<JobSnapshot> = {}): CheckTaskResult {
    const snapshot: JobSnapshot = {
      jobId: "job-1",
      sessionKey: "session-1",
      status: "running",
      startedAt: Date.now() - 5_000,
      lastEventAt: Date.now(),
      lastPollAt: Date.now(),
      // A bounded projection: two entries returned, cursor at 17. Anything
      // that reports logs.length as the cursor is the bug under test.
      logs: [
        { ts: 1, type: "tool", text: "a", seq: 16 },
        { ts: 2, type: "lifecycle", text: "b", seq: 17 },
      ],
      logCursor: 17,
      logEventCount: 17,
      artifacts: { filesChanged: [], commandsRun: [], needsHumanDecision: false },
      agent: "test-agent",
      pollCount: 2,
      continuePolling: true,
      retryAfterMs: 0,
      nextAction: { tool: "check_task", args: { jobId: "job-1", sessionKey: "session-1" } },
      ...overrides,
    };
    return { found: true, snapshot, isTerminal: false, isError: false, continuePolling: true };
  }

  it("the running text payload reports logCursor, and never the returned-entry count as a cursor", () => {
    const response = defaultFormatCheckTask(runningResult());
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(payload.logCursor).toBe(17);
    expect(payload.logEventCount).toBe(17);
    // `logCount` was the returned-window size — exactly the number a caller
    // must not send back as knownLogCount.
    expect(payload).not.toHaveProperty("logCount");
    expect(String(payload.hint)).toContain("knownLogCount=17");
  });

  it("the late-recovery hint carries the cursor too", () => {
    const response = defaultFormatCheckTask(
      runningResult({ recovery: { reason: "no_live_final_text", startedAt: Date.now(), idleTimeoutMs: 1, hardCapMs: 2 } }),
    );
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(String(payload.hint)).toContain("knownLogCount=17");
  });
});
