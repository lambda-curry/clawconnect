// Pure functions — no DOM, no fetch, no timers, no mutation. Testable in
// isolation (widget/state.test.ts) and inlined into shell.html by
// scripts/build-widget.mjs, which strips the trailing `export` block so the
// served resource is one self-contained <script> with no ES module syntax.
//
// Data contract: every function here consumes exactly what run_task/
// check_task/get_task/list_tasks/get_session already return (TaskSummary /
// JobSnapshot shapes from @clawconnect/core) — no widget-specific payload.
// See docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md §3.

/**
 * Shared shapes, as JSDoc so this stays a plain .js module (build-widget.mjs
 * inlines it verbatim; a .ts file would need a compile step first) while still
 * type-checking. Annotated on the functions that return collections
 * specifically: their element type is what flows into a caller's `.map`/
 * `.filter` callback, so leaving those inferred as `any` is what produces
 * implicit-any parameters at every call site.
 *
 * @typedef {"active" | "needs_attention" | "completed" | "failed"} TaskGroup
 *
 * A task as the widget sees it: the TaskSummary shape list_tasks and
 * get_session(mode:"tasks") return, widened with the extra fields a full
 * get_task snapshot carries (the pinned task is merged in via ensurePinnedTask,
 * so any row may or may not have them).
 * @typedef {object} WidgetTask
 * @property {string} [taskId]
 * @property {string} [jobId]
 * @property {string} sessionKey
 * @property {string} [agent]
 * @property {string} status
 * @property {number} [startedAt]
 * @property {number} [lastEventAt]
 * @property {string} [summary]
 * @property {string} [error]
 * @property {{ message?: string, category?: string }} [errorInfo]
 * @property {{ filesChanged?: string[], commandsRun?: string[], branchName?: string, commitSha?: string, prUrl?: string }} [artifacts]
 * @property {LogEntry[]} [updates]
 * @property {LogEntry[]} [logs]
 * @property {unknown} [recovery]
 *
 * @typedef {{ ts: number, type: string, text: string, isError?: boolean }} LogEntry
 *
 * @typedef {object} SessionRow
 * @property {string} sessionKey
 * @property {WidgetTask} latestTask
 * @property {TaskGroup} group
 * @property {string} title
 * @property {boolean} expanded
 * @property {(WidgetTask & { group: TaskGroup, title: string })[]} [history]
 */

/** Maps a TaskSummary's exact status to a display bucket. The exact status is never mutated — this is presentation grouping only (Active / Needs attention / Completed / Failed). */
export function groupStatus(status) {
  if (status === "running" || status === "queued") return "active";
  if (status === "blocked" || status === "needs-human") return "needs_attention";
  // TaskSummary uses `done`, while a mounted get_task snapshot preserves the
  // backend JobStatus (`completed` / `completed_no_summary`). Both are
  // successful terminal states and must never fall through to failed.
  if (status === "done" || status === "completed" || status === "completed_no_summary") return "completed";
  return "failed";
}

function isTerminalGroup(group) {
  return group === "completed" || group === "failed";
}

/**
 * Icon + label for a group — status must never be communicated by color
 * alone (accessibility; also just more honest about what's happening).
 * Plain Unicode glyphs, no icon library, so the self-contained resource
 * stays self-contained.
 */
export function deriveStatusPill(group) {
  if (group === "active") return { icon: "●", label: "Running" };
  if (group === "needs_attention") return { icon: "⚠", label: "Needs attention" };
  if (group === "completed") return { icon: "✓", label: "Completed" };
  return { icon: "✕", label: "Failed" };
}

/** Strips the inline markdown syntax a one-line title can't render, keeping the text: emphasis, inline code, link labels, and leading list/quote markers. */
function stripInlineMarkdown(text) {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*_\w])[*_]([^*_]+)[*_](?=[^*_\w]|$)/g, "$1$2")
    .replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^\s{0,3}>\s?/, "");
}

/**
 * A markdown summary's own heading is its title — otherwise the card's first
 * line renders as literal "## What changed **stale jobId**…" syntax once the
 * body below it is rendered as real markdown (caught in a browser screenshot).
 * Without a leading heading, fall back to the whole summary flattened, so a
 * hard-wrapped plain-prose summary isn't silently cut at its first newline.
 */
function titleFromSummary(summary) {
  const lines = String(summary).split(/\n/);
  const firstContentful = lines.find((l) => l.trim());
  const heading = firstContentful ? /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(firstContentful) : null;
  const source = heading ? heading[1] : summary;
  return stripInlineMarkdown(String(source).replace(/\s+/g, " ").trim()).trim();
}

