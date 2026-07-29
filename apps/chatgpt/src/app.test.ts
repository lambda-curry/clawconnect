import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import type { AgentRegistry } from "@clawconnect/core";

/**
 * Real HTTP integration tests against createApp()'s request listener — a
 * live ephemeral server, real fetch() calls, real JSON-RPC framing. No live
 * OpenClaw gateway: agents point at an unroutable loopback port
 * (127.0.0.1:1, requires root to bind — guaranteed nothing is listening),
 * so run_task's fire-and-forget gateway.chat() fails fast in the
 * background without blocking the synchronous HTTP response.
 */

function fakeRegistry(): AgentRegistry {
  return {
    default: "test-agent",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [{ id: "test-agent", url: "ws://127.0.0.1:1", password: "x", openclawAgentId: "main" }],
  };
}

let servers: Server[] = [];
let tmpDirs: string[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

async function startTestApp(opts: { widgetEnabled?: boolean; widgetHtmlPath?: string } = {}) {
  if (opts.widgetEnabled) process.env.ENABLE_CHATGPT_UI_WIDGET = "true";
  else delete process.env.ENABLE_CHATGPT_UI_WIDGET;

  // Scratch dir, never the real default — a test run must never read or
  // write apps/chatgpt/.job-store.
  const jobStoreDir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-"));
  tmpDirs.push(jobStoreDir);

  const { requestListener, pool } = createApp(fakeRegistry(), { widgetHtmlPath: opts.widgetHtmlPath, jobStoreDir });
  const server = createServer(requestListener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return { url, pool };
}

let rpcId = 0;
async function rpc(url: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json() as Promise<{ result?: any; error?: { code: number; message: string } }>;
}

function writeFixtureWidget(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-widget-"));
  tmpDirs.push(dir);
  const path = join(dir, "widget.html");
  writeFileSync(path, html, "utf8");
  return path;
}

describe("unmounted core independence — run_task/get_task work identically regardless of widget state", () => {
  // Uses get_task (immediate, never waits — tools.ts's getTask() never calls
  // waitForJob) rather than check_task here deliberately: against an
  // unroutable agent URL, a check_task call on an already-errored job
  // triggers SessionManager's real lazy-recovery re-poll (session.ts's
  // maybeRecoverTerminalJob — a genuine, already-tested-elsewhere core
  // behavior, not a widget concern) which takes real seconds. get_task
  // sidesteps that entirely and is the more direct proof that the HTTP
  // route itself is unaffected by widget state.
  it("widget disabled: run_task -> get_task round trip succeeds", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const runResult = await rpc(url, "tools/call", { name: "run_task", arguments: { task: "do the thing" } });
    expect(runResult.error).toBeUndefined();
    const structured = runResult.result.structuredContent;
    expect(structured.jobId).toBeTruthy();
    expect(structured.nextAction).toEqual({ tool: "check_task", args: { taskId: structured.jobId, sessionKey: structured.sessionKey } });

    const getResult = await rpc(url, "tools/call", { name: "get_task", arguments: { taskId: structured.jobId } });
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.structuredContent.jobId).toBe(structured.jobId);
  });

  it("widget enabled but its resource is missing/broken: run_task -> get_task still succeeds", async () => {
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath: "/no/such/path/widget.html" });
    const runResult = await rpc(url, "tools/call", { name: "run_task", arguments: { task: "do the thing" } });
    expect(runResult.error).toBeUndefined();
    expect(runResult.result.isError).toBeFalsy();
    const jobId = runResult.result.structuredContent.jobId;

    const getResult = await rpc(url, "tools/call", { name: "get_task", arguments: { taskId: jobId } });
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.structuredContent.jobId).toBe(jobId);

    // The broken resource itself surfaces as a JSON-RPC error on resources/read,
    // not a crash — a missing widget file must never affect the tool surface.
    const readResult = await rpc(url, "resources/read", { uri: "ui://clawconnect/task-center-v1.html" });
    expect(readResult.error).toBeDefined();
  });
});

describe("missing UI metadata fallback — widget disabled means the surface looks exactly like a generic MCP server", () => {
  it("resources/list is empty and initialize advertises no extensions capability", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const initResult = await rpc(url, "initialize", { protocolVersion: "2025-06-18" });
    expect(initResult.result.capabilities).not.toHaveProperty("extensions");

    const listResult = await rpc(url, "resources/list");
    expect(listResult.result.resources).toEqual([]);
  });

  it("no tool carries widget/resource _meta (ui.*, openai/outputTemplate, openai/widgetAccessible) when disabled", async () => {
    // run_task's "openai/toolInvocation/invoking" progress hint is
    // unrelated to the widget resource system and stays present regardless
    // (it predates the widget entirely) — this checks only the
    // resource-mounting keys the widget gate actually controls.
    const { url } = await startTestApp({ widgetEnabled: false });
    const { result } = await rpc(url, "tools/list");
    for (const tool of result.tools) {
      const meta = tool._meta ?? {};
      expect(meta).not.toHaveProperty("ui");
      expect(meta).not.toHaveProperty("openai/outputTemplate");
      expect(meta).not.toHaveProperty("openai/widgetAccessible");
    }
  });

  it("resources/read for the widget URI errors cleanly when the widget is disabled", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const result = await rpc(url, "resources/read", { uri: "ui://clawconnect/task-center-v1.html" });
    expect(result.error).toBeDefined();
  });
});

describe("widget enabled with a real resource", () => {
  it("resources/list and resources/read serve the built widget; capabilities/extensions is advertised", async () => {
    const widgetHtmlPath = writeFixtureWidget("<html><body>fixture widget</body></html>");
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath });

    const initResult = await rpc(url, "initialize", { protocolVersion: "2025-06-18" });
    expect(initResult.result.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });

    const listResult = await rpc(url, "resources/list");
    expect(listResult.result.resources).toHaveLength(1);
    expect(listResult.result.resources[0].mimeType).toBe("text/html;profile=mcp-app");

    const readResult = await rpc(url, "resources/read", { uri: listResult.result.resources[0].uri });
    expect(readResult.result.contents[0].text).toBe("<html><body>fixture widget</body></html>");
  });

  it("only run_task carries a resourceUri; get_task/list_tasks/get_session are app-callable without one", async () => {
    const widgetHtmlPath = writeFixtureWidget("<html></html>");
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath });
    const { result } = await rpc(url, "tools/list");
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));

    expect(byName.run_task._meta.ui.resourceUri).toBe("ui://clawconnect/task-center-v1.html");
    expect(byName.run_task._meta.ui.visibility).toEqual(["model", "app"]);

    for (const name of ["get_task", "list_tasks", "get_session"]) {
      expect(byName[name]._meta.ui.visibility).toEqual(["model", "app"]);
      expect(byName[name]._meta.ui).not.toHaveProperty("resourceUri");
    }

    // check_task never mounts a card and is never marked app-callable —
    // the assistant's own polling loop must never mint a duplicate card.
    expect(byName.check_task._meta).toBeUndefined();
  });
});

describe("protocolVersion negotiation over real HTTP", () => {
  it("echoes a supported requested version", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const result = await rpc(url, "initialize", { protocolVersion: "2024-11-05" });
    expect(result.result.protocolVersion).toBe("2024-11-05");
  });

  it("falls back to the MCP-Apps floor for an unrecognized version", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const result = await rpc(url, "initialize", { protocolVersion: "1999-01-01" });
    expect(result.result.protocolVersion).toBe("2025-06-18");
  });
});
