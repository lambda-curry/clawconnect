import { randomUUID } from "node:crypto";
import { emptyArtifacts, processEvent, extractPatternsFromSummary, deriveNextStep } from "./artifacts.ts";
import { classifyError } from "./errors.ts";
import { OpenClawGateway } from "./gateway.ts";
import type { CheckMode, ContinuationState, Job, JobSnapshot, TaskInput } from "./types.ts";

const TIMEOUT_MS = 600_000; // 10 minutes
const POLL_WAIT_MS = 50_000; // max time check waits before returning
const MAX_LOG_ENTRIES = 200;

const LEGACY_CHATGPT_SESSION_PREFIX = "agent:chatgpt:";

function logDebug(message: string): void {
  console.error(message);
}

function createThreadSessionKey(agentId: string): string {
  return `agent:${agentId}:main:thread:mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function resolveSessionKey(
  input: string | undefined,
  agentId: string,
): { sessionKey: string; migratedFromLegacy: boolean } {
  if (!input) return { sessionKey: createThreadSessionKey(agentId), migratedFromLegacy: false };
  if (input.startsWith(LEGACY_CHATGPT_SESSION_PREFIX)) {
    return { sessionKey: createThreadSessionKey(agentId), migratedFromLegacy: true };
  }
  return { sessionKey: input, migratedFromLegacy: false };
}

export class SessionManager {
  private jobs = new Map<string, Job>();
  private latestJobBySession = new Map<string, string>();
  private sessions = new Map<string, ContinuationState>();

  constructor(
    private readonly gateway: OpenClawGateway,
    private readonly agentId: string = "main",
  ) {}

  submitTask(input: TaskInput): Job {
    const message = input.context ? `${input.context}\n\n${input.task}` : input.task;

    const { sessionKey, migratedFromLegacy } = resolveSessionKey(input.sessionKey, this.agentId);
    const jobId = randomUUID();
    const artifacts = emptyArtifacts();
    const now = Date.now();
    const logs: Array<{ ts: number; type: string; text: string }> = [];

    if (!input.sessionKey) {
      logs.push({ ts: now, type: "lifecycle", text: `Started new Clawdy thread session: ${sessionKey}` });
    } else if (migratedFromLegacy) {
      logs.push({
        ts: now,
        type: "lifecycle",
        text: `Migrated legacy ChatGPT session to new Clawdy thread: ${sessionKey}`,
      });
    }

    const job: Job = {
      jobId,
      sessionKey,
      status: "running",
      startedAt: now,
      lastEventAt: logs.length > 0 ? now : 0,
      logs,
      artifacts,
    };
    this.jobs.set(jobId, job);
    this.latestJobBySession.set(sessionKey, jobId);
    this.sessions.set(sessionKey, {
      sessionKey,
      lastJobId: jobId,
      lastSummary: "",
      artifacts,
    });

    this.gateway
      .chat(sessionKey, message, TIMEOUT_MS, (event) => {
        job.lastEventAt = Date.now();
        if (job.logs.length < MAX_LOG_ENTRIES) {
          job.logs.push({ ts: Date.now(), type: event.type, text: event.text });
        }
        logDebug(`[job ${jobId.slice(0, 8)}] event #${job.logs.length}: ${event.type} - ${event.text.slice(0, 80)}`);
        processEvent(artifacts, event);
      })
      .then(
        (reply) => {
          job.lastEventAt = Date.now();
          const noSummary = !reply || reply === "Stream finished with no response collected.";
          job.status = noSummary ? "completed_no_summary" : "completed";
          job.summary = reply;
          extractPatternsFromSummary(artifacts, reply);
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: reply.slice(0, 500),
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, job.status),
          });
          logDebug(`[job ${jobId}] ${job.status}, ${reply.length} chars, ${artifacts.filesChanged.length} files`);
        },
        (err) => {
          job.lastEventAt = Date.now();
          job.status = "error";
          job.error = err instanceof Error ? err.message : String(err);
          job.errorInfo = classifyError(job.error);
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: job.error,
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, "error"),
          });
          logDebug(`[job ${jobId}] error (${job.errorInfo.category}): ${job.error}`);
        },
      );

    return job;
  }

  buildSnapshot(job: Job): JobSnapshot {
    const continuation = this.sessions.get(job.sessionKey);
    return {
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      status: job.status,
      startedAt: job.startedAt,
      lastEventAt: job.lastEventAt,
      lastPollAt: Date.now(),
      summary: job.summary,
      error: job.error,
      errorInfo: job.errorInfo,
      logs: job.logs,
      artifacts: job.artifacts,
      ...(continuation ? { continuationState: continuation } : {}),
    };
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  getLatestJobForSession(sessionKey: string): Job | undefined {
    const latestJobId = this.latestJobBySession.get(sessionKey) ?? this.sessions.get(sessionKey)?.lastJobId;
    return latestJobId ? this.jobs.get(latestJobId) : undefined;
  }

  getSessionState(sessionKey: string): ContinuationState | undefined {
    return this.sessions.get(sessionKey);
  }

  listSessions(): ContinuationState[] {
    return [...this.sessions.values()];
  }

  resolveJob(jobId?: string, sessionKey?: string): Job | undefined {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (job) return job;
    }
    if (sessionKey) {
      return this.getLatestJobForSession(sessionKey);
    }
    return undefined;
  }

  async waitForJob(
    jobId: string | undefined,
    knownLogCount = 0,
    sessionKey?: string,
    mode: CheckMode = "poll",
  ): Promise<Job | undefined> {
    const job = this.resolveJob(jobId, sessionKey);
    if (!job) {
      logDebug(`[waitForJob] no job found (jobId=${jobId?.slice(0, 8)}, session=${sessionKey?.slice(-8)})`);
      return undefined;
    }
    if (job.status !== "running") {
      logDebug(`[waitForJob] job ${job.jobId.slice(0, 8)} already ${job.status}, logs=${job.logs.length}`);
      return job;
    }
    logDebug(`[waitForJob] job ${job.jobId.slice(0, 8)} waiting mode=${mode} (known=${knownLogCount}, current=${job.logs.length})`);
    const deadline = Date.now() + POLL_WAIT_MS;
    while (Date.now() < deadline && job.status === "running") {
      await new Promise((r) => setTimeout(r, 500));
      // In "poll" mode: return early on new logs (live progress for widgets)
      // In "wait" mode: only return on terminal state or timeout (fewer round-trips for agentic use)
      if (mode === "poll" && job.logs.length > knownLogCount) {
        logDebug(`[waitForJob] job ${job.jobId.slice(0, 8)} has new logs (${job.logs.length} > ${knownLogCount})`);
        return job;
      }
    }
    logDebug(`[waitForJob] job ${job.jobId.slice(0, 8)} ${mode} timeout (logs=${job.logs.length}, status=${job.status})`);
    return job;
  }
}
