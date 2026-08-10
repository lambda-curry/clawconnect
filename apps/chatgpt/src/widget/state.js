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
 * @property {"running"|"completed"|"failed"|"cancelled"} [execution]
 * @property {"connected"|"reconnecting"|"unavailable"} [upstream]
 * @property {"live"|"replaying"|"detached"|"complete"} [transcript]
 * @property {"none"|"requested"|"acknowledged"|"reconciled"} [cancellation]
 * @property {number} [startedAt]
 * @property {number} [lastEventAt]
 * @property {string} [summary]
 * @property {string} [error]
 * @property {{ message?: string, category?: string }} [errorInfo]
 * @property {{ filesChanged?: string[], commandsRun?: string[], branchName?: string, commitSha?: string, prUrl?: string }} [artifacts]
 * @property {LogEntry[]} [updates]
 * @property {LogEntry[]} [logs]
 * @property {{ reason?: string }} [recovery]
 * @property {{ checkedAt: number, upstream: "active"|"unknown", producing: boolean }} [liveness]
 * @property {string} [parentRunId]
 * @property {AgentSession} [agentSession]
 *
 * The session's CURRENT managed-session attachment, when the turn delegated to
 * one. `handle` is the id the runtime publishes (for the Fleet runtime, the
 * Fleet run); `providerSessionId` is the coding session running inside it.
 * @typedef {object} AgentSession
 * @property {string} id
 * @property {string} runtime
 * @property {string} handle
 * @property {string} [providerSessionId]
 * @property {string} [host]
 * @property {string} [worktree]
 * @property {string} status
 * @property {number} [lastObservedAt]
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
 * Whether a get_task payload is an actual task snapshot rather than an error
 * envelope. app.ts answers a pruned/unauthorized id with
 * `{ taskId, status: "error", error: "Task not found." }` — which carries an id,
 * so an id check alone accepts it, and mergePinnedDetail then overwrites a
 * perfectly good row with it. That directly undoes the retention guarantee: the
 * card holds a task the read omitted, then replaces it with the not-found reply
 * to the very same id.
 *
 * `sessionKey` is the discriminator, not `status`: "error" is a real JobStatus
 * (see packages/core/src/types.ts) for a job that genuinely failed, and
 * discarding those would lose the diagnostics the card exists to show. Every
 * real snapshot carries sessionKey; the error envelope never does. It is also
 * what a row is keyed by — buildSessionRows would file a sessionKey-less
 * payload under `undefined` and invent a bogus session row.
 *
 * @param {Partial<WidgetTask> | null | undefined} snapshot @returns {boolean}
 */
