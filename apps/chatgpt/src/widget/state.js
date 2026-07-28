// Pure functions — no DOM, no fetch, no timers, no mutation. Testable in
// isolation (widget/state.test.ts) and inlined into shell.html by
// scripts/build-widget.mjs, which strips the trailing `export` block so the
// served resource is one self-contained <script> with no ES module syntax.
//
// Data contract: every function here consumes exactly what run_task/
// check_task/get_task/list_tasks/get_session already return (TaskSummary /
// JobSnapshot shapes from @clawconnect/core) — no widget-specific payload.
// See docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md §3.

/** Maps a TaskSummary's exact status to a display bucket. The exact status is never mutated — this is presentation grouping only (Active / Needs attention / Completed / Failed). */
export function groupStatus(status) {
  if (status === "running" || status === "queued") return "active";
  if (status === "blocked" || status === "needs-human") return "needs_attention";
  if (status === "done") return "completed";
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
    const oneLine = task.summary.replace(/\s+/g, " ").trim();
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
export function mergePinnedDetail(tasks, pinnedDetail) {
  if (!pinnedDetail) return tasks;
  const pinnedId = pinnedDetail.taskId ?? pinnedDetail.jobId;
  return tasks.map((t) => ((t.taskId ?? t.jobId) === pinnedId ? { ...t, ...pinnedDetail } : t));
}

/** Merges a get_session(mode:"tasks") read into a row's expanded task history, keyed by taskId. Exact per-task status is preserved — group is display-only, computed fresh per history entry. */
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
export function deriveDetailTabs(task) {
  const sections = deriveDetailSections(task);
  const tabs = ["overview"];
  if (sections.includes("artifacts")) tabs.push("artifacts");
  if (canReadPrompt(task)) tabs.push("prompt");
  return tabs;
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

export function filterTasksByScope(tasks, scope) {
  if (!scope.scoped) return tasks;
  const allowed = new Set(scope.sessionKeys ?? []);
  return tasks.filter((t) => allowed.has(t.sessionKey));
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
export function deriveTimeline(logs, maxRows = 4) {
  if (!logs || logs.length === 0) return [];
  const collapsed = [];
  for (const entry of logs) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.type === entry.type && last.text === entry.text) {
      last.count += 1;
      last.ts = entry.ts;
    } else {
      collapsed.push({ type: entry.type, text: entry.text, ts: entry.ts, count: 1 });
    }
  }
  return collapsed.slice(-maxRows).reverse();
}

/** The single most recent log entry, for a one-line "latest update" summary above the fuller timeline. */
export function deriveLatestUpdate(logs) {
  if (!logs || logs.length === 0) return null;
  return logs[logs.length - 1];
}