/**
 * Generated title, derived only from fields already present in a normal
 * (non-"prompt") task/snapshot — artifacts, summary, status, agent. Never
 * the stored prompt, so the default render path never needs
 * get_task(detail:"prompt") at all. See canReadPrompt for the dedicated,
 * explicit action that does.
 */
export function deriveTitle(task) {
  if (task.artifacts?.prUrl) {
    return task.artifacts.branchName ? `PR: ${task.artifacts.branchName}` : "Pull request ready";
  }
  if (task.summary) {
    const oneLine = titleFromSummary(task.summary);
    return oneLine.length > 64 ? `${oneLine.slice(0, 63)}…` : oneLine;
  }
  if (task.status === "running" || task.status === "queued") {
    return task.agent ? `${task.agent} is working…` : "Working…";
  }
  // Bug found via browser smoke test: this used to key off task.error being
  // truthy, which also fires for "blocked" (core sets error to a
  // session-busy message for that status — see deriveTaskStatus in
  // packages/core/src/tools.ts) and mislabeled a blocked task as failed.
  // Key off the actual status instead.
  if (task.status === "failed") return "Task failed";
  if (task.status === "blocked") return "Blocked";
  if (task.status === "needs-human") return "Needs your input";
  const id = task.taskId ?? task.jobId ?? "";
  return `Task ${String(id).slice(0, 8)}`;
}

/** True whenever a taskId is resolvable — the "Show original request" action (get_task detail:"prompt") never renders for a row without one. Read-only/navigation only: this never fetches, it only gates whether the action is offered. */
export function canReadPrompt(task) {
  const id = task?.taskId ?? task?.jobId;
  return typeof id === "string" && id.length > 0;
}

/**
 * Aggregate command center collapsing to a focused single task/session.
 * `mounted` is {taskId, sessionKey} the widget was mounted for (run_task's
 * result). `tasks` is the current list_tasks read in scope. Collapses to
 * "focused" only when the mounted session is the only one with
 * non-terminal work — otherwise renders the full command center with that
 * session highlighted/expanded by default.
 */
export function deriveViewMode(mounted, tasks) {
  const activeSessionKeys = new Set(
    tasks.filter((t) => !isTerminalGroup(groupStatus(t.status))).map((t) => t.sessionKey),
  );
  if (!mounted) return { mode: "aggregate", highlightSessionKey: undefined };
  if (activeSessionKeys.size <= 1) {
    return { mode: "focused", taskId: mounted.taskId, sessionKey: mounted.sessionKey };
  }
  return { mode: "aggregate", highlightSessionKey: mounted.sessionKey };
}

/**
 * Session-first rows, one per sessionKey (keyed by sessionKey, per the UX
 * spec), carrying that session's most recent task. Expansion into full
 * task history (keyed by taskId) is a separate step — expandSessionRow —
 * fetched on demand via get_session(mode:"tasks"), not eagerly for every
 * row.
 */
/** @param {WidgetTask[]} tasks @param {{ highlightSessionKey?: string }} [opts] @returns {SessionRow[]} */
export function buildSessionRows(tasks, opts = {}) {
  const bySession = new Map();
  for (const task of tasks) {
    const existing = bySession.get(task.sessionKey);
    if (!existing || task.lastEventAt > existing.lastEventAt) bySession.set(task.sessionKey, task);
  }
  const rows = [...bySession.values()].map((task) => ({
    sessionKey: task.sessionKey,
    latestTask: task,
    group: groupStatus(task.status),
    title: deriveTitle(task),
    expanded: Boolean(opts.highlightSessionKey) && task.sessionKey === opts.highlightSessionKey,
    history: undefined,
  }));
  const highlight = opts.highlightSessionKey;
  rows.sort((a, b) => {
    if (highlight) {
      if (a.sessionKey === highlight) return -1;
      if (b.sessionKey === highlight) return 1;
    }
    return b.latestTask.lastEventAt - a.latestTask.lastEventAt;
  });
  return rows;
}

/**
 * Active (default): only rows whose latest task still needs attention —
 * Active or Needs attention groups. Recent: every row, newest first
 * (buildSessionRows already sorts by lastEventAt).
 *
 * `pinnedSessionKey` (the focused/highlighted session — the one the user is
 * actually watching) always shows regardless of group, in both views. A
 * task finishing is exactly the moment its result matters most; the
 * Active filter exists to declutter the *rest* of the command center, not
 * to hide the one thing that just completed out from under the user who
 * dispatched it.
 */
