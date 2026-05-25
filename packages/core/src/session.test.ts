import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_VETO_PREAMBLE, buildSubmitMessage } from "./session.ts";

describe("buildSubmitMessage", () => {
  it("prepends the message-tool veto preamble before the user task", () => {
    const out = buildSubmitMessage({ task: "do the thing" });
    expect(out.startsWith(MESSAGE_TOOL_VETO_PREAMBLE)).toBe(true);
    expect(out.endsWith("do the thing")).toBe(true);
    expect(out).toContain("\n\n---\n\n");
  });

  it("includes the sender identity between the preamble and the task body", () => {
    const out = buildSubmitMessage({ task: "do the thing", senderName: "Jake" });
    expect(out).toContain("[Message from: Jake]\n\ndo the thing");
    // Sender block lives in the user-message half, AFTER the preamble separator.
    const preambleEnd = out.indexOf("\n\n---\n\n");
    expect(out.indexOf("[Message from: Jake]")).toBeGreaterThan(preambleEnd);
  });

  it("inlines context before the task body", () => {
    const out = buildSubmitMessage({ task: "do the thing", context: "background facts" });
    expect(out).toContain("background facts\n\ndo the thing");
  });

  it("composes context + sender + task in the established order", () => {
    const out = buildSubmitMessage({
      task: "do the thing",
      context: "background facts",
      senderName: "Jake",
    });
    expect(out).toContain("[Message from: Jake]\n\nbackground facts\n\ndo the thing");
  });

  it("ignores whitespace-only senderName", () => {
    const out = buildSubmitMessage({ task: "do the thing", senderName: "   " });
    expect(out).not.toContain("[Message from:");
    expect(out.endsWith("do the thing")).toBe(true);
  });

  it("preamble vetoes the `message` tool by name", () => {
    // This is the load-bearing string. If the veto language drifts away from
    // naming the `message` tool, the receiving agent has nothing to comply with.
    expect(MESSAGE_TOOL_VETO_PREAMBLE).toContain("`message` tool");
    expect(MESSAGE_TOOL_VETO_PREAMBLE).toContain("Do NOT call");
  });

  it("preamble names the run_task channel so the agent knows the constraint applies", () => {
    expect(MESSAGE_TOOL_VETO_PREAMBLE).toContain("run_task");
  });
});
