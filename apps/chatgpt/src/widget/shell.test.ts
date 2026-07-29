import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./shell.html", import.meta.url), "utf8");

describe("Task Center visual regressions", () => {
  it("uses neutral action tokens and keeps status colors semantic", () => {
    expect(shell).toContain("--cc-action-bg");
    expect(shell).toContain("--cc-action-selected");
    expect(shell).not.toMatch(/#(?:d97e2c|eb9c4f)/i);
    expect(shell).not.toContain("cc-btn cc-control cc-btn--primary");
    expect(shell).toContain("class: \"cc-btn cc-control\"");
  });

  it("renders a compact intentional empty state with an accessible center action", () => {
    expect(shell).toContain("No active tasks");
    expect(shell).toContain("New delegated tasks will appear here while they run.");
    expect(shell).toContain('class: "cc-empty"');
    expect(shell).toContain('title: "Open Task Center"');
    expect(shell).toContain('aria-label": "Open Task Center"');
    expect(shell).toContain("justify-content: flex-end");
    expect(shell).toContain("min-height: 58px");
  });

  it("keeps narrow embeds compact and removes the waiting placeholder from active runs", () => {
    expect(shell).toContain("@media (max-width: 640px)");
    expect(shell).toContain("cc-live-loading");
    expect(shell).not.toContain("Waiting for the final response...");
  });
});

