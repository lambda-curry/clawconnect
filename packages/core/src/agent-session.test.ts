import { describe, expect, it } from "vitest";
import {
  AgentSessionRuntimeRegistry,
  dispatchAgentSession,
  isBlockedAgentSessionState,
  isCompletedTurnState,
  normalizeAgentSessionObservation,
  type AgentSessionObservation,
  type AgentSessionRef,
} from "./agent-session.ts";

/**
 * The provider-neutral runtime seam: what a host registers, what it is allowed
 * to hand back, and what that becomes. Every rule enforced here is enforced
 * ONCE for every runtime — a host that forwards its own CLI's JSON should not
 * have to learn ClawConnect's exact types to be safe.
 */

const REF: AgentSessionRef = {
  runtime: "t3-fleet",
  provider: "anthropic-claude-code",
  sessionId: "thr-abc123",
  host: "minip3",
  metadata: { t3ProjectId: "proj-1" },
  lastKnownState: "running",
};

const NOW = 1_800_000_000_000;

function normalize(observation: AgentSessionObservation, ref: AgentSessionRef = REF) {
  return normalizeAgentSessionObservation(ref, observation, NOW);
}

describe("normalizing what a runtime reports", () => {
  it("takes identity from the attachment, never from the reply", () => {
    const status = normalize({
      state: "running",
      // A runtime answering with a DIFFERENT session would otherwise silently
      // re-point the conversation's one attachment.
      ...({ runtime: "evil-runtime", sessionId: "thr-someone-elses" } as AgentSessionObservation),
    });
    expect(status.runtime).toBe("t3-fleet");
    expect(status.sessionId).toBe("thr-abc123");
    expect(status.provider).toBe("anthropic-claude-code");
  });

  it("closes the state vocabulary — an unrecognized state reads unknown", () => {
    expect(normalize({ state: "wedged-somehow" }).state).toBe("unknown");
    expect(normalize({}).state).toBe("unknown");
    expect(normalize({ state: "needs_permission" }).state).toBe("needs_permission");
  });

  it("populates finalResponse ONLY for a genuinely completed turn", () => {
    // T3's terminal success, and claude-fleet's — both mean "the turn landed".
    expect(normalize({ state: "completed", latestResponse: "the answer" }).finalResponse).toBe("the answer");
    expect(normalize({ state: "idle", latestResponse: "the answer" }).finalResponse).toBe("the answer");

    // A partial answer from a session that is still working, or blocked on a
    // human, must never be mistakable for the turn's result — even when the
    // runtime itself volunteers finalResponse.
    for (const state of ["running", "needs_input", "needs_permission", "starting", "stale"]) {
      const status = normalize({ state, latestResponse: "half a thought", finalResponse: "half a thought" });
      expect(status.finalResponse, state).toBeUndefined();
      expect(status.latestResponse, state).toBe("half a thought");
    }
  });

  it("emits termination only for terminal states, deriving the reason when the runtime didn't say", () => {
    expect(normalize({ state: "running", termination: { reason: "completed" } }).termination).toBeUndefined();
    expect(normalize({ state: "completed" }).termination).toMatchObject({ reason: "completed" });
    expect(normalize({ state: "dead" }).termination).toMatchObject({ reason: "died" });
    expect(normalize({ state: "failed" }).termination).toMatchObject({ reason: "failed" });
    // A cancelled session is `dead` + reason "cancelled" — no separate state,
    // so every consumer that already branches on terminal keeps working.
    expect(normalize({ state: "dead", termination: { reason: "cancelled", exitCode: 130 } }).termination).toMatchObject({
      reason: "cancelled",
      exitCode: 130,
    });
    // An unrecognized reason falls back to the derived one rather than passing through.
    expect(normalize({ state: "dead", termination: { reason: "vibes" } }).termination?.reason).toBe("died");
  });

  it("accepts timestamps as epoch ms or ISO strings", () => {
    const iso = normalize({ state: "running", startedAt: "2026-08-03T12:00:00.000Z", lastEventAt: "2026-08-03T12:05:00.000Z" });
    expect(iso.startedAt).toBe(Date.parse("2026-08-03T12:00:00.000Z"));
    expect(iso.lastEventAt).toBe(Date.parse("2026-08-03T12:05:00.000Z"));

    const epoch = normalize({ state: "running", startedAt: 1_700_000_000_000 });
    expect(epoch.startedAt).toBe(1_700_000_000_000);

    // Unparseable is dropped, never fabricated — session.ts's freshness bound
    // depends on a real timestamp meaning a real one.
    expect(normalize({ state: "running", lastEventAt: "sometime tuesday" }).lastEventAt).toBeUndefined();
  });

  it("merges strings-only metadata over the ref's, coercing finite scalars", () => {
    const status = normalize({ state: "running", metadata: { turnId: "t-9", attempt: 2, isolated: true, junk: { a: 1 } } });
    expect(status.metadata).toEqual({ t3ProjectId: "proj-1", turnId: "t-9", attempt: "2", isolated: "true" });
  });

  it("keeps a read failure separate from the session's own failure", () => {
    const status = normalize({ state: "unavailable", error: "the T3 endpoint refused the connection" });
    expect(status.error).toEqual({ code: "runtime_error", message: "the T3 endpoint refused the connection" });
    expect(status.state).toBe("unavailable");
  });
});

