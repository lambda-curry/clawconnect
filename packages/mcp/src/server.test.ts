import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, defaultFormatCheckTask } from "./server.ts";
import { AgentSessionRuntimeRegistry } from "@clawconnect/core";
import type { AgentRegistry, CheckTaskResult, FleetAdapter, JobSnapshot } from "@clawconnect/core";

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

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A directory holding one agent's attachment file, as a prior process would have left it. */
function seededFleetStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleet-store-"));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, "test-agent.fleet.json"),
    JSON.stringify([
      {
        sessionKey: "sess-1",
        currentAttachmentId: "att-1",
        attachments: {
          "att-1": {
            id: "att-1",
            runtime: "t3-fleet",
            provider: "anthropic-claude-code",
            handle: "thr-abc123",
            attachedAt: 1,
            status: "needs_input",
            observationToken: 7,
          },
        },
      },
    ]),
  );
  return dir;
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

  /**
   * The default running hint tells the model to call check_task again. When
   * the delegated session is already waiting on a human, that is advice to
   * wait forever — so the notice replaces it rather than sitting beside it.
   */
  it("replaces the keep-polling hint when the delegated session is already waiting on a human", () => {
    for (const state of ["needs_input", "needs_permission"] as const) {
      const response = defaultFormatCheckTask(
        runningResult({
          fleetAttachment: {
            id: "att-1",
            runtime: "t3-fleet",
            handle: "thr-abc123",
            attachedAt: 1,
            status: state,
            latestResponse: "should I force-push?",
            remoteUrl: "https://t3.example/threads/abc123",
            delegatedTurnId: "job-1",
          },
        }),
      );
      const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
      const hint = String(payload.hint);
      expect(hint, state).toContain("t3-fleet/thr-abc123");
      expect(hint, state).toContain(state === "needs_permission" ? "waiting for permission" : "waiting for input");
      expect(hint, state).toContain("Polling cannot advance it");
      expect(hint, state).not.toContain("Task is actively running");
      // The resume cursor still has to survive: the caller does poll again,
      // after answering.
      expect(hint, state).toContain("knownLogCount=17");
      expect(String(payload.blockedDelegation), state).toContain("thr-abc123");
      expect(payload.delegatedSession, state).toMatchObject({ handle: "thr-abc123", status: state });
      // Still a non-terminal running response — the block does not end the job.
      expect(payload.status, state).toBe("running");
      expect(payload.continuePolling, state).toBe(true);
    }
  });

  it("says nothing when the blocked attachment belongs to a different turn", () => {
    const response = defaultFormatCheckTask(
      runningResult({
        fleetAttachment: {
          id: "att-1",
          runtime: "t3-fleet",
          handle: "thr-abc123",
          attachedAt: 1,
          status: "needs_input",
          delegatedTurnId: "job-0",
        },
      }),
    );
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(String(payload.hint)).toContain("Task is actively running");
    expect(payload).not.toHaveProperty("blockedDelegation");
  });

  it("leaves an ordinary running payload byte-for-byte as it was", () => {
    const payload = JSON.parse(defaultFormatCheckTask(runningResult()).content[0].text) as Record<string, unknown>;
    expect(String(payload.hint)).toBe(
      "Task is actively running (this is a non-terminal timeout, not an error). Call check_task again with the same jobId to continue waiting; pass knownLogCount=17 to resume the log window.",
    );
    expect(payload).not.toHaveProperty("blockedDelegation");
    expect(payload).not.toHaveProperty("delegatedSession");
  });
});

