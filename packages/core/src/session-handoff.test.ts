import { describe, expect, it } from "vitest";
import { parseAgentSessionMarker, parseAgentSessionDirective, parseSessionHandoff } from "./session-handoff.ts";

function block(obj: unknown): string {
  return `[[clawconnect:agent-session]]${JSON.stringify(obj)}[[/clawconnect:agent-session]]`;
}

function marker(obj: unknown): string {
  return `<agent-session>${JSON.stringify(obj)}</agent-session>`;
}

describe("parseAgentSessionDirective", () => {
  it("returns undefined for text with no directive block", () => {
    expect(parseAgentSessionDirective(undefined)).toBeUndefined();
    expect(parseAgentSessionDirective("")).toBeUndefined();
    expect(parseAgentSessionDirective("plain context, nothing structured here")).toBeUndefined();
  });

  it("parses an attach directive and strips it from the text", () => {
    const before = "Some preamble.\n\n";
    const after = "\n\nMore instructions.";
    const text = before + block({ op: "attach", handle: "cf-foo", host: "workstation-1", providerSessionId: "prov-1", worktree: "/w" }) + after;
    const result = parseAgentSessionDirective(text);
    expect(result).toBeDefined();
    expect(result?.directive).toEqual({
      op: "attach",
      handle: "cf-foo",
      host: "workstation-1",
      providerSessionId: "prov-1",
      worktree: "/w",
      remoteUrl: undefined,
    });
    expect(result?.strippedText).toBe("Some preamble.\n\n\n\nMore instructions.");
    expect(result?.strippedText).not.toContain("clawconnect:fleet");
  });

  it("parses a replace directive requiring a reason", () => {
    const withReason = parseAgentSessionDirective(block({ op: "replace", handle: "cf-bar", host: "workstation-1", reason: "stale worktree" }));
    expect(withReason?.directive).toMatchObject({ op: "replace", handle: "cf-bar", reason: "stale worktree" });

    const withoutReason = parseAgentSessionDirective(block({ op: "replace", handle: "cf-bar", host: "workstation-1" }));
    expect(withoutReason).toBeUndefined();
  });

  it("parses continue, detach (with reason), and inspect", () => {
    expect(parseAgentSessionDirective(block({ op: "continue" }))?.directive).toEqual({ op: "continue" });
    expect(parseAgentSessionDirective(block({ op: "detach", reason: "task finished" }))?.directive).toEqual({
      op: "detach",
      reason: "task finished",
    });
    expect(parseAgentSessionDirective(block({ op: "detach" }))).toBeUndefined();
    expect(parseAgentSessionDirective(block({ op: "inspect" }))?.directive).toEqual({ op: "inspect" });
  });

  it("rejects an unknown op", () => {
    expect(parseAgentSessionDirective(block({ op: "delete-everything", handle: "cf-foo", host: "workstation-1" }))).toBeUndefined();
  });

  it("rejects malformed JSON inside the block without throwing", () => {
    const text = "[[clawconnect:agent-session]]{ not valid json[[/clawconnect:agent-session]]";
    expect(() => parseAgentSessionDirective(text)).not.toThrow();
    expect(parseAgentSessionDirective(text)).toBeUndefined();
  });

  it("rejects a handle that isn't a safe path segment (path traversal defense)", () => {
    for (const handle of ["../../etc/passwd", "/etc/passwd", "cf foo", "cf/foo", ""]) {
      expect(parseAgentSessionDirective(block({ op: "attach", handle, host: "workstation-1" }))).toBeUndefined();
    }
  });

  it("rejects attach/replace missing handle or host", () => {
    expect(parseAgentSessionDirective(block({ op: "attach", host: "workstation-1" }))).toBeUndefined();
    expect(parseAgentSessionDirective(block({ op: "attach", handle: "cf-foo" }))).toBeUndefined();
  });

  it("parses an optional status the host reports directly, and drops an invalid one", () => {
    expect(parseAgentSessionDirective(block({ op: "continue", status: "needs_input" }))?.directive).toEqual({
      op: "continue",
      status: "needs_input",
    });
    expect(parseAgentSessionDirective(block({ op: "continue", status: "superseded" }))?.directive).toEqual({
      op: "continue",
      status: undefined,
    });
    expect(parseAgentSessionDirective(block({ op: "inspect", status: "failed" }))?.directive).toEqual({
      op: "inspect",
      status: "failed",
    });
  });

  it("only consumes the first directive block when two are present", () => {
    const text = block({ op: "attach", handle: "cf-first", host: "workstation-1" }) + " " + block({ op: "detach", reason: "second" });
    const result = parseAgentSessionDirective(text);
    expect(result?.directive).toMatchObject({ op: "attach", handle: "cf-first" });
  });

  it("carries a runtime, provider, and metadata through an explicit attach", () => {
    const result = parseAgentSessionDirective(
      block({
        op: "attach",
        runtime: "example-runtime",
        provider: "anthropic-claude-code",
        sessionId: "thr-abc123",
        host: "workstation-1",
        metadata: { runtimeProjectId: "proj-1", attempt: 2 },
      }),
    );
    expect(result?.directive).toMatchObject({
      op: "attach",
      runtime: "example-runtime",
      provider: "anthropic-claude-code",
      // `sessionId` is the neutral name for the same value `handle` has always carried.
      handle: "thr-abc123",
      metadata: { runtimeProjectId: "proj-1", attempt: "2" },
    });
  });

  it("rejects a malformed runtime id, and defaults an omitted one at the session layer", () => {
    expect(parseAgentSessionDirective(block({ op: "attach", runtime: "../evil", handle: "cf-foo", host: "workstation-1" }))).toBeUndefined();
    // Omitted here; session.ts fills in claude-fleet, the runtime this
    // directive shape originally described.
    expect(parseAgentSessionDirective(block({ op: "attach", handle: "cf-foo", host: "workstation-1" }))?.directive).not.toHaveProperty(
      "runtime",
    );
  });

  it("parses a continue prompt and an explicit stopRuntime on detach", () => {
    expect(parseAgentSessionDirective(block({ op: "continue", prompt: "also update the docs" }))?.directive).toMatchObject({
      op: "continue",
      prompt: "also update the docs",
    });
    expect(parseAgentSessionDirective(block({ op: "detach", reason: "done", stopRuntime: true }))?.directive).toEqual({
      op: "detach",
      reason: "done",
      stopRuntime: true,
    });
    // Ending someone else's agent session is not recoverable, so it is opt-in
    // only — anything short of a literal `true` leaves detach local.
    expect(parseAgentSessionDirective(block({ op: "detach", reason: "done", stopRuntime: "yes" }))?.directive).toEqual({
      op: "detach",
      reason: "done",
    });
  });

  it("accepts the widened state vocabulary both runtimes need", () => {
    for (const status of ["needs_permission", "completed", "idle", "dead", "stale"]) {
      expect(parseAgentSessionDirective(block({ op: "inspect", status }))?.directive).toEqual({ op: "inspect", status });
    }
    // "unavailable"/"unknown" describe a READ, not a session, and are never
    // stored as a status.
    for (const status of ["unavailable", "unknown"]) {
      expect(parseAgentSessionDirective(block({ op: "inspect", status }))?.directive).toEqual({ op: "inspect", status: undefined });
    }
  });
});

