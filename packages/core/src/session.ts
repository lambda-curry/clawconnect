import { randomUUID } from "node:crypto";
import {
  emptyArtifacts,
  processEvent,
  extractPatternsFromSummary,
  deriveNextStep,
} from "./artifacts.ts";
import { classifyError } from "./errors.ts";
import { OpenClawGateway, type RunObservation } from "./gateway.ts";
import type { JobStore, PersistedJob } from "./job-store.ts";
import { projectLogWindow } from "./log-projection.ts";
import type { CheckMode, ContinuationState, Job, JobSnapshot, JobStatus, LogEntry, NextAction, TaskInput } from "./types.ts";

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
// check_task's bounded-wait window (contract: docs/decisions/2026-07-27-task-
// contract.md decision 4 — "default wait target is 45 seconds and callers may
// override it"). Invalid/out-of-range waitMs values clamp rather than error.
const DEFAULT_WAIT_MS = readEnvMs("CLAWCONNECT_CHECK_WAIT_MS", 45_000);
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = readEnvMs("CLAWCONNECT_CHECK_MAX_WAIT_MS", 120_000);
// "poll" mode's early-return wait: a lifecycle/recovery event always wakes
// the wait immediately (it's a real state transition, never just cosmetic
// tool chatter). A run of tool/tool-result-only activity instead has to
// stay fresh for this long before it's worth ending the wait early — short
// bursts of tool calls (an agent looping through several tool uses in a
// couple hundred ms) collapse into one wake instead of one per event.
const COSMETIC_POLL_DEBOUNCE_MS = readEnvMs("CLAWCONNECT_COSMETIC_POLL_DEBOUNCE_MS", 400);
// How long the live event stream has to be silent before we stop trusting it
// and go ask upstream what actually happened. Production evidence: a
// tool-heavy run streams tool/tool-result events normally and then simply
// stops — the terminal `chat` event never arrives (dropped in a reconnect
// window, or lost to a cleared gateway buffer) — so chat() stays pending and
// the job sits in `running` until TIMEOUT_MS turns it into a bogus error.
// Sized to clear a long model_call between tool rounds, which produces no
// live events but is not a finished run.
export const RECONCILE_QUIET_MS = readEnvMs("CLAWCONNECT_RECONCILE_QUIET_MS", 120_000);
// Gap between the two transcript reads a single reconciliation round takes.
// Long enough that a run still writing will visibly move between them.
const RECONCILE_SAMPLE_INTERVAL_MS = readEnvMs("CLAWCONNECT_RECONCILE_SAMPLE_INTERVAL_MS", 15_000);
// Reconciliation rounds without upstream progress before the job is forced
// terminal. Bounded on purpose: "we can't tell" must still end the job, not
// leave it running forever. A round that sees upstream advance resets this.
export const RECONCILE_MAX_ROUNDS = 2;

/**
 * Job.logs is authoritative full history — server-retained, never trimmed or
 * capped (docs/decisions/2026-07-27-task-contract.md: "the server remains
 * authoritative" / "the server retains full history"; the widget/check_task
 * simplification only bounds what a given response projects from it — see
 * log-projection.ts). seq is 1-based and equal to the post-push array
 * length; monotonic for the life of the job regardless of how long it runs.
 */
function pushLog(job: Pick<Job, "logs">, entry: { ts: number; type: string; text: string; isError?: boolean }): void {
  job.logs.push({ ...entry, seq: job.logs.length + 1 });
}

function resolveWaitMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(requested, MIN_WAIT_MS), MAX_WAIT_MS);
}

function buildNextAction(job: { jobId: string; sessionKey: string; status: JobStatus }): NextAction {
  // args keys are check_task's own parameter names (jobId, not the taskId
  // alias) so the object is directly callable — see NextAction in types.ts.
  return job.status === "running" ? { tool: "check_task", args: { jobId: job.jobId, sessionKey: job.sessionKey } } : null;
}

const LEGACY_CHATGPT_SESSION_PREFIX = "agent:chatgpt:";

