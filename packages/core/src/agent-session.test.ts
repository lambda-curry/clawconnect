import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionRuntimeRegistry,
  blockedDelegation,
  blockedDelegationNotice,
  delegateBlockedTerminalReason,
  describeActiveBlockedAgentSession,
  describeBlockedAgentSession,
  dispatchAgentSession,
  isAgentSessionTimeout,
  isBlockedAgentSessionState,
  isCompletedTurnState,
  isDelegateBlockedTerminalReason,
  normalizeAgentSessionObservation,
  withAgentSessionTimeout,
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
  runtime: "example-runtime",
  provider: "anthropic-claude-code",
  sessionId: "thr-abc123",
  host: "workstation-1",
  metadata: { runtimeProjectId: "proj-1" },
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
    expect(status.runtime).toBe("example-runtime");
    expect(status.sessionId).toBe("thr-abc123");
    expect(status.provider).toBe("anthropic-claude-code");
  });

  it("closes the state vocabulary — an unrecognized state reads unknown", () => {
    expect(normalize({ state: "wedged-somehow" }).state).toBe("unknown");
    expect(normalize({}).state).toBe("unknown");
    expect(normalize({ state: "needs_permission" }).state).toBe("needs_permission");
  });

  it("populates finalResponse ONLY for a genuinely completed turn", () => {
    // A service runtime's terminal success, and claude-fleet's — both mean "the turn landed".
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
    expect(status.metadata).toEqual({ runtimeProjectId: "proj-1", turnId: "t-9", attempt: "2", isolated: "true" });
  });

  it("keeps a read failure separate from the session's own failure", () => {
    const status = normalize({ state: "unavailable", error: "the runtime endpoint refused the connection" });
    expect(status.error).toEqual({ code: "runtime_error", message: "the runtime endpoint refused the connection" });
    expect(status.state).toBe("unavailable");
  });
});

describe("capabilities and dispatch", () => {
  it("derives capabilities from the callbacks actually supplied", () => {
    const registry = new AgentSessionRuntimeRegistry();
    const readOnly = registry.register({ id: "example-runtime", provider: "p", inspect: async () => ({ state: "running" }) });
    expect(readOnly.capabilities).toEqual({ inspect: true, continue: false, detach: false });

    const full = registry.register({
      id: "example-full",
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
    const runtime = registry.register({ id: "example-runtime", provider: "p", inspect: async () => ({ state: "running" }) });

    const status = await dispatchAgentSession(runtime, REF, { op: "continue", prompt: "keep going" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error?.code).toBe("unsupported_operation");
    expect(status.error?.message).toContain("does not support continue");
  });

  it("turns a thrown callback into a branchable status, never a rejection", async () => {
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "example-runtime",
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
    const runtime = registry.register({ id: "example-runtime", provider: "p", inspect: async () => null });

    const status = await dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.error?.code).toBe("session_not_found");
  });

  it("hands the callback the neutral ref and the caller's clock — and asks about exactly one session", async () => {
    const seen: AgentSessionRef[] = [];
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "example-runtime",
      provider: "p",
      inspect: async (ref, opts) => {
        seen.push(ref);
        expect(opts.now).toBe(NOW);
        return { state: "running" };
      },
    });

    await dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW });
    // Everything the caller supplied, with the runtime's own provider bound
    // onto it — see the provider-authority tests below.
    expect(seen).toEqual([{ ...REF, provider: "p" }]);
  });

  it("routes continue and detach to their own callbacks, with the request attached", async () => {
    const calls: string[] = [];
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "example-runtime",
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
    registry.register({ id: "example-runtime", provider: "p", inspect: async () => ({}) });
    expect(registry.ids()).toEqual(["example-runtime"]);
    expect(registry.has("example-runtime")).toBe(true);
    expect(registry.has("nope")).toBe(false);
    // The shape of the seam is the guarantee: the only way to reach a runtime
    // is one call about one already-known session.
    expect(Object.keys(registry.get("example-runtime")!.callbacks).sort()).toEqual(["id", "inspect", "provider"]);
  });
});

