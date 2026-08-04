import { blockedDelegation, isDelegateBlockedTerminalReason, type BlockedDelegation } from "./agent-session.ts";
import { GatewayPool } from "./gateway-pool.ts";
import { recordTelemetry } from "./telemetry.ts";
import type {
  CheckTaskOpts,
  CheckTaskResult,
  ContinuationState,
  AgentSessionAttachment,
  Job,
  RunTaskResult,
  SessionInspectMode,
  SessionInspectResult,
  TaskPromptResult,
  TaskSummary,
  TaskInput,
} from "./types.ts";

/**
 * Wire-payload size estimate for telemetry only — never logged content, just
 * a byte count. Close enough to the real structuredContent size (which adds
 * `isTerminal`/`isError`, ~20 bytes) without needing to import the
 * structured-content builder here.
 */
function measurePayloadBytes(snapshot: unknown): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

export function runTask(pool: GatewayPool, input: TaskInput): RunTaskResult {
  const start = Date.now();
  const entry = pool.forAgent(input.agent);
  const job = entry.sessions.submitTask({
    task: input.task,
    context: input.context,
    sessionKey: input.sessionKey,
    senderName: input.senderName,
  });
  pool.rememberJob(job.jobId, entry.agent.id);
  recordTelemetry({
    tool: "run_task",
    jobId: job.jobId,
    taskId: job.jobId,
    sessionKey: job.sessionKey,
    agent: entry.agent.id,
    status: job.status,
    durationMs: Date.now() - start,
    duplicateJob: job.errorInfo?.message === "session busy",
  });
  return {
    jobId: job.jobId,
    taskId: job.jobId,
    sessionKey: job.sessionKey,
    status: "running",
    agent: entry.agent.id,
    // args keys are check_task's own parameter names — see NextAction.
    nextAction: { tool: "check_task", args: { jobId: job.jobId, sessionKey: job.sessionKey } },
  };
}

function mapTaskStatus(status: string): TaskSummary["status"] {
  if (status === "running") return "running";
  if (status === "completed" || status === "completed_no_summary") return "done";
  if (status === "needs-human") return "needs-human";
  if (status === "blocked") return "blocked";
  if (status === "queued") return "queued";
  return "failed";
}

function deriveTaskStatus(
  job: {
    status: string;
    error?: string;
    terminalReason?: string;
    artifacts: { needsHumanDecision: boolean };
  },
  blocked: BlockedDelegation | undefined,
): TaskSummary["status"] {
  // A turn whose delegated session is waiting on a human is NOT simply
  // "running", even while the parent job still is: the child blocks long
  // before the parent turn ends, so a row that says only "running" is how a
  // live, actionable block goes unnoticed for as long as anyone keeps polling.
  if (blocked) return "needs-human";
  if (job.status === "running") return "running";
  // The same fact for a turn that ENDED with nothing to show because of the
  // block. Checked before the terminal mapping below, and only for that one
  // terminalReason, so every ordinary terminal job keeps its existing status.
  if (isDelegateBlockedTerminalReason(job.terminalReason)) return "needs-human";
  if (job.status === "completed" || job.status === "completed_no_summary") return "done";
  if (job.artifacts.needsHumanDecision) return "needs-human";
  if (job.error?.includes("session busy")) return "blocked";
  return mapTaskStatus(job.status);
}

/**
 * Cap on the `summary` preview carried by a TaskSummary row. list_tasks and
 * get_session(mode:"tasks") are listings — one row per session/job — so an
 * unbounded summary per row multiplies the whole response by however many
 * tasks exist. get_task is the read path that returns the summary in full.
 */
export const TASK_SUMMARY_PREVIEW_MAX = 500;

/**
 * The same cap, for a blocked delegation's notice. The notice embeds the
 * child's last message, which is bounded but not short — so on a listing it
 * gets the same treatment `summary` does. The full text is on the task itself
 * (get_task) and in check_task's own response.
 */
export const TASK_BLOCKED_NOTICE_MAX = 500;

function previewSummary(summary: string | undefined): Pick<TaskSummary, "summary" | "summaryTruncated"> {
  if (summary === undefined) return {};
  if (summary.length <= TASK_SUMMARY_PREVIEW_MAX) return { summary };
  return { summary: `${summary.slice(0, TASK_SUMMARY_PREVIEW_MAX - 1)}…`, summaryTruncated: true };
}

function previewBlockedDelegation(blocked: BlockedDelegation | undefined): BlockedDelegation | undefined {
  if (!blocked || blocked.notice.length <= TASK_BLOCKED_NOTICE_MAX) return blocked;
  return { ...blocked, notice: `${blocked.notice.slice(0, TASK_BLOCKED_NOTICE_MAX - 1)}…` };
}

/**
 * The one place a Job becomes a listing row, so list_tasks and
 * get_session(mode:"tasks") can't drift — including on whether the row's turn
 * is waiting on a human. `attachment` is the session's CURRENT attachment;
 * whether it has anything to say about THIS row is decided by
 * blockedDelegation's delegated-turn check, not by the caller.
 */
