import { GatewayPool } from "./gateway-pool.ts";
import { LinearGatewayClient, createLinearGatewayClient } from "./linear-gateway.ts";
import type {
  CheckTaskOpts,
  CheckTaskResult,
  ContinuationState,
  RunTaskResult,
  SessionInspectMode,
  SessionInspectResult,
  TaskSummary,
  TaskInput,
} from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";

export function runTask(pool: GatewayPool, input: TaskInput): RunTaskResult {
  const entry = pool.forAgent(input.agent);
  const job = entry.sessions.submitTask({
    task: input.task,
    context: input.context,
    sessionKey: input.sessionKey,
    senderName: input.senderName,
  });
  pool.rememberJob(job.jobId, entry.agent.id);
  return {
    jobId: job.jobId,
    taskId: job.jobId,
    sessionKey: job.sessionKey,
    status: "running",
    agent: entry.agent.id,
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
        source: "openclaw",
      });
    }
  }
  return items;
}

/**
 * Fetch Linear Gateway task summaries and merge into the OpenClaw-derived list.
 * Non-blocking on errors — returns the OpenClaw-only list if the gateway is
 * unreachable or not configured.
 */
export async function listTasksWithLinear(
  pool: GatewayPool,
  linearClient: LinearGatewayClient | undefined,
): Promise<TaskSummary[]> {
  const openclawTasks = listTasks(pool);
  if (!linearClient) return openclawTasks;
  const linearTasks = await linearClient.fetchTaskSummaries();
  return [...openclawTasks, ...linearTasks];
}

function notFound(): CheckTaskResult {
  return { found: false };
}

export async function checkTask(pool: GatewayPool, opts: CheckTaskOpts): Promise<CheckTaskResult> {
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
  if (entry) {
    const job = await entry.sessions.waitForJob(
      opts.jobId,
      opts.knownLogCount ?? 0,
      opts.sessionKey,
      opts.mode ?? "poll",
    );
    if (job) {
      const snapshot = entry.sessions.buildSnapshot(job);
      return {
        found: true,
        snapshot: { ...snapshot, agent: entry.agent.id },
        isTerminal: job.status !== "running",
        isError: job.status === "error",
      };
    }
  }
  return notFound();
}

/**
 * checkTask that also looks up Linear Gateway runs when the OpenClaw pool
 * has no match. Falls back to the Linear Gateway for the given jobId/
 * sessionKey (which for Linear tasks IS the agentSessionId).
 */
export async function checkTaskWithLinear(
  pool: GatewayPool,
  opts: CheckTaskOpts,
  linearClient: LinearGatewayClient | undefined,
): Promise<CheckTaskResult> {
  // Try OpenClaw pool first
  const result = await checkTask(pool, opts);
  if (result.found) return result;

  // Fall back to Linear Gateway
  if (!linearClient) return notFound();

  // For Linear tasks, jobId is the agentSessionId
  const lookupId = opts.jobId ?? opts.sessionKey;
  if (!lookupId) return notFound();

  return linearClient.fetchCheckTask(lookupId);
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

/**
 * getSession that also checks the Linear Gateway for sessions not found
 * in the OpenClaw pool.
 */
export async function getSessionWithLinear(
  pool: GatewayPool,
  opts: { sessionId: string; mode?: SessionInspectMode; limit?: number; after?: number; agent?: string },
  linearClient: LinearGatewayClient | undefined,
): Promise<SessionInspectResult> {
  // Try OpenClaw pool first
  const result = getSession(pool, opts);
  if (result.found) return result;

  // Fall back to Linear Gateway
  if (!linearClient) return { found: false };
  return linearClient.fetchSession(
    opts.sessionId,
    opts.mode ?? "snapshot",
    opts.limit,
    opts.after,
  );
}
