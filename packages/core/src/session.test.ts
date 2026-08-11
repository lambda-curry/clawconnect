import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_VETO_PREAMBLE, buildSubmitMessage, isEchoOfRecentEvent } from "./session.ts";
import type { GatewayEvent, LogEntry } from "./types.ts";

const logEntry = (type: string, text: string, seq: number): LogEntry => ({ ts: seq, type, text, seq });
const toolEvent = (text: string): GatewayEvent => ({ type: "tool", text, toolName: text.split(":")[0], args: {} });

describe("isEchoOfRecentEvent — the same tool call arriving from both sources", () => {
  it("suppresses an identical tool row that just landed", () => {
    const logs = [logEntry("tool", "Bash: pnpm test", 1)];
    expect(isEchoOfRecentEvent(logs, toolEvent("Bash: pnpm test"))).toBe(true);
  });

  it("suppresses an argument-less transcript row echoing a richer live one", () => {
    const logs = [logEntry("tool", "Bash: pnpm test", 1)];
    expect(isEchoOfRecentEvent(logs, toolEvent("Bash: "))).toBe(true);
  });

  it("KEEPS a richer row when the argument-less one arrived first", () => {
    // The two sources race, and this is the direction that must not lose
    // information: dropping "Bash: pnpm test" because a bare "Bash: " won the
    // race would leave the card unable to say what actually ran.
    const logs = [logEntry("tool", "Bash: ", 1)];
    expect(isEchoOfRecentEvent(logs, toolEvent("Bash: pnpm test"))).toBe(false);
  });

  it("keeps a genuinely different call of the same tool", () => {
    const logs = [logEntry("tool", "Bash: pnpm test", 1)];
    expect(isEchoOfRecentEvent(logs, toolEvent("Bash: git status"))).toBe(false);
  });

  it("keeps a repeat that fell outside the recent window", () => {
    const logs = [
      logEntry("tool", "Bash: pnpm test", 1),
      ...Array.from({ length: 6 }, (_, i) => logEntry("tool", `Read: file-${i}`, i + 2)),
    ];
    expect(isEchoOfRecentEvent(logs, toolEvent("Bash: pnpm test"))).toBe(false);
  });

  it("never suppresses prose or lifecycle — only tool calls are double-sourced", () => {
    const logs = [logEntry("assistant", "Looking at the test.", 1)];
    expect(isEchoOfRecentEvent(logs, { type: "assistant", text: "Looking at the test." })).toBe(false);
  });
});

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
