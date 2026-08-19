import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, checkTaskText } from "./app.ts";
import { AgentSessionRuntimeRegistry } from "@clawconnect/core";
import type { AgentRegistry, JobSnapshot } from "@clawconnect/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

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
let modernClients: Client[] = [];

afterEach(() => {
  for (const client of modernClients) void client.close();
  modernClients = [];
  for (const s of servers) s.close();
  servers = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  delete process.env.PUBLIC_MCP_PASS;
});

async function startTestApp(
  opts: {
    widgetEnabled?: boolean;
    widgetHtmlPath?: string;
    registry?: AgentRegistry;
    authPass?: string;
  } = {},
) {
  if (opts.widgetEnabled) process.env.ENABLE_CHATGPT_UI_WIDGET = "true";
  else delete process.env.ENABLE_CHATGPT_UI_WIDGET;
  if (opts.authPass) process.env.PUBLIC_MCP_PASS = opts.authPass;
  else delete process.env.PUBLIC_MCP_PASS;

  // Scratch dir, never the real default — a test run must never read or
  // write apps/chatgpt/.job-store.
  const jobStoreDir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-"));
  tmpDirs.push(jobStoreDir);

  const { requestListener, pool } = createApp(opts.registry ?? fakeRegistry(), {
    widgetHtmlPath: opts.widgetHtmlPath,
    jobStoreDir,
  });
  const server = createServer(requestListener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("expected a bound TCP address");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return { url, pool };
}

let rpcId = 0;

/**
 * A complete initialize params object. The SDK validates these; the
 * hand-rolled router it replaced accepted a bare protocolVersion, so the old
 * fixtures under-specified what a real client actually sends.
 */
const INIT_PARAMS = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "test-client", version: "0.0.0" },
});
/**
 * A 2025-era streamable-HTTP client, behaving as the spec requires rather
 * than as our old hand-rolled router happened to tolerate: it advertises both
 * response types and accepts either framing back. The previous helper sent
 * only `Content-Type: application/json` and assumed a JSON body, which worked
 * only because the hand-rolled router never enforced `Accept` and never
 * streamed. Testing against a lenient fixture is how a transport change like
 * this stays invisible until a real client hits it.
 */
async function rpc(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.text();
  if (!body) return {} as { result?: any; error?: { code: number; message: string } };
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    // One JSON-RPC response per `data:` line; the last one is this request's.
    const payloads = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    return payloads[payloads.length - 1];
  }
  return JSON.parse(body) as { result?: any; error?: { code: number; message: string } };
}

async function modernClient(
  url: string,
  fetchImpl?: typeof fetch,
  headers?: Record<string, string>,
) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: fetchImpl,
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client(
    { name: "modern-test-client", version: "0.0.0" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  modernClients.push(client);
  return client;
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
    const runResult = await rpc(url, "tools/call", {
      name: "run_task",
      arguments: { task: "do the thing" },
    });
    expect(runResult.error).toBeUndefined();
    const structured = runResult.result.structuredContent;
    expect(structured.jobId).toBeTruthy();
    expect(structured.nextAction).toEqual({
      tool: "check_task",
      args: { jobId: structured.jobId, sessionKey: structured.sessionKey },
    });

    const getResult = await rpc(url, "tools/call", {
      name: "get_task",
      arguments: { taskId: structured.jobId },
    });
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.structuredContent.jobId).toBe(structured.jobId);
  });

  it("widget enabled but its resource is missing/broken: run_task -> get_task still succeeds", async () => {
    const { url } = await startTestApp({
      widgetEnabled: true,
      widgetHtmlPath: "/no/such/path/widget.html",
    });
    const runResult = await rpc(url, "tools/call", {
      name: "run_task",
      arguments: { task: "do the thing" },
    });
    expect(runResult.error).toBeUndefined();
    expect(runResult.result.isError).toBeFalsy();
    const jobId = runResult.result.structuredContent.jobId;

    const getResult = await rpc(url, "tools/call", {
      name: "get_task",
      arguments: { taskId: jobId },
    });
    expect(getResult.error).toBeUndefined();
    expect(getResult.result.structuredContent.jobId).toBe(jobId);

    // The broken resource itself surfaces as a JSON-RPC error on resources/read,
    // not a crash — a missing widget file must never affect the tool surface.
    const readResult = await rpc(url, "resources/read", {
      uri: "ui://clawconnect/task-center-v3.html",
    });
    expect(readResult.error).toBeDefined();
  });
});