describe("parseAgentSessionMarker", () => {
  it("turns the neutral marker a runtime already prints into an attach", () => {
    const result = parseAgentSessionMarker(
      "Delegated to the runtime.\n" +
        marker({
          runtime: "example-runtime",
          provider: "anthropic-claude-code",
          sessionId: "thr-abc123",
          host: "workstation-1",
          state: "running",
          metadata: { runtimeProjectId: "proj-1", worktreePath: "/w/feature", turnId: "turn-9" },
        }) +
        "\nCarry on.",
    );
    expect(result?.directive).toMatchObject({
      op: "attach",
      runtime: "example-runtime",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      host: "workstation-1",
      status: "running",
      worktree: "/w/feature",
      metadata: { runtimeProjectId: "proj-1", worktreePath: "/w/feature", turnId: "turn-9" },
    });
    expect(result?.strippedText).toBe("Delegated to the runtime.\n\nCarry on.");
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
        host: "workstation-1",
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
    const result = parseAgentSessionMarker(marker({ runtime: "example-runtime", sessionId: "thr-abc123", state: "starting" }));
    expect(result?.directive).toMatchObject({ op: "attach", runtime: "example-runtime", handle: "thr-abc123" });
    expect((result!.directive as { host?: string }).host).toBeUndefined();
  });

  it("requires a runtime and a safe session id, and never throws on garbage", () => {
    expect(parseAgentSessionMarker(marker({ sessionId: "thr-abc123" }))).toBeUndefined();
    expect(parseAgentSessionMarker(marker({ runtime: "example-runtime" }))).toBeUndefined();
    expect(parseAgentSessionMarker(marker({ runtime: "example-runtime", sessionId: "../../etc/passwd" }))).toBeUndefined();
    expect(parseAgentSessionMarker("<agent-session>{not json}</agent-session>")).toBeUndefined();
    expect(parseAgentSessionMarker("no marker here")).toBeUndefined();
    expect(parseAgentSessionMarker(undefined)).toBeUndefined();
  });

  it("extracts exactly the first marker out of a larger blob of agent output", () => {
    const text = `chatter ${marker({ runtime: "example-runtime", sessionId: "thr-one" })} more ${marker({ runtime: "example-runtime", sessionId: "thr-two" })}`;
    const result = parseAgentSessionMarker(text);
    expect(result?.directive).toMatchObject({ handle: "thr-one" });
    // Non-greedy: only the first marker is consumed, the rest of the text survives.
    expect(result?.strippedText).toContain("thr-two");
  });
});

describe("parseSessionHandoff", () => {
  it("prefers an explicit directive over a bare marker — it can express every transition, not just attach", () => {
    const text = `${marker({ runtime: "example-runtime", sessionId: "thr-abc123" })} ${block({ op: "detach", reason: "finished" })}`;
    expect(parseSessionHandoff(text)?.directive).toEqual({ op: "detach", reason: "finished" });
  });

  it("falls back to the marker when no directive block is present", () => {
    expect(parseSessionHandoff(marker({ runtime: "example-runtime", sessionId: "thr-abc123" }))?.directive).toMatchObject({
      op: "attach",
      runtime: "example-runtime",
    });
  });
});