describe("capabilities and dispatch", () => {
  it("derives capabilities from the callbacks actually supplied", () => {
    const registry = new AgentSessionRuntimeRegistry();
    const readOnly = registry.register({ id: "t3-fleet", provider: "p", inspect: async () => ({ state: "running" }) });
    expect(readOnly.capabilities).toEqual({ inspect: true, continue: false, detach: false });

    const full = registry.register({
      id: "t3-full",
      provider: "p",
      inspect: async () => ({ state: "running" }),
      continue: async () => ({ state: "running" }),
      detach: async () => ({ state: "dead" }),
    });
    expect(full.capabilities).toEqual({ inspect: true, continue: true, detach: true });
  });

  it("rejects a malformed runtime id at registration — a wiring bug, not a runtime condition", () => {
    const registry = new AgentSessionRuntimeRegistry();
    expect(() => registry.register({ id: "../etc", provider: "p", inspect: async () => ({}) })).toThrow(/invalid runtime id/);
  });

  it("returns a precise unknown_runtime result instead of throwing", async () => {
    const status = await dispatchAgentSession(undefined, REF, { op: "inspect" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error?.code).toBe("unknown_runtime");
    // The last thing anyone reported survives the failed read — the difference
    // between "we know nothing" and "last we heard, it was still running".
    expect(status.detail).toContain("Last reported state: running.");
  });

  it("returns unsupported_operation for a capability the runtime never registered", async () => {
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({ id: "t3-fleet", provider: "p", inspect: async () => ({ state: "running" }) });

    const status = await dispatchAgentSession(runtime, REF, { op: "continue", prompt: "keep going" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error?.code).toBe("unsupported_operation");
    expect(status.error?.message).toContain("does not support continue");
  });

  it("turns a thrown callback into a branchable status, never a rejection", async () => {
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "t3-fleet",
      provider: "p",
      inspect: async () => {
        throw new Error("socket hang up");
      },
    });

    const status = await dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error).toEqual({ code: "inspect_failed", message: "socket hang up" });
  });

  it("treats a null reply as session_not_found rather than as a failed session", async () => {
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({ id: "t3-fleet", provider: "p", inspect: async () => null });

    const status = await dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error?.code).toBe("session_not_found");
  });

  it("hands the callback the neutral ref and the caller's clock — and asks about exactly one session", async () => {
    const seen: AgentSessionRef[] = [];
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "t3-fleet",
      provider: "p",
      inspect: async (ref, opts) => {
        seen.push(ref);
        expect(opts.now).toBe(NOW);
        return { state: "running" };
      },
    });

    await dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW });
    expect(seen).toEqual([REF]);
  });

  it("routes continue and detach to their own callbacks, with the request attached", async () => {
    const calls: string[] = [];
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "t3-fleet",
      provider: "p",
      inspect: async () => ({ state: "running" }),
      continue: async (_ref, request) => {
        calls.push(`continue:${request.prompt}`);
        return { state: "running" };
      },
      detach: async (_ref, request) => {
        calls.push(`detach:${request.reason}`);
        return { state: "dead", termination: { reason: "cancelled" } };
      },
    });

    await dispatchAgentSession(runtime, REF, { op: "continue", prompt: "also update the docs" }, { now: NOW });
    const detached = await dispatchAgentSession(runtime, REF, { op: "detach", reason: "user cancelled" }, { now: NOW });

    expect(calls).toEqual(["continue:also update the docs", "detach:user cancelled"]);
    expect(detached.termination).toMatchObject({ reason: "cancelled" });
  });

  it("exposes registered runtime IDS and nothing else — there is no session-enumerating callback", () => {
    const registry = new AgentSessionRuntimeRegistry();
    registry.register({ id: "t3-fleet", provider: "p", inspect: async () => ({}) });
    expect(registry.ids()).toEqual(["t3-fleet"]);
    expect(registry.has("t3-fleet")).toBe(true);
    expect(registry.has("nope")).toBe(false);
    // The shape of the seam is the guarantee: the only way to reach a runtime
    // is one call about one already-known session.
    expect(Object.keys(registry.get("t3-fleet")!.callbacks).sort()).toEqual(["id", "inspect", "provider"]);
  });
});

describe("state predicates", () => {
  it("knows the two terminal-success vocabularies and the two blocked ones", () => {
    expect(isCompletedTurnState("completed")).toBe(true);
    expect(isCompletedTurnState("idle")).toBe(true);
    expect(isCompletedTurnState("running")).toBe(false);
    expect(isCompletedTurnState("dead")).toBe(false);

    expect(isBlockedAgentSessionState("needs_input")).toBe(true);
    expect(isBlockedAgentSessionState("needs_permission")).toBe(true);
    expect(isBlockedAgentSessionState("running")).toBe(false);
    expect(isBlockedAgentSessionState(undefined)).toBe(false);
  });
});