describe("missing UI metadata fallback — widget disabled means the surface looks exactly like a generic MCP server", () => {
  it("resources/list is empty and initialize advertises no extensions capability", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const initResult = await rpc(url, "initialize", INIT_PARAMS("2025-06-18"));
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
    const result = await rpc(url, "resources/read", {
      uri: "ui://clawconnect/task-center-v3.html",
    });
    expect(result.error).toBeDefined();
  });
});

describe("widget enabled with a real resource", () => {
  it("resources/list and resources/read serve the built widget; capabilities/extensions is advertised", async () => {
    const widgetHtmlPath = writeFixtureWidget("<html><body>fixture widget</body></html>");
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath });

    const initResult = await rpc(url, "initialize", INIT_PARAMS("2025-06-18"));
    expect(initResult.result.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });

    const listResult = await rpc(url, "resources/list");
    expect(listResult.result.resources).toHaveLength(1);
    expect(listResult.result.resources[0].mimeType).toBe("text/html;profile=mcp-app");

    const readResult = await rpc(url, "resources/read", {
      uri: listResult.result.resources[0].uri,
    });
    expect(readResult.result.contents[0].text).toBe("<html><body>fixture widget</body></html>");
  });

  it("only run_task carries a resourceUri; get_task/list_tasks/get_session are app-callable without one", async () => {
    const widgetHtmlPath = writeFixtureWidget("<html></html>");
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath });
    const { result } = await rpc(url, "tools/list");
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));

    expect(byName.run_task._meta.ui.resourceUri).toBe("ui://clawconnect/task-center-v3.html");
    expect(byName.run_task._meta.ui.visibility).toEqual(["model", "app"]);

    for (const name of ["get_task", "list_tasks", "get_session"]) {
      expect(byName[name]._meta.ui.visibility).toEqual(["model", "app"]);
      expect(byName[name]._meta.ui).not.toHaveProperty("resourceUri");
    }

    // check_task never mounts a card and is never marked app-callable —
    // the assistant's own polling loop must never mint a duplicate card.
    expect(byName.check_task._meta).toBeUndefined();
  });

  it("tells the model to hand off rather than chain waits until the reply dies", async () => {
    // The contract is duplicated: packages/mcp/src/server.ts serves the stdio
    // server, and this app serves ChatGPT. They drifted — the cap was added to
    // one and not the other, and a deploy was the thing that noticed. This
    // asserts it on the surface that actually broke.
    //
    // Chaining is what kills the parent stream: each wait is bounded at 45s,
    // but seven of them is five and a half minutes in one reply with nothing
    // visible happening, and the host gives up on it.
    const { url } = await startTestApp({
      widgetEnabled: true,
      widgetHtmlPath: writeFixtureWidget("<html></html>"),
    });
    const { result } = await rpc(url, "tools/list");
    const checkTask = result.tools.find((t: any) => t.name === "check_task");

    expect(checkTask.description).toContain("Do not wait indefinitely inside one reply");
    expect(checkTask.description).toMatch(/end your reply/i);
    // The instruction that produced the unbounded loop must be gone, not merely
    // contradicted further down.
    expect(checkTask.description).not.toContain("no cap on how many times");
  });
});

describe("protocolVersion negotiation over real HTTP", () => {
  it("echoes a supported requested version", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const result = await rpc(url, "initialize", INIT_PARAMS("2024-11-05"));
    expect(result.result.protocolVersion).toBe("2024-11-05");
  });

  it("falls back to a supported revision for an unrecognized version", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const result = await rpc(url, "initialize", INIT_PARAMS("1999-01-01"));
    // The SDK owns negotiation now, and picks its own newest legacy revision
    // rather than the MCP-Apps floor our hand-maintained list named. What
    // matters to us is that an unknown request still lands on a revision this
    // server actually speaks, instead of echoing something nobody supports.
    expect(result.result.protocolVersion).toBe("2025-11-25");
  });
});

