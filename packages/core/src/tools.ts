import type { SessionManager } from "./session.ts";
import type {
  CheckTaskOpts,
  CheckTaskResult,
  ContinuationState,
  RunTaskResult,
  TaskInput,
} from "./types.ts";

export function runTask(sessions: SessionManager, input: TaskInput): RunTaskResult {
  const job = sessions.submitTask(input);
  return {
    jobId: job.jobId,
    sessionKey: job.sessionKey,
    status: "running",
  };
}

export async function checkTask(
  sessions: SessionManager,
  opts: CheckTaskOpts,
): Promise<CheckTaskResult> {
  const job = await sessions.waitForJob(
    opts.jobId,
    opts.knownLogCount ?? 0,
    opts.sessionKey,
    opts.mode ?? "poll",
  );

  if (!job) {
    return { found: false };
  }

  const snapshot = sessions.buildSnapshot(job);
  return {
    found: true,
    snapshot,
    isTerminal: job.status !== "running",
    isError: job.status === "error",
  };
}

export function listSessions(sessions: SessionManager): ContinuationState[] {
  return sessions.listSessions();
}
