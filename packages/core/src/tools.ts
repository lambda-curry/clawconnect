import { GatewayPool } from "./gateway-pool.ts";
import type {
  CheckTaskOpts,
  CheckTaskResult,
  ContinuationState,
  RunTaskResult,
  TaskInput,
} from "./types.ts";

export function runTask(pool: GatewayPool, input: TaskInput): RunTaskResult {
  const entry = pool.forAgent(input.agent);
  const job = entry.sessions.submitTask({
    task: input.task,
    context: input.context,
    sessionKey: input.sessionKey,
  });
  pool.rememberJob(job.jobId, entry.agent.id);
  return {
    jobId: job.jobId,
    sessionKey: job.sessionKey,
    status: "running",
    agent: entry.agent.id,
  };
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
  if (!entry) return notFound();

  const job = await entry.sessions.waitForJob(
    opts.jobId,
    opts.knownLogCount ?? 0,
    opts.sessionKey,
    opts.mode ?? "poll",
  );
  if (!job) return notFound();

  const snapshot = entry.sessions.buildSnapshot(job);
  return {
    found: true,
    snapshot: { ...snapshot, agent: entry.agent.id },
    isTerminal: job.status !== "running",
    isError: job.status === "error",
  };
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