describe("MCP 2026-07-28 over the SDK v2 handler", () => {
  it("allows validated dynamic MCP parameter headers through browser preflight", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const res = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type, mcp-protocol-version, mcp-param-task, x-not-allowed",
      },
    });
    const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(res.status).toBe(204);
    expect(allowed).toContain("mcp-param-task");
    expect(allowed).not.toContain("x-not-allowed");
  });

  it("negotiates the modern era and serves the same tools/list surface", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url);
    expect(client.getProtocolEra()).toBe("modern");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["run_task", "check_task", "get_task", "list_tasks"]),
    );
    const runTaskMeta = tools.find((tool) => tool.name === "run_task")?._meta;
    expect(runTaskMeta).not.toHaveProperty("ui/resourceUri");
    expect(runTaskMeta).not.toHaveProperty("openai/outputTemplate");
  });

  it("lets ChatGPT report the protocol version for either HTTP era", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const modern = await modernClient(url);
    const modernInfo = await modern.callTool({ name: "get_connection_info", arguments: {} });
    expect(modernInfo.structuredContent).toMatchObject({
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
    });

    const legacyInfo = await rpc(url, "tools/call", {
      name: "get_connection_info",
      arguments: {},
    });
    expect(legacyInfo.result.structuredContent).toMatchObject({ protocolEra: "legacy" });
    // No MCP-Protocol-Version header was sent, so there is no negotiated
    // revision to report and the manifest omits it rather than substituting
    // a constant — the defect that let this tool contradict its own handshake.
    expect(legacyInfo.result.structuredContent).not.toHaveProperty("protocolVersion");

    const declared = await rpc(url, "tools/call", { name: "get_connection_info", arguments: {} }, {
      "MCP-Protocol-Version": "2025-06-18",
    });
    expect(declared.result.structuredContent).toMatchObject({
      protocolEra: "legacy",
      protocolVersion: "2025-06-18",
    });
  });

  it("emits modern standard headers and a per-request metadata envelope", async () => {
    const seen: Array<{ headers: Headers; body: any }> = [];
    const captureFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push({ headers: request.headers, body: JSON.parse(await request.clone().text()) });
      return fetch(request);
    };
    const { url } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url, captureFetch);
    await client.listTools({ _meta: { trace: "per-request-marker" } });

    const list = seen.find((entry) => entry.body.method === "tools/list")!;
    expect(list.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(list.headers.get("Mcp-Method")).toBe("tools/list");
    expect(list.body.params._meta.trace).toBe("per-request-marker");
    expect(list.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("rejects malformed modern header/envelope combinations as structured errors", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32020);
    expect(body.id).toBe(41);
  });

  it("rejects non-JSON media types before either protocol-era route", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const legacy = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const modern = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(legacy.status).toBe(415);
    expect(modern.status).toBe(415);
  });

  it("preserves MCP Apps resources and UI metadata in the modern era", async () => {
    const widgetHtmlPath = writeFixtureWidget("<html><body>modern widget</body></html>");
    const { url } = await startTestApp({ widgetEnabled: true, widgetHtmlPath });
    const client = await modernClient(url);
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(1);
    const read = await client.readResource({ uri: resources[0].uri });
    expect(read.contents[0]).toMatchObject({ text: "<html><body>modern widget</body></html>" });
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "run_task")?._meta).toMatchObject({
      "ui/resourceUri": "ui://clawconnect/task-center-v3.html",
      "openai/outputTemplate": "ui://clawconnect/task-center-v3.html",
    });
  });

  it("applies the existing auth gate to the modern discovery probe and every request", async () => {
    const { url } = await startTestApp({ widgetEnabled: false, authPass: "test-pass" });
    const legacyFailure = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(legacyFailure.status).toBe(403);
    await expect(modernClient(url)).rejects.toMatchObject({
      code: "CLIENT_HTTP_FORBIDDEN",
      data: { status: 403 },
    });
    const client = await modernClient(url, undefined, { Authorization: "Bearer test-pass" });
    await expect(client.listTools()).resolves.toHaveProperty("tools");
  });

  it("isolates tools and calls to the agents selected by the request URL", async () => {
    const registry = fakeRegistry();
    registry.agents.push({
      id: "other-agent",
      url: "ws://127.0.0.1:1",
      password: "x",
      openclawAgentId: "other",
    });
    const { url } = await startTestApp({ widgetEnabled: false, registry });
    const client = await modernClient(`${url}?agent=test-agent`);
    const tools = await client.listTools();
    const runTask = tools.tools.find((tool) => tool.name === "run_task")!;
    expect((runTask.inputSchema.properties as any).agent.enum).toEqual(["test-agent"]);
    const denied = await client.callTool({
      name: "run_task",
      arguments: { task: "should not cross scope", agent: "other-agent" },
    });
    expect(denied.isError).toBe(true);

    const legacyTools = await rpc(`${url}?agent=test-agent`, "tools/list");
    const legacyRunTask = legacyTools.result.tools.find((tool: any) => tool.name === "run_task");
    expect(legacyRunTask.inputSchema.properties.agent.enum).toEqual(["test-agent"]);
    const legacyDenied = await rpc(`${url}?agent=test-agent`, "tools/call", {
      name: "run_task",
      arguments: { task: "should not cross scope", agent: "other-agent" },
    });
    expect(legacyDenied.result.isError).toBe(true);
  });

  it("returns a structured tool error for malformed tool arguments", async () => {
    const { url } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url);
    const result = await client.callTool({ name: "run_task", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("keeps the task pool server-owned across run_task -> check_task -> terminal", async () => {
    const { url, pool } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url);
    const run = await client.callTool({ name: "run_task", arguments: { task: "finish quickly" } });
    const jobId = (run.structuredContent as any).jobId as string;
    const job = pool.forJob(jobId)!.sessions.getJob(jobId)!;
    job.status = "completed";
    job.summary = "finished by the test runtime";
    const checked = await client.callTool({
      name: "check_task",
      arguments: { jobId, mode: "poll", waitMs: 1000 },
    });
    expect((checked.structuredContent as any).jobId).toBe(jobId);
    expect((checked.structuredContent as any).isTerminal).toBe(true);
  });

  it("abandons a cancelled modern check_task wait but leaves its task running", async () => {
    const { url, pool } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url);
    const run = await client.callTool({
      name: "run_task",
      arguments: { task: "continue after the HTTP caller disconnects" },
    });
    const jobId = (run.structuredContent as any).jobId as string;
    const job = pool.forJob(jobId)!.sessions.getJob(jobId)!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    job.status = "running";
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "check_task", arguments: { jobId, mode: "wait", waitMs: 120_000 } },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow(/AbortError/);
    expect(job.status).toBe("running");
  });

  it("preserves isError for a found task that terminates with an error", async () => {
    const { url, pool } = await startTestApp({ widgetEnabled: false });
    const client = await modernClient(url);
    const run = await client.callTool({
      name: "run_task",
      arguments: { task: "fail predictably" },
    });
    const jobId = (run.structuredContent as any).jobId as string;
    const job = pool.forJob(jobId)!.sessions.getJob(jobId)!;
    job.status = "error";
    job.error = "terminal failure from test runtime";
    const result = await client.callTool({ name: "get_task", arguments: { taskId: jobId } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ taskId: jobId, status: "error" });
    const legacyResult = await rpc(url, "tools/call", {
      name: "get_task",
      arguments: { taskId: jobId },
    });
    expect(legacyResult.result).toMatchObject({ isError: true });
  });
});