function toTaskSummary(job: Job, agentId: string, attachment?: AgentSessionAttachment): TaskSummary {
  const blocked = previewBlockedDelegation(
    blockedDelegation({ jobId: job.jobId, status: job.status, agentSession: attachment }),
  );
  return {
    taskId: job.jobId,
    jobId: job.jobId,
    sessionKey: job.sessionKey,
    agent: agentId,
    status: deriveTaskStatus(job, blocked),
    startedAt: job.startedAt,
    lastEventAt: job.lastEventAt,
    // Carried per row: without it a listing can only see stillness, and a
    // caller would have to get_task every quiet row to tell working from stuck.
    ...(job.liveness ? { liveness: job.liveness } : {}),
    ...previewSummary(job.summary),
    error: job.error,
    ...(blocked ? { blockedDelegation: blocked } : {}),
  };
}

export function listTasks(pool: GatewayPool): TaskSummary[] {
  const start = Date.now();
  const items: TaskSummary[] = [];
  for (const entry of pool.allEntries()) {
    for (const session of entry.sessions.listSessions()) {
      const job = entry.sessions.getLatestJobForSession(session.sessionKey);
      if (!job) continue;
      // Reads the ONE attachment this session already has — the same
      // per-session lookup get_session does, never a scan across sessions.
      items.push(toTaskSummary(job, entry.agent.id, entry.sessions.getAgentSessionAttachment(session.sessionKey)));
    }
  }
  recordTelemetry({ tool: "list_tasks", taskCount: items.length, durationMs: Date.now() - start });
  return items;
}

function notFound(): CheckTaskResult {
  return { found: false };
}

/** Shared entry-resolution logic for checkTask/getTask/getTaskPrompt. */
function resolvePoolEntry(pool: GatewayPool, opts: { jobId?: string; sessionKey?: string; agent?: string }) {
  let entry = opts.agent ? pool.forAgent(opts.agent) : undefined;
  if (!entry && opts.jobId) entry = pool.forJob(opts.jobId);
  if (!entry && opts.sessionKey) entry = pool.forSession(opts.sessionKey);
  if (!entry) {
    // Defensive scan in case the jobId index was cleared but sessions remain.
    for (const candidate of pool.allEntries()) {
      const job = candidate.sessions.resolveJob(opts.jobId, opts.sessionKey);
      if (job) {
        entry = candidate;
        break;
      }
    }
  }
  return entry;
}

/**
 * check_task: the only tool that waits. Blocks for up to opts.waitMs (default
 * 45s, clamped) and returns early on a terminal status. A timeout return is
 * non-terminal — continuePolling is true and nextAction says to call again.
 */
export async function checkTask(pool: GatewayPool, opts: CheckTaskOpts): Promise<CheckTaskResult> {
  const start = Date.now();
  const entry = resolvePoolEntry(pool, opts);
  if (!entry) {
    recordTelemetry({ tool: "check_task", jobId: opts.jobId, sessionKey: opts.sessionKey, requestedWaitMs: opts.waitMs, status: "not_found", durationMs: Date.now() - start });
    return notFound();
  }

  const job = await entry.sessions.waitForJob(
    opts.jobId,
    opts.knownLogCount ?? 0,
    opts.sessionKey,
    opts.mode ?? "poll",
    opts.waitMs,
  );
  if (!job) {
    recordTelemetry({ tool: "check_task", jobId: opts.jobId, sessionKey: opts.sessionKey, agent: entry.agent.id, requestedWaitMs: opts.waitMs, status: "not_found", durationMs: Date.now() - start });
    return notFound();
  }

  const snapshot = entry.sessions.buildSnapshot(job, opts.knownLogCount);
  const isTerminal = job.status !== "running";
  const withAgent = { ...snapshot, agent: entry.agent.id };
  recordTelemetry({
    tool: "check_task",
    jobId: job.jobId,
    taskId: job.jobId,
    sessionKey: job.sessionKey,
    agent: entry.agent.id,
    pollCount: job.pollCount,
    requestedWaitMs: opts.waitMs,
    status: job.status,
    durationMs: Date.now() - start,
    terminalRetrieval: isTerminal,
    payloadBytes: measurePayloadBytes(withAgent),
    logEventsReturned: snapshot.logs.length,
    logCursor: snapshot.logCursor,
  });
  return {
    found: true,
    snapshot: withAgent,
    isTerminal,
    isError: job.status === "error",
    continuePolling: !isTerminal,
  };
}

/**
 * get_task: an immediate snapshot, never waits. Resolves whatever state
 * exists right now — including status="running" if that's the truth. This is
 * what distinguishes it from check_task (contract decision 6).
 */