/**
 * Prepended to every run_task user message. Tells the receiving agent that
 * the run_task channel is the ONLY surface the caller sees, so the actual
 * reply body must go into the model's final assistant text — not into a
 * `message` tool call whose payload routes to a delivery channel (WhatsApp,
 * internal-ui, etc.) the caller has no access to.
 *
 * Two-layer mitigation:
 *   1. This preamble vetoes the `message` tool in compliant runs.
 *   2. `extractMessageToolReply` in gateway.ts captures the tool args body
 *      anyway and prefers it over the model's final text, so even
 *      non-compliant runs still surface the right content.
 *
 * Word-for-word adapted from services/linear-agent/src/linear-stream.ts
 * (`buildSystemPrompt`), which solved this same pattern for Linear-delegated
 * agents in carry-patches v2026.5.20.
 */
export const MESSAGE_TOOL_VETO_PREAMBLE =
  "You are operating in a ClawConnect run_task session. The caller (another AI " +
  "agent or coding tool) sees ONLY the text of your final assistant message — " +
  "there is no parallel WhatsApp, WebChat, Drive, or other delivery channel " +
  "they can read.\n\n" +
  "**Do NOT call the `message` tool in this session.** The `message` tool is " +
  "OpenClaw's generic cross-channel delivery primitive — its payload routes " +
  "through your default delivery channel, which the run_task caller cannot " +
  "see. Always reply by writing plain assistant text instead. If the answer " +
  "is long, put the long content directly into your final assistant message.";

function logDebug(message: string): void {
  console.error(message);
}

/**
 * Build the message string sent into `gateway.chat()`. Extracted so the
 * preamble + senderName + context composition is testable without standing
 * up a live gateway.
 */