describe("check_task model-facing text carries the resume cursor", () => {
  function runningSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
    return {
      jobId: "job-1",
      sessionKey: "session-1",
      status: "running",
      execution: "running",
      upstream: "connected",
      transcript: "live",
      cancellation: "none",
      startedAt: 1000,
      lastEventAt: 2000,
      lastPollAt: 3000,
      // Two entries returned but the cursor is 17: the returned-entry count
      // is NOT the cursor, which is exactly the confusion this text prevents.
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
  }

  it("a running response tells the caller which knownLogCount to send back", () => {
    expect(checkTaskText(runningSnapshot(), false)).toBe(
      "Still running. Poll again with knownLogCount=17.",
    );
  });

  it("a late-recovery response carries the cursor too", () => {
    const snapshot = runningSnapshot({
      recovery: { reason: "no_live_final_text", startedAt: 1000, idleTimeoutMs: 1, hardCapMs: 2 },
    });
    expect(checkTaskText(snapshot, false)).toBe(
      "Recovering late transcript final text. Poll again with knownLogCount=17.",
    );
  });

  /**
   * "Still running. Poll again." is true and useless once the delegated
   * session is waiting on a human — polling is exactly what will not move it.
   */
  it("a running response leads with the block when the delegated session is already waiting on a human", () => {
    for (const state of ["needs_input", "needs_permission"] as const) {
      const text = checkTaskText(
        runningSnapshot({
          agentSession: {
            id: "att-1",
            runtime: "example-runtime",
            handle: "thr-abc123",
            attachedAt: 1,
            status: state,
            latestResponse: "should I force-push?",
            remoteUrl: "https://runtime.example/threads/abc123",
            delegatedTurnId: "job-1",
          },
        }),
        false,
      );
      expect(text, state).toContain("example-runtime/thr-abc123");
      expect(text, state).toContain(
        state === "needs_permission" ? "waiting for permission" : "waiting for input",
      );
      expect(text, state).toContain("Polling cannot advance it");
      expect(text, state).not.toContain("Still running.");
      // The resume cursor still has to survive: the caller does poll again,
      // after answering.
      expect(text, state).toContain("knownLogCount=17");
    }
  });

  it("a running response says nothing when the blocked attachment belongs to a different turn", () => {
    const text = checkTaskText(
      runningSnapshot({
        agentSession: {
          id: "att-1",
          runtime: "example-runtime",
          handle: "thr-abc123",
          attachedAt: 1,
          status: "needs_input",
          delegatedTurnId: "job-0",
        },
      }),
      false,
    );
    expect(text).toBe("Still running. Poll again with knownLogCount=17.");
  });

  it("a terminal response is the result itself — no polling instructions appended", () => {
    const text = checkTaskText(
      runningSnapshot({ status: "completed", summary: "the answer" }),
      true,
    );
    expect(text).toBe("the answer");
    expect(text).not.toContain("knownLogCount");
  });

  /**
   * A turn whose delegated session is waiting on a human is terminal for the
   * job and unfinished for the user. Reading back as an ordinary finished task
   * with nothing to say is how the block goes unnoticed.
   */
  it("a terminal response leads with the block when the delegated session is waiting on a human", () => {
    const snapshot = runningSnapshot({
      status: "completed_no_summary",
      summary: "Stream finished with no response collected.",
      agentSession: {
        id: "att-1",
        runtime: "example-runtime",
        handle: "thr-abc123",
        attachedAt: 1,
        status: "needs_input",
        latestResponse: "should I force-push?",
        delegatedTurnId: "job-1",
      },
    });
    const text = checkTaskText(snapshot, true);
    expect(text.startsWith("This turn produced no result")).toBe(true);
    expect(text).toContain("example-runtime/thr-abc123");
    expect(text).toContain("should I force-push?");
    // The job's own summary still follows, never replaced.
    expect(text).toContain("Stream finished with no response collected.");
  });

  it("says nothing extra for an unblocked attachment or another turn's delegation", () => {
    const attachment = {
      id: "att-1",
      runtime: "example-runtime",
      handle: "thr-abc123",
      attachedAt: 1,
      status: "needs_input" as const,
      delegatedTurnId: "job-0",
    };
    expect(
      checkTaskText(
        runningSnapshot({ status: "completed", summary: "the answer", agentSession: attachment }),
        true,
      ),
    ).toBe("the answer");
    expect(
      checkTaskText(
        runningSnapshot({
          status: "completed",
          summary: "the answer",
          agentSession: { ...attachment, status: "running", delegatedTurnId: "job-1" },
        }),
        true,
      ),
    ).toBe("the answer");
  });
});

