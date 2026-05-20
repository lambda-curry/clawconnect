import { randomUUID } from "node:crypto";
import { emptyArtifacts, processEvent, extractPatternsFromSummary, deriveNextStep } from "./artifacts.ts";
import { classifyError } from "./errors.ts";
import { OpenClawGateway } from "./gateway.ts";
import type { CheckMode, ContinuationState, Job, JobSnapshot, TaskInput } from "./types.ts";

function readEnvMs(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

// Live chat() wait. Bumped from the original 10 min so long natural runs
// (no overflow, no early lifecycle:end) get a chance to resolve normally
// instead of timing out into job.status = "error". Override via env if a
// deployment needs different bounds.
const TIMEOUT_MS = readEnvMs("CLAWCONNECT_TIMEOUT_MS", 30 * 60_000); // 30 min
// Recovery window after chat() resolves with the sentinel. Adaptive: stops
// when the transcript stabilizes (the agent's final answer landed) OR when
// it's been quiet for `idleTimeoutMs` (the agent went silent without
// writing visible text). The cap below is the absolute safety ceiling for
// runs that produce activity forever without ever stabilizing.
const RECOVERY_TIMEOUT_MS = readEnvMs("CLAWCONNECT_RECOVERY_TIMEOUT_MS", 90 * 60_000); // 90 min
// Stale-job reconciliation thresholds. A running job is promoted to
// completed_no_summary (with staleReason) when:
// 1. Its logs contain a terminal lifecycle event ("Agent finished") AND
//    lastEventAt is older than LIFECYCLE_STALE_THRESHOLD_MS.
// 2. lastEventAt is older than QUIET_STALE_THRESHOLD_MS regardless of
//    lifecycle events (catches silent disconnects, abandoned polls, etc.).
const LIFECYCLE_STALE_THRESHOLD_MS = readEnvMs("CLAWCONNECT_LIFECYCLE_STALE_MS", 10 * 60_000); // 10 min
const QUIET_STALE_THRESHOLD_MS = readEnvMs("CLAWCONNECT_QUIET_STALE_MS", 30 * 60_000); // 30 min
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
    const body = input.context ? `${input.context}\n\n${input.task}` : input.task;
    // Prepend the sender identity so the receiving agent knows who it's
    // helping on a shared connection.
    const senderName = input.senderName?.trim();
    const message = senderName ? `[Message from: ${senderName}]\n\n${body}` : body;

    const { sessionKey, migratedFromLegacy } = resolveSessionKey(input.sessionKey, this.agentId);

    // Concurrency guard: a second chat.send to an OpenClaw session that
    // already has a run in progress aborts the in-flight run, and the new
    // run resolves with an empty `chat.final` — so BOTH jobs break (the
    // running one gets truncated, the new one returns completed_no_summary).
    // Refuse the colliding submit with an actionable error instead.
    const priorJobId = this.latestJobBySession.get(sessionKey);
    const priorJob = priorJobId ? this.jobs.get(priorJobId) : undefined;
    if (priorJob && priorJob.status === "running") {
      const busyJobId = randomUUID();
      const busyJob: Job = {
        jobId: busyJobId,
        sessionKey,
        status: "error",
        error:
          `A task is already running on this session (jobId ${priorJobId}). ` +
          `Poll check_task until it finishes before sending another message to this ` +
          `session, or omit sessionKey to start a fresh thread.`,
        errorInfo: {
          category: "unknown",
          message: "session busy",
          suggestedRecovery:
            "Wait for the in-flight job on this session to reach a terminal status, then retry — or start a new thread by omitting sessionKey.",
        },
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        logs: [],
        artifacts: emptyArtifacts(),
      };
      this.jobs.set(busyJobId, busyJob);
      logDebug(`[job ${busyJobId.slice(0, 8)}] rejected: session ${sessionKey} busy with job ${priorJobId?.slice(0, 8)}`);
      return busyJob;
    }

    const jobId = randomUUID();
    const artifacts = emptyArtifacts();
    const now = Date.now();
    const logs: Array<{ ts: number; type: string; text: string }> = [];

    if (!input.sessionKey) {
      logs.push({ ts: now, type: "lifecycle", text: `Started new thread session: ${sessionKey}` });
    } else if (migratedFromLegacy) {
      logs.push({
        ts: now,
        type: "lifecycle",
        text: `Migrated legacy ChatGPT session to new thread: ${sessionKey}`,
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
          if (noSummary) {
            // Don't mark the job terminal yet — on long / compaction-heavy
            // runs the agent's real final answer can land minutes after the
            // first lifecycle:end fires (per-attempt boundary, not run
            // boundary). Keep the job in `running` so the caller's poll loop
            // stays engaged, and watch the transcript for a late-arriving
            // assistant message. The full SFR-247 architectural fix lives in
            // openclaw; this is the client-side mitigation.
            this.recoverLateFinalText(job, sessionKey, jobId, artifacts);
            return;
          }
          job.status = "completed";
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

  /**
   * SFR-247 client-side mitigation. When the live chat:final event arrives
   * empty (the gateway's terminal event fired on a per-attempt boundary
   * before the runner's real final answer was written), poll the persisted
   * transcript on a long window — up to ~5 minutes at a slow cadence — and
   * upgrade the job's status to `completed` if a final assistant message
   * eventually lands. If the poll exhausts, fall through to the original
   * `completed_no_summary` terminal state. The job stays in `running`
   * throughout, so callers polling `check_task` stay engaged.
   */
  private recoverLateFinalText(
    job: Job,
    sessionKey: string,
    jobId: string,
    artifacts: Job["artifacts"],
  ): void {
    const intervalMs = 10_000;
    // The poll auto-extends while the transcript is being actively written —
    // there's no fixed window. The two natural exits are stability (the run
    // produced its final answer) and `idleTimeoutMs` (the run went quiet
    // without writing visible text). `hardCapMs` is a safety net for runs
    // that produce activity forever without ever stabilizing.
    const idleTimeoutMs = 5 * 60_000;
    const hardCapMs = RECOVERY_TIMEOUT_MS;
    logDebug(
      `[job ${jobId}] no live final text — starting transcript long-poll ` +
        `(idle-timeout=${idleTimeoutMs / 1000}s, hard-cap=${hardCapMs / 1000}s)`,
    );
    void this.gateway
      .pollTranscriptForFinalText(sessionKey, {
        intervalMs,
        idleTimeoutMs,
        hardCapMs,
        // Require 3 consecutive same-snapshot polls — 30s of no transcript
        // growth — before accepting the trailing-assistant text as final.
        // Without this the poll grabs whatever short status line happens to
        // be in the trailing slot at first observation, even when the run
        // keeps writing for minutes and never comes back to assistant-text.
        stableThreshold: 3,
        shouldAbort: () => job.status !== "running",
      })
      .then(
        (recovered) => {
          if (job.status !== "running") return;
          job.lastEventAt = Date.now();
          if (recovered && recovered.length > 0) {
            job.status = "completed";
            job.summary = recovered;
            extractPatternsFromSummary(artifacts, recovered);
            this.sessions.set(sessionKey, {
              sessionKey,
              lastJobId: jobId,
              lastSummary: recovered.slice(0, 500),
              artifacts,
              recommendedNextStep: deriveNextStep(artifacts, job.status),
            });
            logDebug(`[job ${jobId}] late-recovery succeeded via transcript (${recovered.length} chars)`);
            return;
          }
          job.status = "completed_no_summary";
          job.summary = "Stream finished with no response collected.";
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: job.summary.slice(0, 500),
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, job.status),
          });
          logDebug(
            `[job ${jobId}] late-recovery exhausted (idle-timeout=${idleTimeoutMs / 1000}s, hard-cap=${hardCapMs / 1000}s) — completed_no_summary`,
          );
        },
        (err) => {
          // Belt-and-suspenders: the recovery path is fire-and-forget, so an
          // uncaught error here would otherwise propagate as an unhandledRejection,
          // crash the connector, and force launchd to kickstart — losing the
          // entire in-memory jobs map. Mark the job terminal cleanly instead.
          if (job.status !== "running") return;
          job.lastEventAt = Date.now();
          job.status = "completed_no_summary";
          job.summary = "Stream finished with no response collected.";
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: job.summary.slice(0, 500),
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, job.status),
          });
          logDebug(
            `[job ${jobId}] late-recovery threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
  }

  /**
   * Lazy transcript re-check for a terminal job. Called from waitForJob when
   * a job is already in a non-running, non-success terminal state
   * (completed_no_summary / error). Reads chat.history for the sessionKey
   * with a brief stability window — if a substantial trailing-assistant text
   * now exists that wasn't there when we originally marked the job terminal,
   * upgrade the job to completed.
   *
   * Rate-limited so a poll storm doesn't hammer chat.history: at most one
   * re-check per RECHECK_COOLDOWN_MS per job. Subsequent waitForJob calls
   * within the cooldown just return the cached terminal state.
   *
   * Uses pollTranscriptForFinalText with small parameters so a single
   * check_task call isn't blocked for long; the natural polling cadence
   * gives multiple chances over time.
   */
  private async maybeRecoverTerminalJob(job: Job): Promise<void> {
    const RECHECK_COOLDOWN_MS = 20_000;
    const last = job.lastRecheckAt ?? 0;
    if (Date.now() - last < RECHECK_COOLDOWN_MS) return;
    job.lastRecheckAt = Date.now();
    let recovered: string | undefined;
    try {
      recovered = await this.gateway.pollTranscriptForFinalText(job.sessionKey, {
        attempts: 4,
        intervalMs: 3_000,
        stableThreshold: 2,
      });
    } catch (err) {
      // Lazy recheck is best-effort. Don't let a transient gateway error or
      // bug here propagate up into the MCP server's checkTask handler — that
      // would crash the connector and lose the entire in-memory jobs map.
      logDebug(
        `[job ${job.jobId}] lazy-recheck threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!recovered) return;
    job.lastEventAt = Date.now();
    job.status = "completed";
    job.summary = recovered;
    job.error = undefined;
    job.errorInfo = undefined;
    job.staleReason = undefined;
    extractPatternsFromSummary(job.artifacts, recovered);
    this.sessions.set(job.sessionKey, {
      sessionKey: job.sessionKey,
      lastJobId: job.jobId,
      lastSummary: recovered.slice(0, 500),
      artifacts: job.artifacts,
      recommendedNextStep: deriveNextStep(job.artifacts, "completed"),
    });
    logDebug(
      `[job ${job.jobId}] late-recovery (lazy recheck): upgraded to completed with ${recovered.length} chars`,
    );
  }

  /**
   * Promote a stale running job to completed_no_summary.
   *
   * Two triggers:
   * 1. "Agent finished" lifecycle event present + lastEventAt older than
   *    LIFECYCLE_STALE_THRESHOLD_MS (10 min default).
   * 2. lastEventAt older than QUIET_STALE_THRESHOLD_MS (30 min default)
   *    regardless of lifecycle events (catches silent disconnects).
   *
   * Also handles the `stale` JobStatus: if the job was previously reconciled
   * to `stale` (see reconcile below), the recovery poll's shouldAbort
   * callback already stopped it.
   */
  private reconcileStaleJob(job: Job): void {
    if (job.status !== "running") return;

    const now = Date.now();
    const quietMs = now - job.lastEventAt;

    // Check for "Agent finished" lifecycle event in logs.
    const hasAgentFinished = job.logs.some(
      (l) => l.type === "lifecycle" && l.text === "Agent finished",
    );

    let reason: string | undefined;
    if (hasAgentFinished && quietMs >= LIFECYCLE_STALE_THRESHOLD_MS) {
      reason = `Agent lifecycle showed "Agent finished" ${Math.round(quietMs / 60_000)} minutes ago with no subsequent activity.`;
    } else if (quietMs >= QUIET_STALE_THRESHOLD_MS) {
      reason = `No activity for ${Math.round(quietMs / 60_000)} minutes. The session may have disconnected or the recovery poll stalled.`;
    }

    if (!reason) return;

    const prevStatus = job.status;
    job.status = "stale";
    job.staleReason = reason;
    job.lastEventAt = now;
    // Set a minimal summary so callers that only check `summary` get
    // something useful instead of undefined.
    if (!job.summary) {
      job.summary = `Task ended without a final response. ${reason}`;
    }
    this.sessions.set(job.sessionKey, {
      sessionKey: job.sessionKey,
      lastJobId: job.jobId,
      lastSummary: job.summary.slice(0, 500),
      artifacts: job.artifacts,
      recommendedNextStep: deriveNextStep(job.artifacts, "completed_no_summary"),
    });
    logDebug(
      `[job ${job.jobId}] reconciled: ${prevStatus} → stale (${reason})`,
    );
  }

  /**
   * Reconcile all tracked jobs. Called before listTasks so the task list
   * reflects current reality rather than stale in-memory state.
   */
  reconcileAllStale(): void {
    for (const job of this.jobs.values()) {
      this.reconcileStaleJob(job);
    }
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
      staleReason: job.staleReason,
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
      // SFR-247 lazy recovery: the openclaw session is durable on the same
      // sessionKey even after restart, and the agent may eventually write a
      // final assistant text minutes/hours after we marked the job
      // completed_no_summary or error. Re-read the transcript on each poll
      // (rate-limited) so a later check_task can surface a late-arriving
      // response without requiring the caller to re-submit the task.
      if (job.status === "completed_no_summary" || job.status === "error" || job.status === "stale") {
        await this.maybeRecoverTerminalJob(job);
      }
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
