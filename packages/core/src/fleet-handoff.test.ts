import { describe, expect, it } from "vitest";
import { parseAgentSessionMarker, parseFleetDirective, parseSessionHandoff } from "./fleet-handoff.ts";

function block(obj: unknown): string {
  return `[[clawconnect:fleet]]${JSON.stringify(obj)}[[/clawconnect:fleet]]`;
}

function marker(obj: unknown): string {
  return `<agent-session>${JSON.stringify(obj)}</agent-session>`;
}

describe("parseFleetDirective", () => {
  it("returns undefined for text with no directive block", () => {
    expect(parseFleetDirective(undefined)).toBeUndefined();
    expect(parseFleetDirective("")).toBeUndefined();
    expect(parseFleetDirective("plain context, nothing structured here")).toBeUndefined();
  });

  it("parses an attach directive and strips it from the text", () => {
    const before = "Some preamble.\n\n";
    const after = "\n\nMore instructions.";
    const text = before + block({ op: "attach", handle: "cf-foo", host: "minip3", providerSessionId: "prov-1", worktree: "/w" }) + after;
    const result = parseFleetDirective(text);
    expect(result).toBeDefined();
    expect(result?.directive).toEqual({
      op: "attach",
      handle: "cf-foo",
      host: "minip3",
      providerSessionId: "prov-1",
      worktree: "/w",
      remoteUrl: undefined,
    });
    expect(result?.strippedText).toBe("Some preamble.\n\n\n\nMore instructions.");
    expect(result?.strippedText).not.toContain("clawconnect:fleet");
  });

  it("parses a replace directive requiring a reason", () => {
    const withReason = parseFleetDirective(block({ op: "replace", handle: "cf-bar", host: "minip3", reason: "stale worktree" }));
    expect(withReason?.directive).toMatchObject({ op: "replace", handle: "cf-bar", reason: "stale worktree" });

    const withoutReason = parseFleetDirective(block({ op: "replace", handle: "cf-bar", host: "minip3" }));
    expect(withoutReason).toBeUndefined();
  });

  it("parses continue, detach (with reason), and inspect", () => {
    expect(parseFleetDirective(block({ op: "continue" }))?.directive).toEqual({ op: "continue" });
    expect(parseFleetDirective(block({ op: "detach", reason: "task finished" }))?.directive).toEqual({
      op: "detach",
      reason: "task finished",
    });
    expect(parseFleetDirective(block({ op: "detach" }))).toBeUndefined();
    expect(parseFleetDirective(block({ op: "inspect" }))?.directive).toEqual({ op: "inspect" });
  });

  it("rejects an unknown op", () => {
    expect(parseFleetDirective(block({ op: "delete-everything", handle: "cf-foo", host: "minip3" }))).toBeUndefined();
  });

  it("rejects malformed JSON inside the block without throwing", () => {
    const text = "[[clawconnect:fleet]]{ not valid json[[/clawconnect:fleet]]";
    expect(() => parseFleetDirective(text)).not.toThrow();
    expect(parseFleetDirective(text)).toBeUndefined();
  });

  it("rejects a handle that isn't a safe path segment (path traversal defense)", () => {
    for (const handle of ["../../etc/passwd", "/etc/passwd", "cf foo", "cf/foo", ""]) {
      expect(parseFleetDirective(block({ op: "attach", handle, host: "minip3" }))).toBeUndefined();
    }
  });

  it("rejects attach/replace missing handle or host", () => {
    expect(parseFleetDirective(block({ op: "attach", host: "minip3" }))).toBeUndefined();
    expect(parseFleetDirective(block({ op: "attach", handle: "cf-foo" }))).toBeUndefined();
  });

  it("parses an optional status Clawdy reports directly, and drops an invalid one", () => {
    expect(parseFleetDirective(block({ op: "continue", status: "needs_input" }))?.directive).toEqual({
      op: "continue",
      status: "needs_input",
    });
    expect(parseFleetDirective(block({ op: "continue", status: "superseded" }))?.directive).toEqual({
      op: "continue",
      status: undefined,
    });
    expect(parseFleetDirective(block({ op: "inspect", status: "failed" }))?.directive).toEqual({
      op: "inspect",
      status: "failed",
    });
  });

  it("only consumes the first directive block when two are present", () => {
    const text = block({ op: "attach", handle: "cf-first", host: "minip3" }) + " " + block({ op: "detach", reason: "second" });
    const result = parseFleetDirective(text);
    expect(result?.directive).toMatchObject({ op: "attach", handle: "cf-first" });
  });

  it("carries a runtime, provider, and metadata through an explicit attach", () => {
    const result = parseFleetDirective(
      block({
        op: "attach",
        runtime: "t3-fleet",
        provider: "anthropic-claude-code",
        sessionId: "thr-abc123",
        host: "minip3",
        metadata: { t3ProjectId: "proj-1", attempt: 2 },
      }),
    );
    expect(result?.directive).toMatchObject({
      op: "attach",
      runtime: "t3-fleet",
      provider: "anthropic-claude-code",
      // `sessionId` is the neutral name for the same value `handle` has always carried.
      handle: "thr-abc123",
      metadata: { t3ProjectId: "proj-1", attempt: "2" },
    });
  });

  it("rejects a malformed runtime id, and defaults an omitted one at the session layer", () => {
    expect(parseFleetDirective(block({ op: "attach", runtime: "../evil", handle: "cf-foo", host: "minip3" }))).toBeUndefined();
    // Omitted here; session.ts fills in claude-fleet, the runtime this
    // directive shape originally described.
    expect(parseFleetDirective(block({ op: "attach", handle: "cf-foo", host: "minip3" }))?.directive).not.toHaveProperty(
      "runtime",
    );
  });

  it("parses a continue prompt and an explicit stopRuntime on detach", () => {
    expect(parseFleetDirective(block({ op: "continue", prompt: "also update the docs" }))?.directive).toMatchObject({
      op: "continue",
      prompt: "also update the docs",
    });
    expect(parseFleetDirective(block({ op: "detach", reason: "done", stopRuntime: true }))?.directive).toEqual({
      op: "detach",
      reason: "done",
      stopRuntime: true,
    });
    // Ending someone else's agent session is not recoverable, so it is opt-in
    // only — anything short of a literal `true` leaves detach local.
    expect(parseFleetDirective(block({ op: "detach", reason: "done", stopRuntime: "yes" }))?.directive).toEqual({
      op: "detach",
      reason: "done",
    });
  });

  it("accepts the widened state vocabulary both runtimes need", () => {
    for (const status of ["needs_permission", "completed", "idle", "dead", "stale"]) {
      expect(parseFleetDirective(block({ op: "inspect", status }))?.directive).toEqual({ op: "inspect", status });
    }
    // "unavailable"/"unknown" describe a READ, not a session, and are never
    // stored as a status.
    for (const status of ["unavailable", "unknown"]) {
      expect(parseFleetDirective(block({ op: "inspect", status }))?.directive).toEqual({ op: "inspect", status: undefined });
    }
  });
});