describe("the registered runtime's provider is authoritative", () => {
  it("cannot be spoofed by attachment text, and cannot be erased by omitting it", async () => {
    const seen: AgentSessionRef[] = [];
    const registry = new AgentSessionRuntimeRegistry();
    const runtime = registry.register({
      id: "example-runtime",
      provider: "anthropic-claude-code",
      inspect: async (ref) => {
        seen.push(ref);
        // A reply cannot restate identity at all — provider included.
        return { state: "running", ...({ provider: "sneaky-provider" } as AgentSessionObservation) };
      },
    });

    // An attachment whose text claimed some other provider…
    const spoofed = await dispatchAgentSession(
      runtime,
      { ...REF, provider: "totally-not-claude" },
      { op: "inspect" },
      { now: NOW },
    );
    // …and one that named none at all.
    const silent = await dispatchAgentSession(runtime, { ...REF, provider: undefined }, { op: "inspect" }, { now: NOW });

    expect(seen.map((r) => r.provider)).toEqual(["anthropic-claude-code", "anthropic-claude-code"]);
    expect(spoofed.provider).toBe("anthropic-claude-code");
    expect(silent.provider).toBe("anthropic-claude-code");
  });

  it("leaves the attachment's own provider alone when no runtime can answer", async () => {
    const status = await dispatchAgentSession(undefined, { ...REF, provider: "whatever-it-said" }, { op: "inspect" }, { now: NOW });
    expect(status.state).toBe("unavailable");
    expect(status.provider).toBe("whatever-it-said");
  });
});

