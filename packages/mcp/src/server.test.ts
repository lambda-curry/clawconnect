import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.ts";
import type { AgentRegistry } from "@clawconnect/core";

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