export function isTaskSnapshot(snapshot) {
  if (!snapshot) return false;
  const id = snapshot.taskId ?? snapshot.jobId;
  return typeof id === "string" && id.length > 0 && typeof snapshot.sessionKey === "string" && snapshot.sessionKey.length > 0;
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
 * The inline card's tab set — "response" always, "diagnostics" only when the
 * task actually carries error detail, "request" only when the id is
 * resolvable (canReadPrompt). Never offer a tab that would open onto nothing.
 */
/** @param {Partial<WidgetTask>} task @returns {("response" | "diagnostics" | "request")[]} */
export function deriveCardTabs(task) {
  const tabs = ["response"];
  // Status first, error-detail second. Keying off .error alone misses a failed
  // task whose message never landed, and core sets .error to a session-busy
  // string for status="blocked" — so status is the reliable signal and the
  // error fields are the fallback for anything it does not cover.
  const problem = task?.status === "failed" || task?.status === "blocked" || task?.status === "needs-human";
  // A delegated turn earns the tab even when nothing is wrong: the Fleet run
  // and coding-session ids live there, and they are exactly what an operator
  // needs while the work is still HEALTHY — to attach to it, or to tell it
  // apart from a duplicate. Offering the tab only on failure means the ids
  // appear only once they are least useful.
  const delegated = deriveDelegationIdentity(task) !== null;
  if (problem || delegated || task?.error || task?.errorInfo) tabs.push("diagnostics");
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

/**
 * Compact's own pinned session — deliberately separate from the fullscreen
 * Task Center's selection, and from the canonical task list both surfaces read.
 * The Task Center is a *wider view* over the same data (every session, every
 * group); if opening it could rewrite what the compact card is pinned to, or
 * what it is allowed to see, then closing it would leave the compact card
 * rendering the Task Center's contents. So compact keeps its own selection and
 * re-resolves it here whenever it comes back into view.
 *
 * `visibleTasks` is the compact-visible slice (already scope-filtered — see
 * filterTasksByScope), never the canonical list.
 *
 * 1. The previous selection, while it still has work in view — a polling card
 *    must not re-pin itself out from under the user every cycle.
 * 2. The mounted run: this card's own subject, authoritative even once it
 *    finishes and drops out of list_tasks(view:"active") — that's the row
 *    ensurePinnedTask puts back.
 * 3. Otherwise re-run the policy from scratch — the most recently active
 *    non-terminal session. A session that disappeared while the Task Center
 *    was open therefore hands focus to real live work rather than leaving a
 *    dangling pin. Terminal-only is deliberately left unpinned: a pin forces
 *    its row past the Active filter (see filterRows), and an unmounted card
 *    shouldn't resurrect finished work nobody asked about.
 *
 * @param {{ sessionKey?: string } | null} mounted
 * @param {WidgetTask[]} visibleTasks
 * @param {string | null} [previousSessionKey]
 * @returns {string | undefined}
 */
export function resolveCompactSelection(mounted, visibleTasks, previousSessionKey) {
  const tasks = visibleTasks ?? [];
  if (previousSessionKey && tasks.some((t) => t.sessionKey === previousSessionKey)) return previousSessionKey;
  if (mounted?.sessionKey) return mounted.sessionKey;
  let newest;
  for (const task of tasks) {
    if (isTerminalGroup(groupStatus(task.status))) continue;
    if (!newest || (task.lastEventAt ?? 0) > (newest.lastEventAt ?? 0)) newest = task;
  }
  return newest?.sessionKey;
}

/** @param {WidgetTask[]} tasks @param {{ scoped: boolean, sessionKeys: string[] | null }} scope @returns {WidgetTask[]} */
export function filterTasksByScope(tasks, scope) {
  if (!scope.scoped) return tasks;
  const allowed = new Set(scope.sessionKeys ?? []);
  return tasks.filter((t) => allowed.has(t.sessionKey));
}

/**
 * Folds a fresh read into the canonical store, preserving three things at once:
 *
 * 1. A transient empty response (suspended/backgrounded host resuming) must not
 *    blank out known live work. A later snapshot can still replace it.
 * 2. A read can legitimately omit a task we already know about — a task can be
 *    pruned server-side, and list_tasks(view:"active") drops one the instant it
 *    finishes, which is exactly the transition the card exists to show.
 *    Replacing wholesale meant a run that completed while other work was still
 *    active vanished instead of showing its summary. So: merge by taskId,
 *    incoming always wins for a task it contains, omitted prior entries stay.
 * 3. That retention has to be *bounded*, or an unscoped read (the card reads
 *    view:"all" so state is complete and the view filters — see refresh()) would
 *    accumulate every task of every conversation for the life of the card, and
 *    shouldPoll would never settle. `retainSessionKeys` is that bound: the
 *    sessions this card actually knows about. Everything else is re-supplied
 *    whole by the next read, which is all the Task Center needs.
 *
 * Passing no bound retains everything, which is what a caller that has already
 * narrowed `previous` wants.
 *
 * @param {WidgetTask[]} previous @param {WidgetTask[]} next
 * @param {Iterable<string>} [retainSessionKeys]
 * @returns {WidgetTask[]}
 */
export function reconcileTaskList(previous, next, retainSessionKeys) {
  const prior = previous ?? [];
  const incoming = next ?? [];
  const hadLiveWork = prior.some((task) => !isTerminalGroup(groupStatus(task.status)));
  if (incoming.length === 0) return hadLiveWork ? prior : incoming;

  const retain = retainSessionKeys ? new Set(retainSessionKeys) : null;
  const byId = new Map();
  const keyOf = (t) => t.taskId ?? t.jobId;
  for (const task of prior) {
    if (retain && !retain.has(task.sessionKey)) continue;
    byId.set(keyOf(task), task);
  }
  for (const task of incoming) byId.set(keyOf(task), task);
  return [...byId.values()];
}

/**
 * A status label like "<agent> is working…" is not evidence — it's a claim.
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

/**
 * Silence is not stalling. A coding agent inside a long shell command, a
 * compaction pass, or an extended reasoning stretch emits nothing for minutes
 * and is perfectly healthy, so a threshold on `lastEventAt` alone can only
 * ever guess — and this one guessed at 90s, which was WRONG BY CONSTRUCTION:
 * the server does not even ask upstream whether the run is alive until it has
 * been quiet for RECONCILE_QUIET_MS (120s, packages/core/src/session.ts). The
 * card was accusing a task of being stuck a full 30 seconds before anything
 * had looked. Observed live: healthy sessions labelled "may be stuck" while
 * they were mid-command.
 *
 * So quiet now starts no earlier than the server's own first check, and
 * "stalled" is never claimed from stillness alone — it needs the server's
 * liveness evidence to have come back with nothing, and it needs the silence
 * to have gone on long enough that a normal quiet stretch is ruled out.
 */
const QUIET_THRESHOLD_MS = 120_000;
const STALLED_THRESHOLD_MS = 7 * 60_000;
/** A liveness check older than this says nothing about the run's state now. */
const LIVENESS_FRESH_MS = 5 * 60_000;

export function isStale(lastEventAt, now, thresholdMs = QUIET_THRESHOLD_MS) {
  return now - lastEventAt > thresholdMs;
}

/**
 * Working / quiet / stalled, from every signal available rather than one clock.
 *
 * `liveness` is the server's upstream check (see JobLiveness). Its ABSENCE is
 * not bad news — it means the run has not been quiet long enough to warrant a
 * check — and `upstream: "unknown"` is the absence of positive evidence, not
 * evidence of death. Only when a *fresh* check found neither an active run nor
 * a transcript advancing, and the silence has outlasted STALLED_THRESHOLD_MS,
 * do the signals actually agree that something may be wrong.
 */
export function deriveLivenessState(task, now) {
  const group = groupStatus(task.status);
  if (isTerminalGroup(group)) return "finished";
  if (!isStale(task.lastEventAt, now)) return "working";

  const liveness = task.liveness;
  const checkIsFresh = liveness != null && now - liveness.checkedAt <= LIVENESS_FRESH_MS;
  if (checkIsFresh && (liveness.upstream === "active" || liveness.producing)) return "quiet";
  if (!checkIsFresh) return "quiet"; // nothing has looked recently — say so, don't accuse
  return now - task.lastEventAt > STALLED_THRESHOLD_MS ? "stalled" : "quiet";
}

/**
 * Three things can independently be wrong, and collapsing them is why a
 * transport hiccup read as a dead task:
 *
 *   the task        — running / finished / failed, decided upstream
 *   the connector   — can this card reach the server right now (pollFailures)
 *   the chat stream — did the reply that dispatched the task survive
 *
 * Only the first is the work. The other two are ways of *looking* at it, and
 * neither failing means the task did. `recovery` is the server telling us the
 * originating reply ended before the answer arrived — the job is explicitly
 * still going and being recovered, so the copy has to say so rather than
 * report a bare "connection interrupted" over work that is fine.
 */
/**
 * @param {{
 *   pollFailures?: number,
 *   recovery?: { reason?: string } | null,
 *   upstream?: "connected"|"reconnecting"|"unavailable",
 *   transcript?: "live"|"replaying"|"detached"|"complete"
 * }} [options]
 */
export function deriveConnectionNotice({
  pollFailures = 0,
  recovery = null,
  upstream,
  transcript,
} = {}) {
  if (upstream === "unavailable") {
    return {
      connector: pollFailures >= 2 ? "reconnecting" : "connected",
      stream: "detached",
      text: "Upstream is unavailable. The connector is reconciling execution separately and will not assume the task stopped.",
    };
  }
  if (transcript === "replaying") {
    return {
      connector: pollFailures >= 2 ? "reconnecting" : "connected",
      stream: "replaying",
      text: "Replaying missed upstream transcript events before live progress resumes.",
    };
  }
  if (transcript === "detached") {
    return {
      connector: pollFailures >= 2 ? "reconnecting" : "connected",
      stream: "detached",
      text: "Transcript transport detached; the task may still be running upstream while the connector reconnects.",
    };
  }
  const streamEnded =
    recovery != null &&
    typeof recovery === "object" &&
    (recovery.reason === "no_live_final_text" || recovery.reason === "parent_observation_timeout");
  const connector = pollFailures >= 2 ? "reconnecting" : "connected";
  const stream = streamEnded ? "interrupted" : "active";
  // The task's own state is never asserted here — it has its own pill.
  if (streamEnded) {
    return { connector, stream, text: "The chat connection ended, but the task is still running — reconnecting to it." };
  }
  if (connector === "reconnecting") {
    return { connector, stream, text: "Reconnecting to the task — it keeps running either way." };
  }
  return { connector, stream, text: null };
}

/** Ties a task's group to the evidence behind it: how long ago its last real event landed, and what the server's liveness check found. */
export function deriveActivityLabel(task, now) {
  const elapsed = now - task.lastEventAt;
  const state = deriveLivenessState(task, now);
  if (state === "finished") return `finished ${formatElapsed(elapsed)} ago`;
  if (state === "working") return `active ${formatElapsed(elapsed)} ago`;
  if (state === "stalled") return `possibly stalled · no activity for ${formatElapsed(elapsed)}`;
  return `working quietly · last activity ${formatElapsed(elapsed)} ago`;
}

/**
 * get_task's diagnostics presets nest `error`/`errorInfo` under a `diagnostics`
 * object, while every other surface this card reads (list_tasks' TaskSummary,
 * check_task's whole snapshot) carries them at the top level. Flatten the one
 * shape into the other so the rest of the widget has a single place to read a
 * failure from.
 *
 * Top level wins on conflict: a TaskSummary row's `error` is the row the card
 * already merged, and a diagnostics block that came back empty must not blank
 * it out.
 *
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @returns {Record<string, unknown> | null | undefined}
 */
export function normalizeDiagnostics(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const diagnostics = snapshot.diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return snapshot;
  return {
    ...snapshot,
    error: snapshot.error ?? diagnostics.error,
    errorInfo: snapshot.errorInfo ?? diagnostics.errorInfo,
    recovery: snapshot.recovery ?? diagnostics.recovery,
    continuationState: snapshot.continuationState ?? diagnostics.continuationState,
  };
}

/**
 * Who is actually doing the work, by id, when the turn delegated to a managed
 * session. This card is the only place an operator sees the delegation at all,
 * and "a Fleet run is going" without the run's id is not something anyone can
 * act on — you cannot attach to it, read its transcript, or tell it apart from
 * a duplicate. So the ids are surfaced verbatim, never truncated: a prefix is
 * enough to recognise an id you already have and useless for looking one up.
 *
 * Returns null when nothing was delegated, which is the common case — a plain
 * turn must not grow an empty "delegated to" block.
 *
 * @param {Partial<WidgetTask> | undefined} task
 * @returns {{ runtime: string, fleetRunId: string, codingSessionId: string | null, worktree: string | null, host: string | null, status: string } | null}
 */
export function deriveDelegationIdentity(task) {
  const session = task?.agentSession;
  if (!session || typeof session !== "object") return null;
  if (!session.handle) return null;
  return {
    runtime: session.runtime ?? "unknown",
    fleetRunId: session.handle,
    codingSessionId: session.providerSessionId ?? null,
    worktree: session.worktree ?? null,
    host: session.host ?? null,
    status: session.status ?? "unknown",
  };
}

/**
 * What the server last learned from upstream, and what it is doing about it —
 * the two facts that make a quiet card readable instead of ominous.
 *
 * Deliberately dates the evidence rather than asserting the present tense.
 * `liveness.checkedAt` is when a read actually REACHED upstream (see
 * JobLiveness), so a stretch of unreadable reads ages it; reporting that as
 * "upstream is active" would manufacture a confirmation nobody made. Past
 * LIVENESS_FRESH_MS the claim is dropped entirely rather than shown stale.
 *
 * @param {Partial<WidgetTask> | undefined} task
 * @param {number} now
 * @returns {{ upstream: string | null, checkedAgo: string | null, recoveryAction: string | null, runId: string | null }}
 */
export function deriveUpstreamEvidence(task, now) {
  const liveness = task?.liveness;
  const fresh = liveness != null && now - liveness.checkedAt <= LIVENESS_FRESH_MS;
  const recoveryReason = task?.recovery?.reason;
  return {
    upstream: fresh ? (liveness.upstream === "active" ? "run executing" : "no positive signal") : null,
    checkedAgo: fresh ? `${formatElapsed(now - liveness.checkedAt)} ago` : null,
    // The card says what is being DONE, not just that something is wrong —
    // a "recovering" state with no stated action reads as a stall.
    recoveryAction: recoveryReason
      ? "Re-reading the durable transcript for the final response — upstream work may still be active."
      : null,
    runId: task?.parentRunId ?? null,
  };
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

/** Client-side ring buffer cap — check_task/get_task now return a bounded
 *  per-poll delta (see packages/core/src/log-projection.ts), so the client
 *  is what accumulates a short recent-activity history across polls. */
export const RING_BUFFER_MAX = 20;

/**
 * Appends a poll's delta events onto a per-task ring buffer, capped at
 * RING_BUFFER_MAX (oldest dropped first), deduplicated by `seq` — a
 * defensive guard, not a correctness dependency: the server-side cursor
 * already guarantees no entry is resent, but a client that raced two
 * overlapping reads for the same task should still never render a
 * duplicate row.
 */
/** @param {LogEntry[] | undefined} existing @param {LogEntry[] | undefined} delta @param {number} [max] @returns {LogEntry[]} */
export function mergeRingBuffer(existing, delta, max = RING_BUFFER_MAX) {
  const prior = existing ?? [];
  const fresh = delta ?? [];
  if (fresh.length === 0) return prior;
  const seenSeqs = new Set(prior.map((e) => e.seq).filter((s) => s !== undefined));
  const merged = [...prior, ...fresh.filter((e) => e.seq === undefined || !seenSeqs.has(e.seq))];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Render-cadence decision: a status-group transition (including the very
 * first render) is always immediate — that's a real lifecycle/terminal
 * change, the user is owed an up-to-date view right away. Cosmetic activity
 * (same group, just new ring-buffer entries) is worth debouncing so a
 * quick run of polls doesn't thrash the DOM once per cycle.
 */
/** @param {string | null} prevGroup @param {string} nextGroup @returns {boolean} */
export function shouldRenderImmediately(prevGroup, nextGroup) {
  return prevGroup == null || prevGroup !== nextGroup;
}

export function nextCardTab(tabs, current, key) {
  const index = Math.max(0, tabs.indexOf(current));
  if (key === "ArrowRight" || key === "ArrowDown") return tabs[(index + 1) % tabs.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return tabs[(index - 1 + tabs.length) % tabs.length];
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs[tabs.length - 1];
  return current;
}