/** @param {SessionRow[]} rows @param {"active" | "recent"} view @param {string} [pinnedSessionKey] @returns {SessionRow[]} */
export function filterRows(rows, view, pinnedSessionKey) {
  if (view === "recent") return rows;
  return rows.filter((r) => r.group === "active" || r.group === "needs_attention" || r.sessionKey === pinnedSessionKey);
}

/**
 * Swaps the pinned/selected task's plain TaskSummary (list_tasks and
 * get_session(mode:"tasks") never include `artifacts` — see
 * packages/core/src/tools.ts's listTasks()) for the full JobSnapshot
 * fetched alongside it (get_task detail:"full"), leaving every other task
 * as the plain summary that was actually fetched for it.
 *
 * Exists as a pure function (not inlined at the shell.html call site)
 * specifically because a bug here is invisible in a screenshot that
 * happens to use richer mock data than production ever returns — it needs
 * its own fixture-driven test with a deliberately TaskSummary-shaped
 * (no-artifacts) non-pinned task, the same shape a real list_tasks call
 * returns.
 */
/** @param {WidgetTask[]} tasks @param {WidgetTask | null} pinnedDetail @returns {WidgetTask[]} */
export function mergePinnedDetail(tasks, pinnedDetail) {
  if (!pinnedDetail) return tasks;
  const pinnedId = pinnedDetail.taskId ?? pinnedDetail.jobId;
  return tasks.map((t) => ((t.taskId ?? t.jobId) === pinnedId ? { ...t, ...pinnedDetail } : t));
}

/**
 * mergePinnedDetail, plus: adds the pinned task when it isn't in `tasks` at
 * all. list_tasks(view:"active") intentionally omits terminal work, so the
 * instant the focused task completes it drops out of the very list the card
 * polls — a card that only ever *merged* would render the task the user just
 * dispatched as having vanished at the exact moment its result matters most
 * (the same failure ad3cab1 fixed at the row-filter level, which only holds
 * if the task is still in the list to be filtered). The pinned snapshot comes
 * from a direct get_task read and is authoritative either way.
 *
 * A get_task detail:"full" payload is a superset of TaskSummary, so an added
 * entry carries everything buildSessionRows/deriveTitle need. Append position
 * is irrelevant — buildSessionRows sorts by lastEventAt.
 */
/** @param {WidgetTask[]} tasks @param {WidgetTask | null} pinnedDetail @returns {WidgetTask[]} */
export function ensurePinnedTask(tasks, pinnedDetail) {
  if (!pinnedDetail) return tasks;
  const pinnedId = pinnedDetail.taskId ?? pinnedDetail.jobId;
  if (pinnedId == null) return tasks;
  const present = tasks.some((t) => (t.taskId ?? t.jobId) === pinnedId);
  return present ? mergePinnedDetail(tasks, pinnedDetail) : [...tasks, pinnedDetail];
}

/** Merges a get_session(mode:"tasks") read into a row's expanded task history, keyed by taskId. Exact per-task status is preserved — group is display-only, computed fresh per history entry. */
/** @param {SessionRow} row @param {WidgetTask[]} historyTasks @returns {SessionRow & { history: (WidgetTask & { group: TaskGroup, title: string })[] }} */
export function expandSessionRow(row, historyTasks) {
  return {
    ...row,
    expanded: true,
    history: historyTasks.map((t) => ({ ...t, group: groupStatus(t.status), title: deriveTitle(t) })),
  };
}

/**
 * Compact per-session counts ("1 running · 6 completed") from a session's
 * task history (get_session(mode:"tasks")) — the inline card's summary
 * line. Deliberately just counts, not the itemized list (that's
 * expandSessionRow's job, click-triggered) — the inline card stays compact
 * by design.
 */
export function deriveCounts(historyTasks) {
  const counts = { active: 0, needs_attention: 0, completed: 0, failed: 0, total: 0 };
  for (const t of historyTasks ?? []) {
    counts[groupStatus(t.status)] += 1;
    counts.total += 1;
  }
  return counts;
}