describe("a callback that never answers", () => {
  /**
   * A hung callback is host code reaching a service ClawConnect knows nothing
   * about. Terminal recovery AWAITS that call, so without a deadline one
   * unanswered inspect wedges a job out of ever reaching a terminal status.
   */
  it("is abandoned at the deadline as an ordinary unavailable read, and is told it was abandoned", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const registry = new AgentSessionRuntimeRegistry();
      const runtime = registry.register({
        id: "example-runtime",
        provider: "p",
        inspect: (_ref, opts) => {
          seenSignal = opts.signal;
          return new Promise<never>(() => {});
        },
      });

      const pending = dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(seenSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      const status = await pending;

      expect(status.state).toBe("unavailable");
      expect(status.error?.code).toBe("inspect_timeout");
      // The last thing anyone actually reported still rides along.
      expect(status.detail).toContain("Last reported state: running.");
      // A runtime that honors the signal can stop work nobody will read.
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the operation that timed out, so a caller can branch on which one", async () => {
    vi.useFakeTimers();
    try {
      const registry = new AgentSessionRuntimeRegistry();
      const runtime = registry.register({
        id: "example-runtime",
        provider: "p",
        inspect: async () => ({ state: "running" }),
        continue: () => new Promise<never>(() => {}),
      });
      const pending = dispatchAgentSession(runtime, REF, { op: "continue", prompt: "go" }, { now: NOW, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      expect((await pending).error?.code).toBe("continue_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still returns the answer when it arrives inside the deadline", async () => {
    vi.useFakeTimers();
    try {
      const registry = new AgentSessionRuntimeRegistry();
      const runtime = registry.register({
        id: "example-runtime",
        provider: "p",
        inspect: () => new Promise((resolve) => setTimeout(() => resolve({ state: "idle" }), 500)),
      });
      const pending = dispatchAgentSession(runtime, REF, { op: "inspect" }, { now: NOW, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(600);
      expect((await pending).state).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("withAgentSessionTimeout aborts the operation and rejects, identifiably", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const pending = withAgentSessionTimeout((signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<never>(() => {});
      }, 1_000).catch((err) => err);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(isAgentSessionTimeout(await pending)).toBe(true);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a blocked delegation is never an ordinary finished task", () => {
  const blockedSnapshot = {
    jobId: "job-1",
    status: "completed_no_summary",
    fleetAttachment: {
      runtime: "example-runtime",
      handle: "thr-abc123",
      status: "needs_input",
      latestResponse: "should I force-push?",
      remoteUrl: "https://runtime.example/threads/abc123",
      delegatedTurnId: "job-1",
    },
  };

  it("describes what is blocked, what it asked, and where to answer it", () => {
    const notice = blockedDelegationNotice(blockedSnapshot)!;
    expect(notice).toContain("example-runtime/thr-abc123");
    expect(notice).toContain("waiting for input");
    expect(notice).toContain("should I force-push?");
    expect(notice).toContain("https://runtime.example/threads/abc123");

    expect(describeBlockedAgentSession({ ...blockedSnapshot.fleetAttachment, status: "needs_permission" })).toContain(
      "waiting for permission",
    );
  });

  it("says nothing for a running job, an unblocked session, or another turn's delegation", () => {
    expect(blockedDelegationNotice({ ...blockedSnapshot, status: "running" })).toBeUndefined();
    expect(
      blockedDelegationNotice({
        ...blockedSnapshot,
        fleetAttachment: { ...blockedSnapshot.fleetAttachment, status: "running" },
      }),
    ).toBeUndefined();
    // Delegated to an earlier turn: it says nothing about THIS one.
    expect(
      blockedDelegationNotice({
        ...blockedSnapshot,
        fleetAttachment: { ...blockedSnapshot.fleetAttachment, delegatedTurnId: "job-0" },
      }),
    ).toBeUndefined();
    expect(blockedDelegationNotice({ jobId: "job-1", status: "completed" })).toBeUndefined();
  });

  it("round-trips the state through the terminalReason a job carries", () => {
    expect(delegateBlockedTerminalReason("needs_input")).toBe("delegate-blocked:needs_input");
    expect(isDelegateBlockedTerminalReason("delegate-blocked:needs_permission")).toBe(true);
    expect(isDelegateBlockedTerminalReason("late-recovery-exhausted")).toBe(false);
    expect(isDelegateBlockedTerminalReason(undefined)).toBe(false);
  });
});

/**
 * The child blocks long before the parent turn ends, so the window in which a
 * delegation is blocked AND the parent job is still "running" is the normal
 * case, not an edge one. A projection that only spoke at terminal left every
 * surface saying "running" while a human was being waited on.
 */
describe("an ACTIVE blocked delegation on a still-running turn", () => {
  const activeSnapshot = {
    jobId: "job-1",
    status: "running",
    fleetAttachment: {
      runtime: "example-runtime",
      handle: "thr-abc123",
      status: "needs_input",
      latestResponse: "should I force-push?",
      remoteUrl: "https://runtime.example/threads/abc123",
      delegatedTurnId: "job-1",
    },
  };

  it("projects the block, its kind, and where to answer it while the job is still running", () => {
    const blocked = blockedDelegation(activeSnapshot)!;
    expect(blocked.active).toBe(true);
    expect(blocked.state).toBe("needs_input");
    expect(blocked.runtime).toBe("example-runtime");
    expect(blocked.handle).toBe("thr-abc123");
    expect(blocked.remoteUrl).toBe("https://runtime.example/threads/abc123");
    expect(blocked.notice).toContain("example-runtime/thr-abc123");
    expect(blocked.notice).toContain("waiting for input");
    expect(blocked.notice).toContain("should I force-push?");
    // The one thing the active wording must add over the terminal one: the
    // caller is mid-poll, and polling is exactly what will not help.
    expect(blocked.notice).toContain("Polling cannot advance it");
  });

  it("distinguishes a permission prompt from a question", () => {
    const blocked = blockedDelegation({
      ...activeSnapshot,
      fleetAttachment: { ...activeSnapshot.fleetAttachment, status: "needs_permission" },
    })!;
    expect(blocked.state).toBe("needs_permission");
    expect(blocked.notice).toContain("waiting for permission");
    expect(blocked.notice).not.toContain("waiting for input");
  });

  it("says nothing about a turn that did not delegate to this attachment, or one that is not blocked", () => {
    expect(
      blockedDelegation({
        ...activeSnapshot,
        fleetAttachment: { ...activeSnapshot.fleetAttachment, delegatedTurnId: "job-0" },
      }),
    ).toBeUndefined();
    expect(
      blockedDelegation({
        ...activeSnapshot,
        fleetAttachment: { ...activeSnapshot.fleetAttachment, status: "running" },
      }),
    ).toBeUndefined();
    expect(blockedDelegation({ jobId: "job-1", status: "running" })).toBeUndefined();
  });

  it("reads as terminal, with the terminal wording, once the job has ended", () => {
    const blocked = blockedDelegation({ ...activeSnapshot, status: "completed_no_summary" })!;
    expect(blocked.active).toBe(false);
    expect(blocked.notice).toBe(describeBlockedAgentSession(activeSnapshot.fleetAttachment));
    expect(blocked.notice).toContain("the task is not finished");
    // blockedDelegationNotice stays the TERMINAL-only accessor, so the
    // transports' terminal branches are untouched by any of this.
    expect(blockedDelegationNotice(activeSnapshot)).toBeUndefined();
    expect(blockedDelegationNotice({ ...activeSnapshot, status: "completed_no_summary" })).toBe(blocked.notice);
  });

  it("describes an active block only for a genuinely blocked attachment", () => {
    expect(describeActiveBlockedAgentSession(undefined)).toBeUndefined();
    expect(
      describeActiveBlockedAgentSession({ runtime: "example-runtime", handle: "thr-1", status: "running" }),
    ).toBeUndefined();
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