export function getTask(
  pool: GatewayPool,
  opts: { jobId?: string; sessionKey?: string; agent?: string; knownLogCount?: number },
): CheckTaskResult {
  const start = Date.now();
  const entry = resolvePoolEntry(pool, opts);
  if (!entry) {
    recordTelemetry({ tool: "get_task", jobId: opts.jobId, sessionKey: opts.sessionKey, status: "not_found", durationMs: Date.now() - start });
    return notFound();
  }
  const job = entry.sessions.resolveJob(opts.jobId, opts.sessionKey);
  if (!job) {
    recordTelemetry({ tool: "get_task", jobId: opts.jobId, sessionKey: opts.sessionKey, agent: entry.agent.id, status: "not_found", durationMs: Date.now() - start });
    return notFound();
  }

  const snapshot = entry.sessions.buildSnapshot(job, opts.knownLogCount);
  const isTerminal = job.status !== "running";
  const withAgent = { ...snapshot, agent: entry.agent.id };
  recordTelemetry({
    tool: "get_task",
    jobId: job.jobId,
    taskId: job.jobId,
    sessionKey: job.sessionKey,
    agent: entry.agent.id,
    pollCount: job.pollCount,
    status: job.status,
    durationMs: Date.now() - start,
    terminalRetrieval: isTerminal,
    payloadBytes: measurePayloadBytes(withAgent),
    logEventsReturned: snapshot.logs.length,
    logCursor: snapshot.logCursor,
  });
  return {
    found: true,
    snapshot: withAgent,
    isTerminal,
    isError: job.status === "error",
    continuePolling: !isTerminal,
  };
}

/**
 * get_task detail="prompt": the original submitted task/context/senderName.
 * Never included in check_task/get_task's normal snapshot — a separate read
 * path, gated by the same per-agent scope authorization as everything else
 * (enforced by the caller, same as any other out-of-scope job access).
 */
export function getTaskPrompt(
  pool: GatewayPool,
  opts: { jobId?: string; sessionKey?: string; agent?: string },
): TaskPromptResult {
  const entry = resolvePoolEntry(pool, opts);
  if (!entry) return { found: false };
  const job = entry.sessions.resolveJob(opts.jobId, opts.sessionKey);
  if (!job) return { found: false };
  return { found: true, prompt: job.prompt };
}

/**
 * list_sessions: every session this connector currently knows about, not
 * just the ones with work in flight. A session is recorded on its first
 * run_task and kept (with its latest continuation state) until the process
 * restarts, so completed threads stay listed — that's what makes the
 * sessionKey re-usable for a follow-up task.
 */
export function listSessions(pool: GatewayPool): ContinuationState[] {
  const all: ContinuationState[] = [];
  for (const entry of pool.allEntries()) {
    for (const session of entry.sessions.listSessions()) {
      all.push({ ...session, agent: entry.agent.id });
    }
  }
  return all;
}

/**
 * get_session: debug-level inspection of one session's latest job.
 *
 * `mode:"tail"` is FORWARD pagination, not a "last N lines" tail: it returns
 * up to `limit` events starting at `after` (oldest-first) and hands back
 * `nextAfter` to pass as the next call's `after`. Pagination is exhausted
 * when fewer than `limit` events come back (equivalently, when `nextAfter`
 * stops advancing). `after`/`nextAfter` are get_session's own event offsets
 * and are NOT interchangeable with check_task/get_task's `logCursor`.
 */
export function getSession(
  pool: GatewayPool,
  opts: { sessionId: string; mode?: SessionInspectMode; limit?: number; after?: number; agent?: string },
): SessionInspectResult {
  let entry = opts.agent ? pool.forAgent(opts.agent) : pool.forSession(opts.sessionId);
  if (!entry) {
    for (const candidate of pool.allEntries()) {
      if (candidate.sessions.getSessionState(opts.sessionId)) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return { found: false };
  const job = entry.sessions.getLatestJobForSession(opts.sessionId);
  if (!job) return { found: false };

  const mode = opts.mode ?? "snapshot";
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const after = Math.max(0, opts.after ?? 0);
  const events = job.logs.slice(after, after + limit);

  const agentSession = entry.sessions.getAgentSessionAttachment(opts.sessionId);

  const tasks: TaskSummary[] | undefined =
    mode === "tasks"
      ? entry.sessions
          .getJobHistory(opts.sessionId)
          .map((historyJob) => toTaskSummary(historyJob, entry.agent.id, agentSession))
      : undefined;

  return {
    found: true,
    sessionKey: job.sessionKey,
    agent: entry.agent.id,
    jobId: job.jobId,
    status: job.status,
    startedAt: job.startedAt,
    lastEventAt: job.lastEventAt,
    summary: job.summary,
    error: job.error,
    ...(mode === "snapshot" || mode === "tasks" ? {} : { events }),
    ...(mode === "tail" ? { nextAfter: after + events.length } : {}),
    ...(tasks ? { tasks } : {}),
    ...(agentSession ? { agentSession } : {}),
  };
}
