import { GatewayPool } from "./gateway-pool.ts";
import { recordTelemetry } from "./telemetry.ts";
import type {
  CheckTaskOpts,
  CheckTaskResult,
  ContinuationState,
  RunTaskResult,
  SessionInspectMode,
  SessionInspectResult,
  TaskPromptResult,
  TaskSummary,
  TaskInput,
} from "./types.ts";

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
    nextAction: { tool: "check_task", args: { taskId: job.jobId, sessionKey: job.sessionKey } },
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

function deriveTaskStatus(job: { status: string; error?: string; artifacts: { needsHumanDecision: boolean } }): TaskSummary["status"] {
  if (job.status === "running") return "running";
  if (job.status === "completed" || job.status === "completed_no_summary") return "done";
  if (job.artifacts.needsHumanDecision) return "needs-human";
  if (job.error?.includes("session busy")) return "blocked";
  return mapTaskStatus(job.status);
}

export function listTasks(pool: GatewayPool): TaskSummary[] {
  const start = Date.now();
  const items: TaskSummary[] = [];
  for (const entry of pool.allEntries()) {
    for (const session of entry.sessions.listSessions()) {
      const job = entry.sessions.getLatestJobForSession(session.sessionKey);
      if (!job) continue;
      items.push({
        taskId: job.jobId,
        jobId: job.jobId,
        sessionKey: job.sessionKey,
        agent: entry.agent.id,
        status: deriveTaskStatus(job),
        startedAt: job.startedAt,
        lastEventAt: job.lastEventAt,
        summary: job.summary,
        error: job.error,
      });
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

  const snapshot = entry.sessions.buildSnapshot(job);
  const isTerminal = job.status !== "running";
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
  });
  return {
    found: true,
    snapshot: { ...snapshot, agent: entry.agent.id },
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
export function getTask(pool: GatewayPool, opts: { jobId?: string; sessionKey?: string; agent?: string }): CheckTaskResult {
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

  const snapshot = entry.sessions.buildSnapshot(job);
  const isTerminal = job.status !== "running";
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
  });
  return {
    found: true,
    snapshot: { ...snapshot, agent: entry.agent.id },
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

export function listSessions(pool: GatewayPool): ContinuationState[] {
  const all: ContinuationState[] = [];
  for (const entry of pool.allEntries()) {
    for (const session of entry.sessions.listSessions()) {
      all.push({ ...session, agent: entry.agent.id });
    }
  }
  return all;
}

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
    ...(mode === "snapshot" ? {} : { events }),
    ...(mode === "tail" ? { nextAfter: after + events.length } : {}),
  };
}
