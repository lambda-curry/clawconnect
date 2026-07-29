import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./shell.html", import.meta.url), "utf8");

describe("Task Center visual regressions", () => {
  it("uses neutral action tokens and keeps status colors semantic", () => {
    expect(shell).toContain("--cc-action-bg");
    expect(shell).toContain("--cc-action-selected");
    expect(shell).not.toMatch(/#(?:d97e2c|eb9c4f)/i);
    expect(shell).not.toContain("cc-btn cc-control cc-btn--primary");
    expect(shell).toContain("class: \"cc-card-tab cc-card-tab--expand\"");
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

  it("qualifies the segment rules with .cc-btn so they win the cascade against it", () => {
    // The tab buttons carry class="cc-btn cc-segment". .cc-btn is declared
    // LATER in this stylesheet, so on equal specificity its border/
    // border-radius/padding beat an unqualified .cc-segment and the underline
    // tabs render as bordered pill buttons — caught in a browser screenshot,
    // invisible to a string-contains assertion on the class attribute.
    expect(shell).toContain(".cc-btn.cc-segment {");
    expect(shell).toContain(".cc-btn.cc-segment--selected {");
    expect(shell).not.toMatch(/^\s*\.cc-segment(--selected)?\s*\{/m);
    // The qualified rules must still be able to zero out .cc-btn's chrome.
    expect(shell).toMatch(/\.cc-btn\.cc-segment \{[^}]*border: 0/);
  });

  it("keeps narrow embeds compact and removes the waiting placeholder from active runs", () => {
    expect(shell).toContain("@media (max-width: 640px)");
    expect(shell).toContain("cc-live-loading");
    expect(shell).not.toContain("Waiting for the final response...");
  });

  it("reconciles after background-tab resume signals and preserves live rows through empty reads", () => {
    expect(shell).toContain("visibilitychange");
    expect(shell).toContain('window.addEventListener("focus"');
    expect(shell).toContain('window.addEventListener("pageshow"');
    expect(shell).toContain("reconcileTaskList");
    expect(shell).toContain("app.reconcileRequested");
  });

  it("renders the Request/Response forehead as an accessible keyboard-navigable tab strip", () => {
    expect(shell).toContain('class: "cc-card-tabs"');
    expect(shell).toContain('role: "tablist"');
    expect(shell).toContain('role: "tab"');
    expect(shell).toContain('"aria-selected": app.cardTab === tab');
    expect(shell).toContain('"aria-controls": `${tablistId}-panel`');
    expect(shell).toContain('onkeydown: (e)');
    expect(shell).toContain('nextCardTab(cardTabs, app.cardTab, e.key)');
    expect(shell).toContain(".cc-card-tabs");
    expect(shell).toContain("@media (max-width: 640px)");
    expect(shell).not.toContain('class: "cc-btn cc-segment"');
    expect(shell).toContain('class: "cc-card-tab cc-card-tab--expand"');
    expect(shell).toContain('title: "Open Task Center"');
    expect(shell).toContain('"aria-label": "Open Task Center"');
    expect(shell).toContain("margin-left: auto");
    expect(shell).not.toContain('class: "cc-toolbar"');
  });
});
