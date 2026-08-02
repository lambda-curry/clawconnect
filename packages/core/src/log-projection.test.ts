import { describe, expect, it } from "vitest";
import { collapseToolPairs, projectLogWindow, EVENT_TEXT_MAX, INITIAL_WINDOW_MAX, DELTA_WINDOW_MAX } from "./log-projection.ts";
import type { LogEntry } from "./types.ts";

function entry(seq: number, type: string, text: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: seq, type, text, seq, ...extra };
}

describe("collapseToolPairs", () => {
  it("merges a tool immediately followed by its non-error tool-result into one entry", () => {
    const collapsed = collapseToolPairs([
      entry(1, "tool", "Bash: ls"),
      entry(2, "tool-result", "file1\nfile2"),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].type).toBe("tool");
    expect(collapsed[0].seq).toBe(2);
  });

  it("does not collapse an error tool-result — the failure must stay visible", () => {
    const collapsed = collapseToolPairs([
      entry(1, "tool", "Bash: rm -rf /nope"),
      entry(2, "tool-result", "permission denied", { isError: true }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it("leaves unrelated entries (lifecycle, non-adjacent tool) untouched", () => {
    const collapsed = collapseToolPairs([
      entry(1, "lifecycle", "started"),
      entry(2, "tool", "Bash: ls"),
      entry(3, "lifecycle", "still going"),
      entry(4, "tool-result", "file1"),
    ]);
    // tool at seq 2 is not immediately followed by a tool-result, so no collapse.
    expect(collapsed.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("projectLogWindow", () => {
  it("no cursor: returns at most INITIAL_WINDOW_MAX of the most recent entries, cursor at head", () => {
    const logs = Array.from({ length: 30 }, (_, i) => entry(i + 1, "lifecycle", `event ${i + 1}`));
    const window = projectLogWindow(logs, undefined);
    expect(window.events.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    expect(window.events.at(-1)?.seq).toBe(30);
    expect(window.cursor).toBe(30);
    expect(window.totalCount).toBe(30);
  });

  it("cursor with a small delta: returns exactly the new entries, cursor advances to head", () => {
    const logs = Array.from({ length: 10 }, (_, i) => entry(i + 1, "lifecycle", `event ${i + 1}`));
    const window = projectLogWindow(logs, 8);
    expect(window.events.map((e) => e.seq)).toEqual([9, 10]);
    expect(window.cursor).toBe(10);
  });

  it("missed-poll burst: caps the returned delta at DELTA_WINDOW_MAX but the cursor still jumps to the true head (no duplicate replay)", () => {
    const logs = Array.from({ length: 50 }, (_, i) => entry(i + 1, "lifecycle", `event ${i + 1}`));
    const window = projectLogWindow(logs, 5); // 45 new events since last seen
    expect(window.events.length).toBe(DELTA_WINDOW_MAX);
    expect(window.events.map((e) => e.seq)).toEqual([46, 47, 48, 49, 50]);
    expect(window.cursor).toBe(50);

    // A follow-up call with the returned cursor never re-sends anything already seen.
    const next = projectLogWindow(logs, window.cursor);
    expect(next.events).toEqual([]);
    expect(next.cursor).toBe(50);
  });

  it("reconnect/remount (cursor reset to undefined) after prior progress: bounded initial window, not the full history", () => {
    const logs = Array.from({ length: 100 }, (_, i) => entry(i + 1, "lifecycle", `event ${i + 1}`));
    const window = projectLogWindow(logs, undefined);
    expect(window.events.length).toBeLessThanOrEqual(INITIAL_WINDOW_MAX);
    expect(window.totalCount).toBe(100);
  });

  it("truncates event text to EVENT_TEXT_MAX", () => {
    const longText = "x".repeat(1000);
    const logs = [entry(1, "lifecycle", longText)];
    const window = projectLogWindow(logs, undefined);
    expect(window.events[0].text.length).toBe(EVENT_TEXT_MAX);
    expect(window.events[0].text.endsWith("…")).toBe(true);
  });

  it("empty logs: empty window, cursor 0", () => {
    const window = projectLogWindow([], undefined);
    expect(window.events).toEqual([]);
    expect(window.cursor).toBe(0);
    expect(window.totalCount).toBe(0);
  });

  it("collapses tool/tool-result pairs within the projected window, not just raw slicing", () => {
    const logs = [
      entry(1, "tool", "Bash: ls"),
      entry(2, "tool-result", "a.ts\nb.ts"),
      entry(3, "lifecycle", "done"),
    ];
    const window = projectLogWindow(logs, undefined);
    expect(window.events).toHaveLength(2); // collapsed tool+tool-result, plus lifecycle
    expect(window.events[0].type).toBe("tool");
  });
});