describe("production entrypoint wiring — agent-session runtimes", () => {
  /**
   * Same failure mode, one layer up: a host's managed-agent-session runtimes
   * are only reachable if the registry actually reaches every agent's
   * SessionManager. Registering a runtime that nothing can dispatch to would
   * look exactly like a working integration until a delegation needed it.
   */
  it("createApp passes a host's agent-session runtime registry through to every agent", () => {
    const jobStoreDir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-"));
    tmpDirs.push(jobStoreDir);
    const runtimes = new AgentSessionRuntimeRegistry();
    runtimes.register({
      id: "example-runtime",
      provider: "anthropic-claude-code",
      inspect: async () => ({ state: "running" }),
    });

    const { pool } = createApp(fakeRegistry(), { jobStoreDir, agentSessionRuntimes: runtimes });
    expect(pool.forAgent("test-agent").sessions.hasAgentSessionRuntime("example-runtime")).toBe(
      true,
    );
  });

  /**
   * The default install registers NOTHING. Core ships no runtime of its own —
   * an entrypoint that quietly constructed one would make that claim false,
   * which is exactly what the built-in tmux adapter did until it moved out to
   * examples/local-tmux-runtime.
   */
  it("createApp registers no runtime at all when no registry is supplied", () => {
    const jobStoreDir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-"));
    tmpDirs.push(jobStoreDir);
    const { pool } = createApp(fakeRegistry(), { jobStoreDir });
    const sessions = pool.forAgent("test-agent").sessions;
    expect(sessions.hasAgentSessionRuntime("example-runtime")).toBe(false);
    expect(sessions.hasAgentSessionRuntime("claude-fleet")).toBe(false);
  });
});
