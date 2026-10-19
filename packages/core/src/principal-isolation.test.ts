import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPool, principalNamespace, type HumanPrincipal } from "./gateway-pool.ts";
import { buildCapabilities, type Identity } from "./capability.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { GatewayConfig } from "./types.ts";
import {
  cancelTask,
  checkTask,
  getSession,
  getTask,
  getTaskPrompt,
  listSessions,
  listTasks,
  runTask,
} from "./tools.ts";

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{
    config: GatewayConfig;
    chat: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    resumeTranscript: ReturnType<typeof vi.fn>;
    pollTranscriptForFinalText: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("./gateway.ts", () => ({
  OpenClawGateway: class {
    constructor(config: GatewayConfig) {
      const gateway = {
        config,
        chat: vi.fn(() => new Promise<string>(() => {})),
        close: vi.fn(),
        resumeTranscript: vi.fn(),
        pollTranscriptForFinalText: vi.fn(() => new Promise<string>(() => {})),
      };
      mocks.connections.push(gateway);
      return gateway;
    }
  },
}));

const alice: HumanPrincipal = { principalId: "p-alice", loginEmail: "alice@example.test" };
const bob: HumanPrincipal = { principalId: "p-bob", loginEmail: "bob@example.test" };
const registry: AgentRegistry = {
  default: "assistant",
  source: "env",
  groups: {},
  groupLabels: {},
  agents: [
    {
      id: "assistant",
      url: "ws://example.test",
      password: "fixture",
      openclawAgentId: "main",
      qmdToken: "fixture-qmd",
      collections: ["documents", "conversation-transcripts"],
    },
  ],
};
const pools: GatewayPool[] = [];
const dirs: string[] = [];
function pool(dir?: string, timeout = 300_000) {
  const value = new GatewayPool(registry, dir, undefined, undefined, {
    principalIdleTimeoutMs: timeout,
  });
  pools.push(value);
  return value;
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-principals-"));
  dirs.push(dir);
  return dir;
}
function capabilities(value: GatewayPool, identity: Identity) {
  const tools = buildCapabilities({
    pool: value,
    registry,
    identity,
    scope: { allowedIds: ["assistant"], defaultId: "assistant", serverName: "ClawConnect" },
    defaultCheckMode: "poll",
    protocol: () => ({ era: "modern" }),
  });
  return (name: string, args: Record<string, unknown> = {}) =>
    tools.find((tool) => tool.name === name)!.handler(args);
}
afterEach(() => {
  for (const value of pools.splice(0)) value.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mocks.connections.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("principal ownership", () => {
  it("routes separate immutable headers and sockets without changing the service entry", () => {
    const value = pool();
    const service = value.forAgent();
    const serviceConfig = structuredClone(mocks.connections[0].config);
    const a = value.forPrincipal(alice).forAgent();
    const b = value.forPrincipal(bob).forAgent();
    expect(a.gateway).not.toBe(b.gateway);
    expect(a.gateway).not.toBe(service.gateway);
    for (const [index, principal] of [alice, bob].entries()) {
      expect(mocks.connections[index + 1].config.headers).toMatchObject({
        "cf-access-authenticated-user-email": principal.loginEmail,
        "cf-access-jwt-assertion": "private-network",
        "x-forwarded-for": "192.0.2.1",
      });
    }
    expect(value.forAgent()).toBe(service);
    expect(mocks.connections[0].config).toEqual(serviceConfig);
    expect(value.forPrincipal({ ...alice }).forAgent()).toBe(a);
    expect(() => value.forPrincipal({ ...alice, loginEmail: bob.loginEmail }).forAgent()).toThrow(
      /binding/,
    );
  });

  it("hides copied IDs and session keys on every read, continue and cancellation path", async () => {
    const value = pool();
    const a = value.forPrincipal(alice);
    const b = value.forPrincipal(bob);
    const run = runTask(a, { task: "private task" });
    const otherRun = runTask(b, { task: "other task" });
    for (const outsider of [b, value.forPrincipal()]) {
      expect(getTask(outsider, { jobId: run.jobId })).toEqual({ found: false });
      expect(getTaskPrompt(outsider, { jobId: run.jobId })).toEqual({ found: false });
      expect(await checkTask(outsider, { jobId: run.jobId, sessionKey: run.sessionKey })).toEqual({
        found: false,
      });
      expect(
        getSession(outsider, { sessionId: run.sessionKey, agent: "assistant", mode: "tail" }),
      ).toEqual({ found: false });
      expect(await cancelTask(outsider, { sessionKey: run.sessionKey })).toEqual({ found: false });
      expect(await cancelTask(outsider, { jobId: run.jobId })).toEqual({ found: false });
      expect(() => runTask(outsider, { task: "continue", sessionKey: run.sessionKey })).toThrow(
        "Session not found.",
      );
      expect(listTasks(outsider).map((task) => task.jobId)).not.toContain(run.jobId);
      expect(listSessions(outsider).map((session) => session.sessionKey)).not.toContain(
        run.sessionKey,
      );
    }
    expect(getTask(b, { jobId: run.jobId, sessionKey: otherRun.sessionKey })).toEqual({
      found: false,
    });
    expect(getTask(a, { jobId: run.jobId }).found).toBe(true);
    expect(mocks.connections[0].chat).toHaveBeenCalledTimes(1);
    expect(mocks.connections[1].chat).toHaveBeenCalledTimes(1);
    // Nothing rejected above subscribed to or fetched another person's transcript.
    expect(
      mocks.connections.every((connection) => connection.resumeTranscript.mock.calls.length === 0),
    ).toBe(true);
  });

  it("uses authenticated ownership even if senderName claims another person", async () => {
    const value = pool();
    const invoke = capabilities(value, { user: "Alice", principal: alice });
    const result = await invoke("run_task", { task: "a task", senderName: "Bob" });
    const run = result.structuredContent as { jobId: string };
    const a = value.forPrincipal(alice);
    expect(getTaskPrompt(a, { jobId: run.jobId })).toMatchObject({
      found: true,
      prompt: { senderName: "Alice" },
    });
    expect(mocks.connections[0].config.headers?.["cf-access-authenticated-user-email"]).toBe(
      alice.loginEmail,
    );
    const bobTools = capabilities(value, { user: "Bob", principal: bob });
    expect(await bobTools("get_task", { taskId: run.jobId })).toMatchObject({ isError: true });
    expect(
      await bobTools("get_session", {
        sessionId: a.forJob(run.jobId)!.sessions.getJob(run.jobId)!.sessionKey,
      }),
    ).toMatchObject({ structuredContent: { found: false } });
    expect(await bobTools("list_tasks")).toMatchObject({ structuredContent: { tasks: [] } });
  });

  it("withholds all QMD access from personal principals, retaining legacy service access", async () => {
    const value = pool();
    const fetcher = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetcher);
    const personal = capabilities(value, { user: "Alice", principal: alice });
    expect(await personal("search_memory", { query: "private" })).toMatchObject({
      structuredContent: { hits: [] },
    });
    expect(
      await personal("get_memory", { file: "qmd://conversation-transcripts/private.md" }),
    ).toMatchObject({ structuredContent: { found: false } });
    expect(await personal("list_collections")).toMatchObject({
      structuredContent: { collections: [] },
    });
    expect(fetcher).not.toHaveBeenCalled();
    const legacy = capabilities(value, { user: "Legacy" });
    await legacy("search_memory", { query: "docs" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("persists jobs and attachments under stable hashes, recovers with owner credentials and leaves shared files alone", () => {
    const dir = scratch();
    const value = pool(dir);
    const credentials = { ...alice, token: "fixture-personal-token" };
    const a = value.forPrincipal(credentials);
    const run = runTask(a, {
      task: "recover me",
      context:
        '[[clawconnect:agent-session]]{"op":"attach","runtime":"example-runtime","handle":"session-1","host":"workstation-1"}[[/clawconnect:agent-session]]',
    });
    runTask(value, { task: "service work" });
    const originalAttachment = a.forAgent().sessions.getAgentSessionAttachment(run.sessionKey);
    expect(originalAttachment?.handle).toBe("session-1");
    const namespace = join(dir, "principals", principalNamespace(alice.principalId));
    const files = readdirSync(namespace);
    expect(files).toContain("principal.json");
    expect(JSON.parse(readFileSync(join(namespace, "principal.json"), "utf8"))).toEqual(alice);
    expect(JSON.parse(readFileSync(join(namespace, "assistant.json"), "utf8"))).toMatchObject([
      { jobId: run.jobId },
    ]);
    expect(files).toContain("assistant.attachments.json");
    const oldShared = readFileSync(join(dir, "assistant.json"), "utf8");
    const next = pool(dir);
    next.warmAll();
    const reloaded = next.forPrincipal(alice);
    expect(getTask(reloaded, { jobId: run.jobId }).found).toBe(true);
    expect(getTask(next, { jobId: run.jobId })).toEqual({ found: false });
    const personalGateway = mocks.connections.findLast(
      (connection) =>
        connection.config.headers?.["cf-access-authenticated-user-email"] === alice.loginEmail,
    )!;
    expect(personalGateway.resumeTranscript).toHaveBeenCalledWith(
      run.sessionKey,
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(personalGateway.pollTranscriptForFinalText).toHaveBeenCalled();
    const serviceGateway = mocks.connections.findLast(
      (connection) => !connection.config.headers?.["cf-access-authenticated-user-email"],
    );
    expect(serviceGateway?.resumeTranscript.mock.calls.flat()).not.toContain(run.sessionKey);
    expect(readFileSync(join(dir, "assistant.json"), "utf8")).toBe(oldShared);
    expect(reloaded.forAgent().sessions.getAgentSessionAttachment(run.sessionKey)).toEqual(
      originalAttachment,
    );
    expect(next.forAgent().sessions.getAgentSessionAttachment(run.sessionKey)).toBeUndefined();
    expect(
      next.forPrincipal(bob).forAgent().sessions.getAgentSessionAttachment(run.sessionKey),
    ).toBeUndefined();
    expect(listTasks(next.forPrincipal(bob))).toEqual([]);
  });

  it("keeps degraded store diagnostics inside the owning namespace", () => {
    const dir = scratch();
    const initial = pool(dir);
    initial.forPrincipal(alice).forAgent();
    const path = join(
      dir,
      "principals",
      principalNamespace(alice.principalId),
      "assistant.attachments.json",
    );
    writeFileSync(path, "invalid");
    const next = pool(dir);
    next.warmAll();
    expect(next.forPrincipal(alice).storeHealth()).toHaveLength(1);
    expect(next.forPrincipal(bob).storeHealth()).toEqual([]);
    expect(next.storeHealth()).toEqual([]);
  });

  it("never recovers an unreadable personal binding through the service gateway", () => {
    const dir = scratch();
    const original = pool(dir);
    const run = runTask(original.forPrincipal(alice), { task: "private" });
    writeFileSync(
      join(dir, "principals", principalNamespace(alice.principalId), "principal.json"),
      "invalid",
    );
    const next = pool(dir);
    next.warmAll();
    expect(next.allPrincipalEntries()).toHaveLength(1);
    expect(getTask(next, { jobId: run.jobId })).toEqual({ found: false });
  });

  it("closes idle personal sockets, preserves active work and service sockets, then allows reuse", async () => {
    vi.useFakeTimers();
    const value = pool(undefined, 1_000);
    const service = value.forAgent();
    const a = value.forPrincipal(alice).forAgent();
    const b = value.forPrincipal(bob);
    const run = runTask(b, { task: "active" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.connections[1].close).toHaveBeenCalledTimes(1);
    expect(mocks.connections[0].close).not.toHaveBeenCalled();
    expect(mocks.connections[2].close).not.toHaveBeenCalled();
    expect(value.forAgent()).toBe(service);
    expect(value.forPrincipal(alice).forAgent()).toBe(a);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.connections[1].close).toHaveBeenCalledTimes(2);
    b.forJob(run.jobId)!.sessions.getJob(run.jobId)!.status = "completed";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.connections[2].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const timerCount = vi.getTimerCount();
    value.closeAll();
    expect(vi.getTimerCount()).toBe(timerCount - 1);
  });
});