describe("a terminal turn whose delegated session is waiting on a human", () => {
  const blockedAttachment = {
    id: "att-1",
    runtime: "t3-fleet",
    provider: "anthropic-claude-code",
    handle: "thr-abc123",
    attachedAt: 1,
    status: "needs_input" as const,
    latestResponse: "should I force-push?",
    remoteUrl: "https://t3.example/threads/abc123",
    delegatedTurnId: "job-1",
  };

  function terminalResult(overrides: Partial<JobSnapshot> = {}): CheckTaskResult {
    const snapshot: JobSnapshot = {
      jobId: "job-1",
      sessionKey: "session-1",
      status: "completed_no_summary",
      startedAt: Date.now() - 5_000,
      lastEventAt: Date.now(),
      lastPollAt: Date.now(),
      logs: [],
      logCursor: 0,
      logEventCount: 0,
      artifacts: { filesChanged: [], commandsRun: [], needsHumanDecision: false },
      agent: "test-agent",
      pollCount: 2,
      continuePolling: false,
      retryAfterMs: 0,
      nextAction: null,
      ...overrides,
    };
    return { found: true, snapshot, isTerminal: true, isError: false, continuePolling: false };
  }

  it("says so in the model-facing text instead of reading as an ordinary finished task", () => {
    const response = defaultFormatCheckTask(
      terminalResult({
        summary: "This turn produced no result of its own…",
        fleetAttachment: blockedAttachment,
        terminalReason: "delegate-blocked:needs_input",
      }),
    );
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(String(payload.blockedDelegation)).toContain("t3-fleet/thr-abc123");
    expect(String(payload.blockedDelegation)).toContain("waiting for input");
    expect(String(payload.blockedDelegation)).toContain("should I force-push?");
    // The attachment itself rides along, so the caller can act without a
    // second round-trip to get_task.
    expect(payload.delegatedSession).toMatchObject({ handle: "thr-abc123", status: "needs_input" });
    expect(payload.terminalReason).toBe("delegate-blocked:needs_input");
  });

  it("leaves an ordinary terminal payload byte-for-byte as it was", () => {
    const plain = JSON.parse(defaultFormatCheckTask(terminalResult({ summary: "the answer" })).content[0].text);
    expect(plain).not.toHaveProperty("blockedDelegation");
    expect(plain).not.toHaveProperty("delegatedSession");
    expect(plain.summary).toBe("the answer");

    // An attachment that is NOT blocked is likewise not called out.
    const running = JSON.parse(
      defaultFormatCheckTask(
        terminalResult({
          summary: "the answer",
          fleetAttachment: { ...blockedAttachment, status: "running" },
        }),
      ).content[0].text,
    );
    expect(running).not.toHaveProperty("blockedDelegation");
  });
});

describe("production entrypoint wiring — FleetAdapter", () => {
  /**
   * Independent-review blocker 1: recovery tier 3 (see docs/architecture/
   * 2026-08-02-managed-fleet-attachment-plan.md) is only reachable if a real
   * FleetAdapter is actually injected in production, not just implemented and
   * left unwired. Proves createMcpServer() does this by default, without
   * spinning up a real recovery scenario — SessionManager.hasFleetAdapter()
   * is the dedicated, minimal surface for exactly this assertion.
   */
  it("createMcpServer wires a real FleetAdapter into every agent's SessionManager by default", () => {
    const { pool } = createMcpServer({ registry: fakeRegistry() });
    expect(pool.forAgent("test-agent").sessions.hasFleetAdapter()).toBe(true);
  });

  it("createMcpServer lets a caller override the FleetAdapter (e.g. a test injecting a fake)", () => {
    const fake: FleetAdapter = { isLive: async () => false, readTerminalHandoff: async () => null };
    const { pool } = createMcpServer({ registry: fakeRegistry(), fleetAdapter: fake });
    expect(pool.forAgent("test-agent").sessions.hasFleetAdapter()).toBe(true);
  });

  /**
   * Same failure mode, one layer up: a registered runtime nothing can
   * dispatch to looks exactly like a working integration until a delegation
   * needs it.
   */
  it("createMcpServer passes a host's agent-session runtime registry through to every agent", () => {
    const runtimes = new AgentSessionRuntimeRegistry();
    runtimes.register({ id: "t3-fleet", provider: "anthropic-claude-code", inspect: async () => ({ state: "running" }) });
    const { pool } = createMcpServer({ registry: fakeRegistry(), agentSessionRuntimes: runtimes });
    expect(pool.forAgent("test-agent").sessions.hasAgentSessionRuntime("t3-fleet")).toBe(true);
  });

  it("createMcpServer leaves claude-fleet the only reachable runtime when no registry is supplied", () => {
    const { pool } = createMcpServer({ registry: fakeRegistry() });
    expect(pool.forAgent("test-agent").sessions.hasAgentSessionRuntime("t3-fleet")).toBe(false);
  });

  /**
   * Attachment lineage is durable state the managed-session model depends on:
   * which conversation is delegated to which session, and its replacement
   * history. A stdio server restarts often (the host reconnects, the machine
   * sleeps) while the runtime session it delegated to is still very much
   * alive — so a deployment that claims managed-session support has to persist
   * it. `clawconnect-mcp` (bin.ts) passes a directory; this proves the factory
   * carries it all the way through to each agent's store.
   */
  it("createMcpServer reloads persisted attachment lineage when the deployment configures a directory", () => {
    const dir = seededFleetStore();
    const { pool } = createMcpServer({ registry: fakeRegistry(), fleetStoreDir: dir });
    // Reachable without a request having touched this agent first: an agent
    // nobody has queried since the restart would otherwise look unattached.
    expect(pool.forAgent("test-agent").sessions.getFleetAttachment("sess-1")).toMatchObject({
      runtime: "t3-fleet",
      handle: "thr-abc123",
      status: "needs_input",
    });
  });

  it("stays fully in-memory when no directory is configured, exactly as before", () => {
    const dir = seededFleetStore();
    const { pool } = createMcpServer({ registry: fakeRegistry() });
    expect(pool.forAgent("test-agent").sessions.getFleetAttachment("sess-1")).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["test-agent.fleet.json"]);
  });
});
