import { describe, expect, it } from "vitest";
import { parseFleetDirective } from "./fleet-handoff.ts";

function block(obj: unknown): string {
  return `[[clawconnect:fleet]]${JSON.stringify(obj)}[[/clawconnect:fleet]]`;
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
});