/** The counts line as shown text, e.g. "1 running · 6 completed" — omits zero groups so it stays compact rather than "0 needs attention · 0 failed" noise. */
export function formatCounts(counts) {
  const parts = [];
  if (counts.active) parts.push(`${counts.active} running`);
  if (counts.needs_attention) parts.push(`${counts.needs_attention} needs attention`);
  if (counts.completed) parts.push(`${counts.completed} completed`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(" · ");
}

/**
 * Context-aware detail: which sections a focused task's detail view
 * renders, based on what's actually present on the task — never a fixed
 * template that shows empty sections. Read-only: this only selects what to
 * show, never what to do.
 */
/** @param {WidgetTask} task @returns {string[]} */
export function deriveDetailSections(task) {
  const sections = ["status"];
  if (task.status === "running" || task.status === "queued") sections.push("liveUpdate");
  const artifacts = task.artifacts;
  if (artifacts && (artifacts.filesChanged?.length || artifacts.prUrl || artifacts.commandsRun?.length)) {
    sections.push("artifacts");
  }
  if (task.summary) sections.push("summary");
  if (task.error || task.errorInfo) sections.push("error");
  if (task.recovery) sections.push("recovery");
  return sections;
}

/**
 * The fullscreen detail pane's tab set — "overview" always, "artifacts"
 * only when there's something to show, "prompt" only when the id is
 * resolvable (canReadPrompt). Built on deriveDetailSections rather than
 * duplicating its presence checks, so the two stay in lockstep.
 */
/** @param {WidgetTask} task @returns {string[]} */
export function deriveDetailTabs(task) {
  const sections = deriveDetailSections(task);
  const tabs = ["overview"];
  if (sections.includes("artifacts")) tabs.push("artifacts");
  if (canReadPrompt(task)) tabs.push("prompt");
  return tabs;
}

/**
 * The inline card's tab set — "response" always, "diagnostics" only when the
 * task actually carries error detail, "request" only when the id is
 * resolvable (canReadPrompt). Same presence-driven convention as
 * deriveDetailTabs: never offer a tab that would open onto nothing.
 */
/** @param {Partial<WidgetTask>} task @returns {("response" | "diagnostics" | "request")[]} */
export function deriveCardTabs(task) {
  const tabs = ["response"];
  if (task?.error || task?.errorInfo) tabs.push("diagnostics");
  if (canReadPrompt(task)) tabs.push("request");
  return tabs;
}

/**
 * Which tab a card opens on when focus moves to a different task. A failed
 * task opens on its diagnostics — that's the answer the user is looking for,
 * and making them click for it buries the one thing that went wrong. Anything
 * else opens on the response.
 *
 * Guarded by deriveCardTabs so this can never select a tab that isn't
 * offered: core sets `.error` to a session-busy message for status="blocked"
 * (deriveTaskStatus in packages/core/src/tools.ts), so keying off `.error`
 * alone would open a merely-blocked task on "diagnostics" — the same
 * truthy-`.error` trap deriveTitle already had to be fixed for.
 */
/** @param {Partial<WidgetTask>} task @returns {"response" | "diagnostics"} */
export function defaultCardTab(task) {
  const tabs = deriveCardTabs(task);
  const preferred = groupStatus(task?.status) === "failed" ? "diagnostics" : "response";
  return tabs.includes(preferred) ? preferred : "response";
}

/**
 * Whether a body of text is worth rendering as markdown rather than as
 * preformatted plain text. Agent summaries are usually markdown but are under
 * no obligation to be — a plain paragraph run through a markdown renderer
 * gains nothing and risks mangling stray punctuation, so the plain path
 * (white-space: pre-wrap via .cc-plain) stays the default until there's an
 * actual structural marker.
 */
export function isLikelyMarkdown(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return (
    /^\s{0,3}#{1,6}\s+\S/m.test(text) || // heading
    /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+\S/m.test(text) || // list item
    /^\s{0,3}>\s?\S/m.test(text) || // blockquote
    /```/.test(text) || // fenced code
    /`[^`\n]+`/.test(text) || // inline code
    /\[[^\]\n]+\]\([^)\s]+\)/.test(text) || // link
    /\*\*[^*\n]+\*\*/.test(text) || // bold
    /^\s*\|.+\|\s*$/m.test(text) // table row
  );
}

const MD_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes every HTML-significant character. Runs before any markdown transform, so nothing in the source text can ever reach innerHTML as markup. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => MD_ESCAPES[c]);
}

/**
 * Only http/https/mailto survive as links. A summary is agent-authored text
 * flowing into innerHTML, so `javascript:`/`data:` hrefs are dropped back to
 * plain text rather than sanitized-in-place.
 */
function safeHref(url) {
  return /^(?:https?:\/\/|mailto:)[^\s]+$/i.test(url) ? url : null;
}