describe("parseAgentSessionMarker", () => {
  it("turns the neutral marker a runtime already prints into an attach", () => {
    const result = parseAgentSessionMarker(
      "Delegated to T3.\n" +
        marker({
          runtime: "t3-fleet",
          provider: "anthropic-claude-code",
          sessionId: "thr-abc123",
          host: "minip3",
          state: "running",
          metadata: { t3ProjectId: "proj-1", worktreePath: "/w/feature", turnId: "turn-9" },
        }) +
        "\nCarry on.",
    );
    expect(result?.directive).toMatchObject({
      op: "attach",
      runtime: "t3-fleet",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      host: "minip3",
      status: "running",
      worktree: "/w/feature",
      metadata: { t3ProjectId: "proj-1", worktreePath: "/w/feature", turnId: "turn-9" },
    });
    expect(result?.strippedText).toBe("Delegated to T3.\n\nCarry on.");
    expect(result?.strippedText).not.toContain("agent-session");
  });

  it("accepts claude-fleet's own neutral marker unchanged", () => {
    const result = parseAgentSessionMarker(
      marker({
        runtime: "claude-fleet",
        provider: "anthropic-claude-code",
        sessionId: "cf-foo",
        providerSessionId: "prov-1",
        remoteUrl: "https://claude.ai/code/session_x",
        host: "minip3",
        state: "idle",
        metadata: { project: "clawconnect", role: "impl" },
      }),
    );
    expect(result?.directive).toMatchObject({
      op: "attach",
      runtime: "claude-fleet",
      handle: "cf-foo",
      providerSessionId: "prov-1",
      remoteUrl: "https://claude.ai/code/session_x",
      status: "idle",
    });
  });

  it("allows an omitted host — a service runtime's session lives on a server, not a named machine", () => {
    const result = parseAgentSessionMarker(marker({ runtime: "t3-fleet", sessionId: "thr-abc123", state: "starting" }));
    expect(result?.directive).toMatchObject({ op: "attach", runtime: "t3-fleet", handle: "thr-abc123" });
    expect((result!.directive as { host?: string }).host).toBeUndefined();
  });

  it("requires a runtime and a safe session id, and never throws on garbage", () => {
    expect(parseAgentSessionMarker(marker({ sessionId: "thr-abc123" }))).toBeUndefined();
    expect(parseAgentSessionMarker(marker({ runtime: "t3-fleet" }))).toBeUndefined();
    expect(parseAgentSessionMarker(marker({ runtime: "t3-fleet", sessionId: "../../etc/passwd" }))).toBeUndefined();
    expect(parseAgentSessionMarker("<agent-session>{not json}</agent-session>")).toBeUndefined();
    expect(parseAgentSessionMarker("no marker here")).toBeUndefined();
    expect(parseAgentSessionMarker(undefined)).toBeUndefined();
  });

  it("extracts exactly the first marker out of a larger blob of agent output", () => {
    const text = `chatter ${marker({ runtime: "t3-fleet", sessionId: "thr-one" })} more ${marker({ runtime: "t3-fleet", sessionId: "thr-two" })}`;
    const result = parseAgentSessionMarker(text);
    expect(result?.directive).toMatchObject({ handle: "thr-one" });
    // Non-greedy: only the first marker is consumed, the rest of the text survives.
    expect(result?.strippedText).toContain("thr-two");
  });
});

describe("parseSessionHandoff", () => {
  it("prefers an explicit directive over a bare marker — it can express every transition, not just attach", () => {
    const text = `${marker({ runtime: "t3-fleet", sessionId: "thr-abc123" })} ${block({ op: "detach", reason: "finished" })}`;
    expect(parseSessionHandoff(text)?.directive).toEqual({ op: "detach", reason: "finished" });
  });

  it("falls back to the marker when no directive block is present", () => {
    expect(parseSessionHandoff(marker({ runtime: "t3-fleet", sessionId: "thr-abc123" }))?.directive).toMatchObject({
      op: "attach",
      runtime: "t3-fleet",
    });
  });
});
