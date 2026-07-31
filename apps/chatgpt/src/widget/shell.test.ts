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

  it("keeps the card tabs off .cc-btn, so their own rules can't lose the cascade to it", () => {
    // The predecessor of this control carried class="cc-btn cc-segment", and
    // .cc-btn is declared LATER in this stylesheet — so on equal specificity
    // .cc-btn's border/border-radius/padding beat the unqualified .cc-segment
    // rules and the underline tabs rendered as bordered pill buttons. Caught
    // only by screenshotting the built widget; a string-contains assertion on
    // the class attribute saw nothing wrong.
    //
    // The current .cc-card-tab design sidesteps it structurally by not reusing
    // .cc-btn at all. This asserts that structural choice, which is what makes
    // the tab rules authoritative without needing specificity tricks.
    expect(shell).toContain(".cc-card-tab {");
    expect(shell).toMatch(/\.cc-card-tab \{[^}]*border: 0/);
    expect(shell).toMatch(/class: "cc-card-tab/);
    expect(shell).not.toMatch(/class: "cc-btn[^"]*cc-card-tab/);
    expect(shell).not.toContain("cc-segment"); // superseded — no dead rules left behind
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
    expect(shell).toContain('"aria-selected": activeTab === tab');
    expect(shell).toContain('"aria-controls": `${tablistId}-panel`');
    expect(shell).toContain('onkeydown: (e)');
    expect(shell).toContain('nextCardTab(cardTabs, activeTab, e.key)');
    // Per-task, not a global pair: renderRow runs once per card, so a shared
    // cardTab/cardTabFor let the last-rendered row reset every other row's
    // selection. Only reproducible with two cards open, which is why it shipped.
    expect(shell).toContain("cardTabByTask: new Map()");
    expect(shell).toContain("app.cardTabByTask.get(taskId) ?? defaultCardTab(row.latestTask)");
    expect(shell).not.toContain("app.cardTabFor");
    // The tab strip leads the card, which is what makes its negative top margin
    // correct — it overlapped the meta line by exactly 12px when it sat third.
    expect(shell).toContain("// Tabs lead the card, then the title row and meta line beneath them.");
    expect(shell).toContain("margin: -12px -14px 10px");
    // One-line activity: a long tool invocation used to reflow the card height
    // on every poll.
    expect(shell).toContain(".cc-update-text");
    // An interaction refresh must not fire on pointerdown: render() replaces the
    // whole tree, so it removes the node mid-gesture and the click never lands.
    expect(shell).toContain('window.addEventListener("click", refreshOnInteraction');
    expect(shell).not.toContain('addEventListener("pointerdown", refreshOnInteraction');
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