function renderInlineMd(escaped) {
  let out = escaped;
  // Inline code first, and via a placeholder pass, so **/*/[]() inside a code
  // span renders literally instead of being treated as emphasis. The
  // placeholder is bracketed in raw < / >, which cannot occur in the
  // already-escaped input, so it can never collide with the source text.
  const codeSpans = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `<!c${codeSpans.length - 1}!>`;
  });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : whole;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
  return out.replace(/<!c(\d+)!>/g, (whole, i) => codeSpans[Number(i)] ?? whole);
}

function renderTableRows(rows) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => renderInlineMd(escapeHtml(c.trim())));
  const isDivider = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
  const head = cells(rows[0]);
  const bodyRows = rows.slice(isDivider(rows[1] ?? "") ? 2 : 1);
  const thead = `<thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = bodyRows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table>${thead}${tbody ? `<tbody>${tbody}</tbody>` : ""}</table>`;
}

/**
 * Minimal block-level markdown → HTML for agent-authored summaries and
 * prompts. Emits only the tag set shell.html already styles (h1-h3, p, ul/ol,
 * li, blockquote, pre/code, table, strong, em, a) — deliberately not a full
 * CommonMark implementation, because the widget must stay a single
 * self-contained resource with no bundler and no third-party library.
 *
 * The output goes to innerHTML, so the ordering here is load-bearing:
 * escapeHtml runs over the entire source first, and every tag emitted
 * afterwards is one this function wrote itself. Raw HTML in the source is
 * therefore always displayed as text, never interpreted.
 */
export function renderMarkdownHtml(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const blocks = [];
  const lines = source.split("\n");
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length) blocks.push(`<p>${renderInlineMd(escapeHtml(buf.join(" ")))}</p>`);
    buf.length = 0;
  };
  const paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s{0,3}```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1; // closing fence (or EOF — an unterminated block still renders)
      blocks.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(heading[1].length, 3); // only h1-h3 are styled
      blocks.push(`<h${level}>${renderInlineMd(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderInlineMd(escapeHtml(quoted.join(" ")))}</blockquote>`);
      continue;
    }

    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph(paragraph);
      const ordered = Boolean(numbered);
      const items = [];
      while (i < lines.length) {
        const m = ordered ? /^\s{0,3}\d{1,9}[.)]\s+(.*)$/.exec(lines[i]) : /^\s{0,3}[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${renderInlineMd(escapeHtml(m[1].trim()))}</li>`);
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph(paragraph);
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      blocks.push(renderTableRows(rows));
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph(paragraph);
  return blocks.join("");
}

/**
 * Attention-shaped cadence, in ms — a UX default carried forward from prior
 * exploration (not a platform-verified number in either branch), stopping
 * entirely once a group is terminal. `null` means "stop polling."
 */
export function pollIntervalMs(group, pollFailures = 0) {
  if (isTerminalGroup(group)) return null;
  if (pollFailures > 0) return Math.min(5000 * pollFailures, 30000);
  if (group === "needs_attention") return 8000;
  if (group === "active") return 2500;
  return 12000; // "slow"/quiet fallback for any other non-terminal group
}

/**
 * Bounded + deduplicated read guard: never start a new read while one is
 * already in flight (dedup), and never poll once every task in scope is
 * terminal (bound). Aggregate mode's single list_tasks call already covers
 * every session in one read — there is no per-row fan-out to bound
 * separately.
 */
export function shouldPoll({ pollInFlight, tasks }) {
  if (pollInFlight) return false;
  if (!tasks || tasks.length === 0) return true; // nothing known yet — one read is worth it
  return tasks.some((t) => !isTerminalGroup(groupStatus(t.status)));
}

/**
 * Ordering safety for reads that can land out of order: terminal always
 * beats non-terminal; otherwise the newer lastEventAt wins. Without this, a
 * slow "running" read returning after a fast "completed" read would make a
 * finished task look live again.
 */
export function preferSnapshot(next, current) {
  if (!current) return next;
  const nextTerminal = isTerminalGroup(groupStatus(next.status));
  const currentTerminal = isTerminalGroup(groupStatus(current.status));
  if (nextTerminal && !currentTerminal) return next;
  if (currentTerminal && !nextTerminal) return current;
  return next.lastEventAt >= current.lastEventAt ? next : current;
}

