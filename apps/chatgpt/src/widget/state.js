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
  if (task.error) return "Task failed";
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
 */
export function filterRows(rows, view) {
  if (view === "recent") return rows;
  return rows.filter((r) => r.group === "active" || r.group === "needs_attention");
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