export function buildSubmitMessage(input: TaskInput): string {
  const body = input.context ? `${input.context}\n\n${input.task}` : input.task;
  const senderName = input.senderName?.trim();
  const withSender = senderName ? `[Message from: ${senderName}]\n\n${body}` : body;
  return `${MESSAGE_TOOL_VETO_PREAMBLE}\n\n---\n\n${withSender}`;
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
  /** Every real (non-busy-rejected) jobId ever submitted under a sessionKey, oldest first. Backs get_session(mode:"tasks"). */
  private jobHistoryBySession = new Map<string, string[]>();
  /**
   * Live quiet-watchdogs, keyed by jobId. Present only while a job is
   * `running` with a live chat() still outstanding; cleared the moment the
   * job goes terminal or chat() settles (after which recoverLateFinalText
   * owns the job).
   *
   * The state object's identity doubles as an ownership token: an in-flight
   * reconciliation captures it before awaiting and re-checks it afterwards,
   * so a round that started before the job changed hands can't act on a
   * world that moved on. Clearing deletes the entry, so any later
   * re-arm allocates a fresh object and fails that identity check.
   */
  private reconcilers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      /** Consecutive quiet rounds that saw no upstream progress — see RECONCILE_MAX_ROUNDS. Reset by live activity. */
      rounds: number;
      /** Trailing assistant text from the previous quiet round; a repeat of it is what promotes a run to `completed`. */
      candidateText: string;
      /** Transcript snapshot key from the previous quiet round, for detecting progress BETWEEN rounds. */
      snapshotKey: string;
    }
  >();

  constructor(
    private readonly gateway: OpenClawGateway,
    private readonly agentId: string = "main",
    private readonly store?: JobStore,
  ) {
    if (store) this.rehydrateFromStore(store);
  }

  /**
   * Reattach to jobs a prior process instance was still tracking when it
   * exited/restarted. The live chat() streaming connection is gone — that
   * can't be recovered — but the underlying OpenClaw session is durable on
   * the same sessionKey, so each reloaded job goes straight into the same
   * transcript-recovery path an empty live chat.final already uses (see
   * recoverLateFinalText). Logs/artifacts are not persisted and start empty;
   * only the outcome (does it finish, what did it say) is re-derived.
   */
  private rehydrateFromStore(store: JobStore): void {
    for (const pj of store.load()) {
      if (this.jobs.has(pj.jobId)) continue;
      const artifacts = emptyArtifacts();
      const job: Job = {
        jobId: pj.jobId,
        sessionKey: pj.sessionKey,
        status: "running",
        startedAt: pj.startedAt,
        lastEventAt: pj.lastEventAt,
        logs: [],
        artifacts,
        pollCount: pj.pollCount,
        prompt: pj.prompt,
      };
      this.jobs.set(pj.jobId, job);
      this.latestJobBySession.set(pj.sessionKey, pj.jobId);
      const history = this.jobHistoryBySession.get(pj.sessionKey) ?? [];
      history.push(pj.jobId);
      this.jobHistoryBySession.set(pj.sessionKey, history);
      logDebug(`[job ${pj.jobId.slice(0, 8)}] reloaded from job store, reattaching via transcript recovery`);
      this.recoverLateFinalText(job, pj.sessionKey, pj.jobId, artifacts);
    }
  }

  /**
   * Overwrites the persisted file with exactly the jobs currently
   * status==="running" — a job drops out the moment it goes terminal, no
   * separate prune step. Cheap: the active set is always small, and this is
   * only called at submission and at each running->terminal transition, not
   * on every poll. No-op when no store is configured.
   */
  private persistActiveJobs(): void {
    if (!this.store) return;
    const active: PersistedJob[] = [...this.jobs.values()]
      .filter((j) => j.status === "running")
      .map((j) => ({
        jobId: j.jobId,
        sessionKey: j.sessionKey,
        startedAt: j.startedAt,
        lastEventAt: j.lastEventAt,
        pollCount: j.pollCount,
        prompt: j.prompt,
      }));
    this.store.save(active);
  }

  submitTask(input: TaskInput): Job {
    // buildSubmitMessage prepends the `message`-tool veto preamble, the
    // sender identity, and optional context block in the canonical order
    // tested in session.test.ts.
    const message = buildSubmitMessage(input);

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
        pollCount: 0,
        prompt: { task: input.task, context: input.context, senderName: input.senderName },
      };
      this.jobs.set(busyJobId, busyJob);
      logDebug(
        `[job ${busyJobId.slice(0, 8)}] rejected: session ${sessionKey} busy with job ${priorJobId?.slice(0, 8)}`,
      );
      return busyJob;
    }

    const jobId = randomUUID();
    const artifacts = emptyArtifacts();
    const now = Date.now();
    const hasInitialLog = !input.sessionKey || migratedFromLegacy;

    const job: Job = {
      jobId,
      sessionKey,
      status: "running",
      startedAt: now,
      lastEventAt: hasInitialLog ? now : 0,
      logs: [],
      artifacts,
      pollCount: 0,
      prompt: { task: input.task, context: input.context, senderName: input.senderName },
    };
    if (!input.sessionKey) {
      pushLog(job, { ts: now, type: "lifecycle", text: `Started new thread session: ${sessionKey}` });
    } else if (migratedFromLegacy) {
      pushLog(job, { ts: now, type: "lifecycle", text: `Migrated legacy ChatGPT session to new thread: ${sessionKey}` });
    }
    this.jobs.set(jobId, job);
    this.latestJobBySession.set(sessionKey, jobId);
    const history = this.jobHistoryBySession.get(sessionKey) ?? [];
    history.push(jobId);
    this.jobHistoryBySession.set(sessionKey, history);
    this.sessions.set(sessionKey, {
      sessionKey,
      lastJobId: jobId,
      lastSummary: "",
      artifacts,
    });
    this.persistActiveJobs();

    this.gateway
      .chat(sessionKey, message, TIMEOUT_MS, (event) => {
        job.lastEventAt = Date.now();
        this.noteLiveActivity(jobId);
        pushLog(job, {
          ts: Date.now(),
          type: event.type,
          text: event.text,
          ...(event.type === "tool-result" && event.isError ? { isError: true } : {}),
        });
        logDebug(
          `[job ${jobId.slice(0, 8)}] event #${job.logs.length}: ${event.type} - ${event.text.slice(0, 80)}`,
        );
        processEvent(artifacts, event);
      })
      .then(
        (reply) => {
          // chat() settled: the live stream answered for itself, so the quiet
          // watchdog has nothing left to reconcile.
          this.clearReconciler(jobId);
          const noSummary = !reply || reply === "Stream finished with no response collected.";
          if (job.status !== "running") {
            // Reconciliation already finalized this job while chat() was
            // still pending. A late live reply is only worth acting on when
            // it carries text the job doesn't have — then it's an upgrade,
            // never a downgrade of an already-summarized job.
            if (!noSummary && job.status === "completed_no_summary") {
              job.lastEventAt = Date.now();
              job.status = "completed";
              job.summary = reply;
              extractPatternsFromSummary(artifacts, reply);
              // Reconciliation freed this session, so a newer job may already
              // own it — this reply is minutes stale by construction. Upgrade
              // the job record either way, but only touch the session's
              // continuation state while this job is still the session's
              // latest, or a late arrival would overwrite live work.
              if (this.latestJobBySession.get(sessionKey) === jobId) {
                this.sessions.set(sessionKey, {
                  sessionKey,
                  lastJobId: jobId,
                  lastSummary: reply.slice(0, 500),
                  artifacts,
                  recommendedNextStep: deriveNextStep(artifacts, job.status),
                });
              }
              this.persistActiveJobs();
              logDebug(`[job ${jobId}] late live final upgraded reconciled job to completed`);
            }
            return;
          }
          job.lastEventAt = Date.now();
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
          this.persistActiveJobs();
          logDebug(
            `[job ${jobId}] ${job.status}, ${reply.length} chars, ${artifacts.filesChanged.length} files`,
          );
        },
        (err) => {
          this.clearReconciler(jobId);
          // A job reconciliation already finished keeps its outcome: chat()
          // rejecting afterwards is the abandoned live stream timing out, not
          // new information about the run.
          if (job.status !== "running") return;
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
          this.persistActiveJobs();
          logDebug(`[job ${jobId}] error (${job.errorInfo.category}): ${job.error}`);
        },
      );

    this.scheduleReconcile(job, RECONCILE_QUIET_MS);

    return job;
  }

  /**
   * (Re)arm the quiet-watchdog for a running job. Deliberately not re-armed
   * per event: the timer re-checks `lastEventAt` when it fires and reschedules
   * itself for the remaining quiet time, so a busy run costs one timer, not
   * one per tool call.
   */
  private scheduleReconcile(job: Job, delayMs: number): void {
    if (job.status !== "running") return;
    const timer = setTimeout(() => void this.reconcileQuietRun(job), delayMs);
    // Never a reason to hold the process open — a pending reconciliation is
    // always recoverable from the transcript on the next check_task.
    timer.unref?.();
    const state = this.reconcilers.get(job.jobId);
    if (state) {
      // Re-arm in place: the object identity is the ownership token an
      // in-flight round checks against, and a re-arm is the same ownership.
      clearTimeout(state.timer);
      state.timer = timer;
      return;
    }
    this.reconcilers.set(job.jobId, { timer, rounds: 0, candidateText: "", snapshotKey: "" });
  }

  /**
   * A live event proves the run is alive right now, which invalidates every
   * quiet round accumulated before it. Without this, two unrelated quiet gaps
   * minutes apart — with real activity in between — would add up to the round
   * cap and force a live run terminal.
   */
  private noteLiveActivity(jobId: string): void {
    const state = this.reconcilers.get(jobId);
    if (!state) return;
    state.rounds = 0;
    state.candidateText = "";
    state.snapshotKey = "";
  }

  private clearReconciler(jobId: string): void {
    const state = this.reconcilers.get(jobId);
    if (!state) return;
    clearTimeout(state.timer);
    this.reconcilers.delete(jobId);
  }

  /**
   * The live stream has been silent for RECONCILE_QUIET_MS. Ask upstream what
   * actually happened and turn the answer into a bounded outcome:
   *
   *   upstream still advancing  → stay `running` (and reset the round count)
   *   upstream settled, has text → `completed` with that text
   *   upstream settled, no text  → `completed_no_summary` (after MAX_ROUNDS)
   *   upstream unreadable        → `completed_no_summary` (after MAX_ROUNDS)
   *
   * The last two cases are why this exists: a run whose terminal event never
   * reached us must still end. `maybeRecoverTerminalJob` keeps re-reading the
   * transcript on later polls, so a text that lands afterwards still upgrades
   * the job to `completed` — the terminal call here is bounded, not final.
   */
  private async reconcileQuietRun(job: Job): Promise<void> {
    // Captured before anything can await: this object's identity is what
    // proves, later on, that we still own the job.
    const owner = this.reconcilers.get(job.jobId);
    if (!owner) return;
    if (job.status !== "running" || job.recovery) {
      this.clearReconciler(job.jobId);
      return;
    }
    // lastEventAt is 0 until the first event on a continued session, so fall
    // back to startedAt rather than treating the job as infinitely quiet.
    const quietSinceMs = Date.now() - Math.max(job.lastEventAt, job.startedAt);
    if (quietSinceMs < RECONCILE_QUIET_MS) {
      this.scheduleReconcile(job, RECONCILE_QUIET_MS - quietSinceMs);
      return;
    }

    const round = owner.rounds + 1;
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text:
        `No live activity for ${Math.round(quietSinceMs / 1000)}s — reconciling against the ` +
        `upstream transcript (round ${round}/${RECONCILE_MAX_ROUNDS})`,
    });
    logDebug(
      `[job ${job.jobId}] quiet for ${Math.round(quietSinceMs / 1000)}s — reconciling (round ${round})`,
    );

    let observation: RunObservation;
    try {
      observation = await this.gateway.reconcileRun(job.sessionKey, {
        samples: 2,
        intervalMs: RECONCILE_SAMPLE_INTERVAL_MS,
      });
    } catch (err) {
      logDebug(
        `[job ${job.jobId}] reconcile threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      observation = { ok: false, changed: false, trailingText: "", snapshotKey: "" };
    }

    // The job may have changed hands while we were sampling. Two distinct
    // cases, both fatal to this round: chat() settled and cleared the
    // watchdog (possibly handing the job to recoverLateFinalText, which
    // keeps status `running` while it long-polls), or the job went terminal
    // outright. Acting on either would re-arm a watchdog nobody owns or
    // stomp the new owner's outcome.
    if (this.reconcilers.get(job.jobId) !== owner) return;
    if (job.status !== "running" || job.recovery) {
      this.clearReconciler(job.jobId);
      return;
    }

    // Progress means "moved at any point since the last round", not just
    // "moved between this round's two samples": a run that advances one tool
    // round per minute looks perfectly stable inside a single 15s window.
    const advancedBetweenRounds =
      owner.snapshotKey !== "" &&
      observation.snapshotKey !== "" &&
      observation.snapshotKey !== owner.snapshotKey;
    if (observation.ok && (observation.changed || advancedBetweenRounds)) {
      pushLog(job, {
        ts: Date.now(),
        type: "recovery",
        text: "Upstream transcript is still advancing — the task is still running",
      });
      owner.rounds = 0;
      owner.candidateText = "";
      owner.snapshotKey = observation.snapshotKey;
      this.scheduleReconcile(job, RECONCILE_QUIET_MS);
      return;
    }

    // `completed` requires the SAME text from two successful rounds, with no
    // weaker fallback. chat.history exposes whatever the agent last wrote,
    // and an active run routinely flashes an interim status line ("I'm
    // tracing the live wiring now…") into the trailing-assistant slot and
    // then works for minutes without returning to it — see the stability
    // note in pollTranscriptForFinalText. Reaching the round cap is NOT
    // evidence: an unreadable round followed by one readable interim line is
    // two rounds of nothing confirmed. Unconfirmed text falls through to
    // completed_no_summary, which self-heals — maybeRecoverTerminalJob
    // re-reads the transcript on later polls and upgrades the job if the
    // text is really final.
    const textConfirmed =
      observation.ok &&
      observation.trailingText.length > 0 &&
      observation.trailingText === owner.candidateText;
    if (textConfirmed) {
      this.finalizeReconciled(job, "completed", observation.trailingText);
      return;
    }

    if (round >= RECONCILE_MAX_ROUNDS) {
      this.finalizeReconciled(
        job,
        "completed_no_summary",
        observation.ok
          ? "Stream finished with no response collected."
          : "Stream ended and the upstream transcript could not be read; completing without a summary.",
      );
      return;
    }

    owner.rounds = round;
    owner.candidateText = observation.ok ? observation.trailingText : "";
    if (observation.ok) owner.snapshotKey = observation.snapshotKey;
    this.scheduleReconcile(job, RECONCILE_QUIET_MS);
  }

  /** Apply a reconciled terminal outcome to a job that the live stream abandoned. */
  private finalizeReconciled(
    job: Job,
    status: "completed" | "completed_no_summary",
    summary: string,
  ): void {
    this.clearReconciler(job.jobId);
    job.lastEventAt = Date.now();
    job.status = status;
    job.summary = summary;
    if (status === "completed") extractPatternsFromSummary(job.artifacts, summary);
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text:
        status === "completed"
          ? "Recovered the final response from the upstream transcript after the live stream went quiet"
          : "Upstream shows the run is no longer active and left no visible response",
    });
    this.sessions.set(job.sessionKey, {
      sessionKey: job.sessionKey,
      lastJobId: job.jobId,
      lastSummary: summary.slice(0, 500),
      artifacts: job.artifacts,
      recommendedNextStep: deriveNextStep(job.artifacts, status),
    });
    this.persistActiveJobs();
    logDebug(`[job ${job.jobId}] reconciled to ${status} (${summary.length} chars)`);
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
    job.recovery = {
      reason: "no_live_final_text",
      startedAt: Date.now(),
      idleTimeoutMs,
      hardCapMs,
    };
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text: "Recovering late transcript final text after live stream ended without visible final text",
    });
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
            job.recovery = undefined;
            extractPatternsFromSummary(artifacts, recovered);
            this.sessions.set(sessionKey, {
              sessionKey,
              lastJobId: jobId,
              lastSummary: recovered.slice(0, 500),
              artifacts,
              recommendedNextStep: deriveNextStep(artifacts, job.status),
            });
            this.persistActiveJobs();
            logDebug(
              `[job ${jobId}] late-recovery succeeded via transcript (${recovered.length} chars)`,
            );
            return;
          }
          job.status = "completed_no_summary";
          job.summary = "Stream finished with no response collected.";
          job.recovery = undefined;
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: job.summary.slice(0, 500),
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, job.status),
          });
          this.persistActiveJobs();
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
          job.recovery = undefined;
          job.summary = "Stream finished with no response collected.";
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: job.summary.slice(0, 500),
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, job.status),
          });
          this.persistActiveJobs();
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
    // Only the session's current job may read the session's transcript.
    // Reconciliation ends jobs whose live stream was abandoned, which frees
    // the session for new work — so unlike before, a terminal job can now be
    // polled while a NEWER job is running on the same sessionKey. Without
    // this the old job would adopt the new run's answer as its own and
    // repoint the session's continuation state at itself.
    if (this.latestJobBySession.get(job.sessionKey) !== job.jobId) return;
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
    // The poll above takes seconds, so re-check ownership: a new job may have
    // claimed the session while it ran.
    if (this.latestJobBySession.get(job.sessionKey) !== job.jobId) return;
    job.lastEventAt = Date.now();
    job.status = "completed";
    job.summary = recovered;
    job.error = undefined;
    job.errorInfo = undefined;
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
   * `cursor` is the caller's last-seen `logCursor` (their `knownLogCount`).
   * `logs`/`logCursor`/`logEventCount` come from projectLogWindow — a bounded
   * projection of `job.logs`, never the raw accumulated array. Every other
   * field (summary/artifacts/error/…) is unaffected by the cursor: the
   * terminal/full-response content never depends on a prior delta.
   */
  buildSnapshot(job: Job, cursor?: number): JobSnapshot {
    const continuation = this.sessions.get(job.sessionKey);
    const continuePolling = job.status === "running";
    const window = projectLogWindow(job.logs, cursor);
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
      logs: window.events,
      logCursor: window.cursor,
      logEventCount: window.totalCount,
      artifacts: job.artifacts,
      recovery: job.recovery,
      pollCount: job.pollCount,
      continuePolling,
      // A wait-mode check_task call already blocked for its full window
      // before returning, so it's normally safe to call again immediately —
      // except during late-recovery, where the transcript is only re-read
      // every ~10s server-side (see recoverLateFinalText below), so hammering
      // check_task faster than that just burns round-trips for no new info.
      retryAfterMs: continuePolling ? (job.recovery ? 10_000 : 0) : 0,
      nextAction: buildNextAction(job),
      ...(continuation ? { continuationState: continuation } : {}),
    };
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  getLatestJobForSession(sessionKey: string): Job | undefined {
    const latestJobId =
      this.latestJobBySession.get(sessionKey) ?? this.sessions.get(sessionKey)?.lastJobId;
    return latestJobId ? this.jobs.get(latestJobId) : undefined;
  }

  /** Every real job submitted under this session, newest first. Backs get_session(mode:"tasks"). */
  getJobHistory(sessionKey: string): Job[] {
    const ids = this.jobHistoryBySession.get(sessionKey) ?? [];
    return ids
      .slice()
      .reverse()
      .map((id) => this.jobs.get(id))
      .filter((job): job is Job => job !== undefined);
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
    waitMs?: number,
  ): Promise<Job | undefined> {
    const job = this.resolveJob(jobId, sessionKey);
    if (!job) {
      logDebug(
        `[waitForJob] no job found (jobId=${jobId?.slice(0, 8)}, session=${sessionKey?.slice(-8)})`,
      );
      return undefined;
    }
    job.pollCount += 1;
    if (job.status !== "running") {
      // SFR-247 lazy recovery: the openclaw session is durable on the same
      // sessionKey even after restart, and the agent may eventually write a
      // final assistant text minutes/hours after we marked the job
      // completed_no_summary or error. Re-read the transcript on each poll
      // (rate-limited) so a later check_task can surface a late-arriving
      // response without requiring the caller to re-submit the task.
      if (job.status === "completed_no_summary" || job.status === "error") {
        await this.maybeRecoverTerminalJob(job);
      }
      logDebug(
        `[waitForJob] job ${job.jobId.slice(0, 8)} already ${job.status}, logs=${job.logs.length}`,
      );
      return job;
    }
    const effectiveWaitMs = resolveWaitMs(waitMs);
    logDebug(
      `[waitForJob] job ${job.jobId.slice(0, 8)} waiting mode=${mode} waitMs=${effectiveWaitMs} (known=${knownLogCount}, current=${job.logs.length})`,
    );
    const deadline = Date.now() + effectiveWaitMs;
    // Batches cosmetic-only activity (tool/tool-result chatter) so a burst of
    // several such entries wakes a "poll" mode wait once, not once per entry;
    // a lifecycle/recovery entry — an actual state transition, not cosmetic —
    // always wakes immediately, undebounced. See COSMETIC_POLL_DEBOUNCE_MS.
    let cosmeticActivitySince: number | undefined;
    while (Date.now() < deadline && job.status === "running") {
      await new Promise((r) => setTimeout(r, 500));
      // In "poll" mode: return early on new logs (live progress for widgets)
      // In "wait" mode: only return on terminal state or timeout (fewer round-trips for agentic use)
      if (mode === "poll" && job.logs.length > knownLogCount) {
        const freshEntries = job.logs.slice(knownLogCount);
        const hasLifecycleTransition = freshEntries.some((e) => e.type === "lifecycle" || e.type === "recovery");
        if (hasLifecycleTransition) {
          logDebug(`[waitForJob] job ${job.jobId.slice(0, 8)} lifecycle activity — waking immediately`);
          return job;
        }
        if (cosmeticActivitySince === undefined) cosmeticActivitySince = Date.now();
        if (Date.now() - cosmeticActivitySince >= COSMETIC_POLL_DEBOUNCE_MS) {
          logDebug(
            `[waitForJob] job ${job.jobId.slice(0, 8)} has new logs (${job.logs.length} > ${knownLogCount}), cosmetic debounce elapsed`,
          );
          return job;
        }
      }
    }
    logDebug(
      `[waitForJob] job ${job.jobId.slice(0, 8)} ${mode} timeout (logs=${job.logs.length}, status=${job.status})`,
    );
    return job;
  }
}