/**
 * Conversation scope — documented safe fallback (no verified per-
 * conversation id from the host; see the reconciliation note §3). Default
 * scope is this card instance's own known sessions; allActivity explicitly
 * opts into the fully unscoped read.
 */
export function resolveScope(knownSessionKeys, allActivity) {
  if (allActivity) return { scoped: false, sessionKeys: null };
  return { scoped: true, sessionKeys: [...new Set(knownSessionKeys ?? [])] };
}

/** @param {WidgetTask[]} tasks @param {{ scoped: boolean, sessionKeys: string[] | null }} scope @returns {WidgetTask[]} */
export function filterTasksByScope(tasks, scope) {
  if (!scope.scoped) return tasks;
  const allowed = new Set(scope.sessionKeys ?? []);
  return tasks.filter((t) => allowed.has(t.sessionKey));
}

/** Keep known live work visible when a suspended/backgrounded host resumes
 * with a transient empty list response. A later snapshot can still replace
 * it; this only prevents a false empty state during reconciliation. */
export function reconcileTaskList(previous, next) {
  const prior = previous ?? [];
  const incoming = next ?? [];
  const hadLiveWork = prior.some((task) => !isTerminalGroup(groupStatus(task.status)));
  return incoming.length === 0 && hadLiveWork ? prior : incoming;
}

/**
 * A status label like "clawdy is working…" is not evidence — it's a claim.
 * Without a timestamp behind it, there's no way to tell "still going" from
 * "silently stuck." formatElapsed/deriveActivityLabel pair every liveness
 * claim with how long ago the last real event actually landed, straight
 * from lastEventAt (already present on every TaskSummary — costs no extra
 * read). isStale flags when that gap is long enough to be worth calling out.
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const STALE_THRESHOLD_MS = 90_000;

export function isStale(lastEventAt, now, thresholdMs = STALE_THRESHOLD_MS) {
  return now - lastEventAt > thresholdMs;
}

/** Ties a task's group to the evidence behind it: how long ago its last real event landed, and whether that's long enough to flag as possibly stuck. */
export function deriveActivityLabel(task, now) {
  const elapsed = now - task.lastEventAt;
  const group = groupStatus(task.status);
  if (isTerminalGroup(group)) return `finished ${formatElapsed(elapsed)} ago`;
  if (isStale(task.lastEventAt, now)) return `quiet for ${formatElapsed(elapsed)} — may be stuck`;
  return `active ${formatElapsed(elapsed)} ago`;
}

/**
 * Compact, deduplicated timeline from a task's raw log entries
 * (JobSnapshot.logs / get_task(detail:"updates").updates) — the actual
 * evidence that a "working" claim is backed by real activity, not just a
 * static label. Consecutive entries with the same (type, text) collapse
 * into one row with a count (a tool looping doesn't spam N identical
 * rows). Returns at most `maxRows`, most recent first.
 */
/** @param {LogEntry[] | undefined} logs @param {number} [maxRows] @returns {(LogEntry & { count: number })[]} */
export function deriveTimeline(logs, maxRows = 4) {
  if (!logs || logs.length === 0) return [];
  const collapsed = [];
  for (const entry of logs) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.type === entry.type && last.text === entry.text) {
      last.count += 1;
      last.ts = entry.ts;
      last.isError = last.isError || entry.isError === true;
    } else {
      collapsed.push({ type: entry.type, text: entry.text, ts: entry.ts, count: 1, isError: entry.isError === true });
    }
  }
  return collapsed.slice(-maxRows).reverse();
}

/** The single most recent log entry, for a one-line "latest update" summary above the fuller timeline. */
export function deriveLatestUpdate(logs) {
  if (!logs || logs.length === 0) return null;
  return logs[logs.length - 1];
}

/** The inline card always offers the response and original request. Failed
 * runs also expose diagnostics without changing the stable tab order. */
export function deriveCardTabs(task) {
  const tabs = ["response"];
  if (task?.status === "failed" || task?.status === "blocked" || task?.status === "needs-human") tabs.push("diagnostics");
  tabs.push("request");
  return tabs;
}

/** Successful terminal runs open on the useful result; the request is one
 * keystroke/click away and remains available for every task. */
export function defaultCardTab(task) {
  return "response";
}

export function nextCardTab(tabs, current, key) {
  const index = Math.max(0, tabs.indexOf(current));
  if (key === "ArrowRight" || key === "ArrowDown") return tabs[(index + 1) % tabs.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return tabs[(index - 1 + tabs.length) % tabs.length];
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs[tabs.length - 1];
  return current;
}
