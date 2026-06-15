import { describe, expect, it } from "vitest";
import { extractMessageToolReply, formatLifecycleEventText } from "./gateway.ts";

describe("extractMessageToolReply", () => {
  it("returns the trimmed `message` arg for codex-style `message` tool calls", () => {
    // Shape observed in:
    //   ~/.openclaw-hank/agents/main/agent/codex-home/sessions/
    //   2026/05/24/rollout-2026-05-24T13-38-38-019e5b48-3001-7bf3-b69b-80af3345601b.jsonl
    // Hank's `message` tool args carried the full Tidy Crescent packet here.
    const args = {
      action: "send",
      message: "  [Jake brain dump items verbatim]\nFull packet here.  ",
    };
    expect(extractMessageToolReply("message", args)).toBe(
      "[Jake brain dump items verbatim]\nFull packet here.",
    );
  });

  it("falls back to `content` when `message` is absent", () => {
    expect(extractMessageToolReply("message", { content: "body via content" })).toBe(
      "body via content",
    );
  });

  it("falls back to `text` when `message` and `content` are absent", () => {
    expect(extractMessageToolReply("message", { text: "body via text" })).toBe("body via text");
  });

  it("returns empty string for tools other than `message`", () => {
    expect(extractMessageToolReply("exec_command", { message: "nope" })).toBe("");
    expect(extractMessageToolReply("memory_search", { content: "nope" })).toBe("");
  });

  it("returns empty string for empty/whitespace-only bodies", () => {
    expect(extractMessageToolReply("message", { message: "" })).toBe("");
    expect(extractMessageToolReply("message", { message: "   \n  " })).toBe("");
  });

  it("returns empty string for undefined/empty args", () => {
    expect(extractMessageToolReply("message", undefined)).toBe("");
    expect(extractMessageToolReply("message", {})).toBe("");
  });

  it("returns empty string when the candidate field isn't a string", () => {
    expect(extractMessageToolReply("message", { message: { nested: "object" } })).toBe("");
    expect(extractMessageToolReply("message", { message: 42 })).toBe("");
  });

  it("prefers `message` over `content` over `text` when multiple are present", () => {
    const args = { message: "from message", content: "from content", text: "from text" };
    expect(extractMessageToolReply("message", args)).toBe("from message");
  });
});

describe("formatLifecycleEventText", () => {
  it("preserves the lifecycle phase instead of collapsing non-start phases to finished", () => {
    expect(formatLifecycleEventText("start")).toBe("Agent lifecycle: start");
    expect(formatLifecycleEventText("end")).toBe("Agent lifecycle: end");
    expect(formatLifecycleEventText("compact")).toBe("Agent lifecycle: compact");
  });

  it("handles missing lifecycle phase explicitly", () => {
    expect(formatLifecycleEventText(undefined)).toBe("Agent lifecycle: unknown");
    expect(formatLifecycleEventText("  ")).toBe("Agent lifecycle: unknown");
  });
});
