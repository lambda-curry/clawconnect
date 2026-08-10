import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../packages/mcp/src/server.ts";
import { createApp } from "../apps/chatgpt/src/app.ts";
import type { AgentRegistry } from "../packages/core/src/index.ts";

/**
 * The two transports must serve ONE tool catalog.
 *
 * They used to serve three hand-written ones — stdio, the HTTP modern path,
 * and the HTTP legacy router — and the copies had already drifted before
 * anyone noticed: the same argument documented differently on each, an
 * outputSchema present on one surface only, and identity handling that
 * existed on exactly one of them. Every one of those was invisible to a
 * passing test suite, because each surface was only ever tested against
 * itself.
 *
 * This file is the check that could have caught all of it: it asks both
 * transports what they serve and compares the answers directly. It fails on
 * the drift itself, not on any particular instance of it, so it keeps working
 * for the next field somebody adds to one surface and forgets on the other.
 */

function fakeRegistry(): AgentRegistry {
  return {
    default: "test-agent",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [
      { id: "test-agent", url: "ws://fake", password: "fake", openclawAgentId: "main" },
      { id: "other-agent", url: "ws://fake", password: "fake", openclawAgentId: "other" },
    ],
  };
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

type ToolShape = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

/** Everything a client is told about a tool EXCEPT the widget `_meta`, which is legitimately ChatGPT-only. */
function comparable(tools: ToolShape[]) {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }));
}

async function stdioTools(): Promise<ToolShape[]> {
  const { server } = createMcpServer({ registry: fakeRegistry() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools as ToolShape[];
}

async function httpTools(): Promise<ToolShape[]> {
  const { requestListener } = createApp(fakeRegistry(), { jobStoreDir: "/tmp/clawconnect-parity" });
  const server = createServer(requestListener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await res.text();
  const line = body.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const parsed = JSON.parse(line ? line.slice(5).trim() : body);
  return parsed.result.tools as ToolShape[];
}

describe("one tool surface, projected into every transport", () => {
  it("serves byte-identical declarations over stdio and HTTP", async () => {
    const [viaStdio, viaHttp] = await Promise.all([stdioTools(), httpTools()]);
    expect(comparable(viaHttp)).toEqual(comparable(viaStdio));
  });

  it("serves the same tool NAMES, so neither transport hides a capability", async () => {
    const [viaStdio, viaHttp] = await Promise.all([stdioTools(), httpTools()]);
    const names = (tools: ToolShape[]) => tools.map((t) => t.name).sort();
    expect(names(viaHttp)).toEqual(names(viaStdio));
    // A spot-check that the comparison above is actually comparing something.
    expect(names(viaStdio)).toContain("run_task");
    expect(names(viaStdio)).toContain("get_connection_info");
  });
});

describe("read/write separation is stated in prose, not only in annotations", () => {
  it("every read-only tool says so in the first line of its description", async () => {
    const tools = await stdioTools();
    const readOnly = tools.filter(
      (t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true,
    );
    // If this is ever zero the assertion below passes vacuously.
    expect(readOnly.length).toBeGreaterThan(5);
    for (const tool of readOnly) {
      expect(tool.description, `${tool.name} description`).toMatch(/^READ ONLY:/);
    }
  });

  it("the one mutating tool carries no read-only claim, in either channel", async () => {
    const tools = await stdioTools();
    const runTask = tools.find((t) => t.name === "run_task");
    expect(runTask?.description).not.toMatch(/READ ONLY/);
    expect(runTask?.annotations).toMatchObject({ readOnlyHint: false });
    // Exactly one tool mutates anything. A second one appearing here without
    // a deliberate decision is the thing worth failing on.
    const mutating = tools.filter(
      (t) => (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint !== true,
    );
    expect(mutating.map((t) => t.name)).toEqual(["run_task"]);
  });
});

describe("structured output", () => {
  it("every tool declares an outputSchema, so chaining never depends on parsing prose", async () => {
    const tools = await stdioTools();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });
});

describe("check_task's default wait behaviour", () => {
  it("defaults to wait, not poll, on every transport", async () => {
    // Regression guard. When the HTTP transport was converted to project the
    // shared capabilities, its default was set to "poll" on the reasoning that
    // a live progress card wants incremental updates. That was wrong twice
    // over: both HTTP paths it replaced defaulted to "wait", and the widget's
    // progress comes from the app-callable get_task/list_tasks rather than
    // from check_task at all. The effect was a check_task that answers "still
    // running" on every new log line, so a model collecting a result pays a
    // round trip per line and a task that is seconds from finishing still
    // reads as unfinished. It survived the unit suite and was caught by a
    // single real run against the live connector.
    const tools = await stdioTools();
    const checkTask = tools.find((t) => t.name === "check_task");
    const mode = (
      checkTask?.inputSchema as { properties?: { mode?: { description?: string } } } | undefined
    )?.properties?.mode?.description;
    expect(mode).toMatch(/"wait" \(default\)/);
  });
});
