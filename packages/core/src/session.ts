import { randomUUID } from "node:crypto";
import {
  emptyArtifacts,
  processEvent,
  extractPatternsFromSummary,
  deriveNextStep,
} from "./artifacts.ts";
import { classifyError } from "./errors.ts";
import {
  delegateBlockedTerminalReason,
  describeBlockedAgentSession,
  dispatchAgentSession,
  isBlockedAgentSessionState,
  isCompletedTurnState,
  isDelegateBlockedTerminalReason,
  normalizeAgentSessionObservation,
  withAgentSessionTimeout,
  type AgentSessionRef,
  type AgentSessionState,
  type AgentSessionRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeRegistry,
  type AgentSessionStatus,
} from "./agent-session.ts";
import {
  CLAUDE_FLEET_RUNTIME_ID,
  fleetAdapterRuntime,
  type FleetAdapter,
} from "./fleet-adapter.ts";
import type { AttachmentStore } from "./attachment-store.ts";
import { parseSessionHandoff } from "./session-handoff.ts";
import { OpenClawGateway, type RunObservation } from "./gateway.ts";
import type { JobStore, PersistedJob } from "./job-store.ts";
import { projectLogWindow } from "./log-projection.ts";
import {
  NO_SUMMARY_SENTINEL,
  isParentObservationTimeout,
  type CheckMode,
  type ContinuationState,
  type AgentSessionAttachment,
  type AgentSessionDirective,
  type ErrorInfo,
  type GatewayEvent,
  type Job,
  type JobRecoveryState,
  type JobSnapshot,
  type JobStatus,
  type LogEntry,
  type NextAction,
  type ResultSource,
  type SessionAttachmentState,
  type TaskInput,
} from "./types.ts";

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
// Cap on AgentSessionAttachment.lastResult.summary — the durable pointer
// (outputRef) is what makes the full text re-derivable, so this only needs
// to be a useful preview, not the whole answer. Job.summary itself is never
// capped (matches the existing, unbounded convention for every other
// terminal path in this file).
export const ATTACHMENT_RESULT_SUMMARY_MAX = 2_000;

function capResultText(text: string): string {
  return text.length > ATTACHMENT_RESULT_SUMMARY_MAX
    ? `${text.slice(0, ATTACHMENT_RESULT_SUMMARY_MAX - 1)}…`
    : text;
}

/**
 * The durable pointer stored alongside a capped result, so the full text stays
 * re-derivable from the runtime rather than duplicated unbounded here.
 */
function attachmentOutputRef(record: AgentSessionAttachment): string {
  return record.worktree ? `${record.handle}:${record.worktree}` : record.handle;
}

/**
 * Job.logs is authoritative full history — server-retained, never trimmed or
 * capped (docs/decisions/2026-07-27-task-contract.md: "the server remains
 * authoritative" / "the server retains full history"; the widget/check_task
 * simplification only bounds what a given response projects from it — see
 * log-projection.ts). seq is 1-based and equal to the post-push array
 * length; monotonic for the life of the job regardless of how long it runs.
 */
function pushLog(
  job: Pick<Job, "logs">,
  entry: { ts: number; type: string; text: string; isError?: boolean },
): void {
  job.logs.push({ ...entry, seq: job.logs.length + 1 });
}

function resolveWaitMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(requested, MIN_WAIT_MS), MAX_WAIT_MS);
}

function waitForPollInterval(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * How old a piece of evidence is, in words, for a message that must not imply
 * it was gathered just now. "just now" is reserved for the case where it
 * genuinely was — anything else states the gap.
 */
function describeAge(ageMs: number): string {
  if (ageMs < 15_000) return "just now";
  if (ageMs < 90_000) return `${Math.round(ageMs / 1000)}s ago`;
  return `${Math.round(ageMs / 60_000)}m ago`;
}

/**
 * The advice for a turn the parent stopped watching while its run was, as far
 * as anyone could tell, still executing.
 *
 * Both strings come from here because they are two renderings of ONE decision
 * and they are read together: `errorInfo.suggestedRecovery` on the job, and
 * `recommendedNextStep` on the session's continuation state. The generic
 * derivation for an `error` job says "Fix the issue and retry." — which on
 * this outcome means "send again on a session whose run is still going", i.e.
 * abort the very run whose answer the caller is waiting for. A caller reading
 * one surface must not be told the opposite of the other.
 */
function upstreamStillActiveGuidance(
  jobId: string,
  parentRunId: string | undefined,
): { suggestedRecovery: string; nextStep: string } {
  const inspect = parentRunId ? `run ${parentRunId}` : "the run";
  return {
    suggestedRecovery:
      `Do not re-submit on this session while the run is executing — a second send aborts it. ` +
      `Call check_task again with jobId ${jobId} to pick up the response if it lands, or inspect ` +
      `${inspect} upstream to see what it is doing.`,
    nextStep: `Keep polling check_task (jobId ${jobId}) — do not re-submit on this session while ${inspect} is executing.`,
  };
}

function buildNextAction(job: {
  jobId: string;
  sessionKey: string;
  status: JobStatus;
}): NextAction {
  // args keys are check_task's own parameter names (jobId, not the taskId
  // alias) so the object is directly callable — see NextAction in types.ts.
  return job.status === "running"
    ? { tool: "check_task", args: { jobId: job.jobId, sessionKey: job.sessionKey } }
    : null;
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

/**
 * Normalizes one loaded SessionAttachmentState so every downstream reader
 * (getAgentSessionAttachment, buildSnapshot, attachOrReplace, …) can trust the
 * invariant "`attachments` is always a plain object, and `currentAttachmentId`
 * — if set — always has a matching entry" without re-checking it at every
 * call site. A hand-edited, legacy, truncated, or otherwise corrupted store
 * file can violate either half of that invariant; this treats an
 * unrecoverable `currentAttachmentId` as "no current attachment" (never
 * throws) while PRESERVING every entry in `attachments` that is at least a
 * plain object with a string `id` — a malformed `currentAttachmentId` does
 * not discard the rest of the session's valid lineage.
 */
function sanitizeAttachmentState(raw: SessionAttachmentState): SessionAttachmentState {
  const rawAttachments = raw && typeof raw === "object" ? raw.attachments : undefined;
  const attachments: Record<string, AgentSessionAttachment> = {};
  if (rawAttachments && typeof rawAttachments === "object") {
    for (const [id, record] of Object.entries(rawAttachments)) {
      if (
        record &&
        typeof record === "object" &&
        typeof (record as AgentSessionAttachment).id === "string"
      ) {
        attachments[id] = record as AgentSessionAttachment;
      }
    }
  }
  const currentAttachmentId =
    raw?.currentAttachmentId && attachments[raw.currentAttachmentId]
      ? raw.currentAttachmentId
      : undefined;
  return { sessionKey: raw.sessionKey, currentAttachmentId, attachments };
}

export class SessionManager {
  private jobs = new Map<string, Job>();
  private latestJobBySession = new Map<string, string>();
  private sessions = new Map<string, ContinuationState>();
  /** Every real (non-busy-rejected) jobId ever submitted under a sessionKey, oldest first. Backs get_session(mode:"tasks"). */
  private jobHistoryBySession = new Map<string, string[]>();
  /**
   * Jobs whose terminal status was decided by reconciliation rather than by
   * a real terminal event. Such an outcome is a bounded inference, never
   * ground truth, so a live final that arrives afterwards overwrites it —
   * including a reconciled `completed`, whose summary may be text the run
   * had merely written on its way past.
   */
  private provisionalOutcomes = new Set<string>();
  /**
   * Jobs whose provisional outcome a transcript re-read has already
   * confirmed or corrected — they stop being re-read, but stay provisional.
   *
   * These are two different questions and were previously one flag. "May a
   * late live final replace this?" is only answered when chat() settles;
   * "should later polls keep re-reading the transcript?" is answered the
   * first time a read changes something. Letting a re-read answer both meant
   * an inference retired the guard protecting against inference, and the
   * run's actual terminal text was then discarded.
   */
  private recheckSettled = new Set<string>();
  /**
   * openclaw's runId per job, once chat.send has returned one. Kept outside
   * the reconciler state so it cannot be lost to callback/arming order —
   * onRunId can fire before or after the watchdog is armed.
   */
  private upstreamRunIds = new Map<string, string>();
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
      /** Consecutive quiet rounds that saw no upstream progress. Diagnostic only — no cap forces a terminal outcome. Reset by live activity. */
      rounds: number;
      /**
       * Bumped on every live event. A reconciliation round captures it before
       * awaiting and compares afterwards, so activity that lands mid-round is
       * detected. A timestamp cannot do this job: several tool events
       * routinely land in the same millisecond.
       */
      activityGeneration: number;
      /**
       * Tool calls started but not yet finished. A long tool call produces
       * live events only at its start and its result, and freezes the
       * transcript in between — so an outstanding count is the one piece of
       * positive evidence that silence does NOT mean the run is over.
       */
      outstandingTools: number;
      /** Trailing assistant text from the previous quiet round; a repeat of it is what promotes a run to `completed`. */
      candidateText: string;
      /** Transcript snapshot key from the previous quiet round, for detecting progress BETWEEN rounds. */
      snapshotKey: string;
    }
  >();
  /**
   * Session-scoped attachment state, keyed by sessionKey — deliberately
   * NOT part of ContinuationState (which is fully reconstructed, not merged,
   * at 8 call sites in this file) so attach/continue/replace/detach/inspect
   * transitions have zero blast radius on that existing, separately-tested
   * machinery. Mutated only by attachOrReplace/detachAttachment/
   * applyDirectiveObservation — never by job-completion code paths. See
   * docs/architecture/2026-08-02-managed-fleet-attachment-plan.md.
   */
  private attachments = new Map<string, SessionAttachmentState>();
  /**
   * Source of the monotonic write token stamped on every runtime observation.
   * A dispatch takes one BEFORE calling out; the write-back refuses anything
   * that isn't strictly newer than what the record already carries — see
   * AgentSessionAttachment.observationToken.
   */
  private observationSeq = 0;

  constructor(
    private readonly gateway: OpenClawGateway,
    private readonly agentId: string = "main",
    private readonly store?: JobStore,
    private readonly attachmentStore?: AttachmentStore,
    private readonly fleetAdapter?: FleetAdapter,
    private readonly runtimes?: AgentSessionRuntimeRegistry,
  ) {
    if (store) this.rehydrateFromStore(store);
    if (attachmentStore) this.rehydrateAttachmentsFromStore(attachmentStore);
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
        parentRunId: pj.parentRunId,
      };
      this.jobs.set(pj.jobId, job);
      this.latestJobBySession.set(pj.sessionKey, pj.jobId);
      const history = this.jobHistoryBySession.get(pj.sessionKey) ?? [];
      history.push(pj.jobId);
      this.jobHistoryBySession.set(pj.sessionKey, history);
      logDebug(
        `[job ${pj.jobId.slice(0, 8)}] reloaded from job store, reattaching via transcript recovery`,
      );
      this.recoverLateFinalText(job, pj.sessionKey, pj.jobId, artifacts);
    }
  }

  /**
   * Restart-recovery counterpart to rehydrateFromStore, for attachment
   * lineage. See attachment-store.ts.
   *
   * `observationSeq` RESUMES above the highest token any reloaded record
   * carries. The counter is in-memory and the tokens are durable, so a fresh
   * process starting back at zero would mint tokens the compare-and-set in
   * applyAgentSessionStatus is bound to refuse (`token <= observationToken`) —
   * every observation, and every runtime recovery that depends on one landing,
   * would silently do nothing until the counter caught up. Restoring the
   * high-water mark keeps the token strictly monotonic ACROSS restarts, which
   * is the property the CAS actually needs.
   */
  private rehydrateAttachmentsFromStore(store: AttachmentStore): void {
    let highWater = this.observationSeq;
    for (const state of store.load()) {
      if (typeof state?.sessionKey !== "string" || !state.sessionKey) continue;
      const sanitized = sanitizeAttachmentState(state);
      this.attachments.set(state.sessionKey, sanitized);
      // Every record, not just the current one: a superseded record can carry
      // the highest token, and re-issuing it would let a stale write land.
      for (const record of Object.values(sanitized.attachments)) {
        const token = record.observationToken;
        if (typeof token === "number" && Number.isFinite(token) && token > highWater)
          highWater = token;
      }
    }
    this.observationSeq = highWater;
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
        parentRunId: j.parentRunId,
      }));
    this.store.save(active);
  }

  /**
   * Whole-map overwrite, same shape as persistActiveJobs but for attachment
   * attachment state. Unlike persistActiveJobs this saves EVERY session that
   * has ever had an attachment (including detached/superseded lineage), not
   * just an active subset — see attachment-store.ts for why that's
   * still bounded. Called after every attach/replace/detach/observation
   * write, never on a hot path like buildSnapshot.
   */
  private persistAttachments(): void {
    if (!this.attachmentStore) return;
    this.attachmentStore.save([...this.attachments.values()]);
  }

  // ── Managed session attachment ──────────────────────────────────────────
  //
  // Every read below touches ONLY `attachments.get(sessionKey)` — one
  // session, O(1) — or hands the resulting single record to the injected
  // FleetAdapter. There is no code path anywhere in this block that iterates
  // sessions/handles/hosts, which is what "no heuristic scanning" (mission
  // requirement 4) means structurally, not just by convention.

  /**
   * True when a FleetAdapter was injected at construction — i.e. recovery
   * tier 3 is actually reachable, not just persisted metadata. Exists so
   * production entrypoint tests can assert the wiring is present without
   * needing to drive a full recovery scenario end to end.
   */
  hasFleetAdapter(): boolean {
    return this.fleetAdapter !== undefined;
  }

  /** True when a host registered callbacks for `runtimeId`. Wiring assertion only — it exposes no sessions. */
  hasAgentSessionRuntime(runtimeId: string): boolean {
    return this.runtimes?.has(runtimeId) === true;
  }

  /**
   * The neutral view of one attachment handed to a runtime callback —
   * deliberately not the record itself, so a host never sees ClawConnect's
   * lineage ids, delegated turn tokens, or stored results. Lineage statuses
   * ("superseded"/"detached") are not part of the neutral vocabulary and are
   * dropped rather than reported as a session state a runtime should reason
   * about.
   */
  private agentSessionRef(record: AgentSessionAttachment): AgentSessionRef {
    const lastKnownState =
      record.status === "superseded" || record.status === "detached" ? undefined : record.status;
    return {
      runtime: record.runtime,
      provider: record.provider,
      sessionId: record.handle,
      providerSessionId: record.providerSessionId,
      host: record.host,
      remoteUrl: record.remoteUrl,
      metadata: record.metadata,
      lastKnownState,
    };
  }

  /**
   * Which runtime answers for this record: a host-registered one if there is
   * one, otherwise the built-in claude-fleet adapter presented through the
   * same seam. A host that registers "claude-fleet" itself deliberately wins —
   * a host driving it through its own transport knows more than a local
   * tmux probe does.
   *
   * A map lookup on ONE id. There is no path from here to a runtime's session
   * list, because the callback seam defines no such callback.
   */
  private resolveRuntime(record: AgentSessionAttachment): AgentSessionRuntime | undefined {
    const registered = this.runtimes?.get(record.runtime);
    if (registered) return registered;
    if (record.runtime === CLAUDE_FLEET_RUNTIME_ID && this.fleetAdapter) {
      return fleetAdapterRuntime(this.fleetAdapter, record);
    }
    return undefined;
  }

  /**
   * Run ONE operation against this conversation's ONE current attachment and
   * fold the answer back into the record.
   *
   * Returns the runtime's answer even when the write-back is refused: the
   * caller asked a question and the answer is still the answer, but a stale
   * answer is never allowed to become durable state (see
   * applyAgentSessionStatus). Returns undefined only when there is nothing
   * attached — there is no branch here that looks at any other session.
   */
  async runAgentSessionOp(
    sessionKey: string,
    request: AgentSessionRequest,
  ): Promise<AgentSessionStatus | undefined> {
    const record = this.getAgentSessionAttachment(sessionKey);
    if (!record) return undefined;
    const token = ++this.observationSeq;
    const attachmentId = record.id;
    const delegatedTurnId = record.delegatedTurnId;
    const status = await dispatchAgentSession(
      this.resolveRuntime(record),
      this.agentSessionRef(record),
      request,
      {
        now: Date.now(),
      },
    );
    this.applyAgentSessionStatus(sessionKey, attachmentId, delegatedTurnId, token, status);
    return status;
  }

  /**
   * The one guarded write-back for everything a runtime reports. Three
   * independent checks, each closing a different way a slow answer can be
   * wrong by the time it lands:
   *
   *   - identity: the attachment must still be this conversation's CURRENT one
   *     (a detach or replace during the call invalidates the answer);
   *   - delegation: it must still be delegated to the same parent turn, so a
   *     read started for one turn cannot write state a later turn owns;
   *   - token: no NEWER observation may already have been written, so two
   *     reads of the same attachment on the same turn can't finish out of
   *     order and roll the record back.
   *
   * A read that failed teaches nothing about the SESSION, only about our
   * ability to ask — so it records `error` and touches nothing else. That is
   * what keeps a stored "needs_input" from being erased by a service outage.
   */
  private applyAgentSessionStatus(
    sessionKey: string,
    attachmentId: string,
    delegatedTurnId: string | undefined,
    token: number,
    status: AgentSessionStatus,
  ): boolean {
    const fresh = this.getCurrentAttachmentIfUnchanged(sessionKey, attachmentId);
    if (!fresh) return false;
    if (fresh.delegatedTurnId !== delegatedTurnId) return false;
    if (token <= (fresh.observationToken ?? 0)) return false;

    const now = Date.now();
    if (status.error) {
      this.writeAttachment(sessionKey, attachmentId, {
        observationToken: token,
        error: status.error,
        lastObservedAt: now,
      });
      return true;
    }

    // "unavailable"/"unknown" describe the read, not the session, and never
    // become a stored status. A liveness-only observation (the built-in
    // claude-fleet probe, which reports no state at all) may still promote the
    // uninformative initial "starting" — and only that, evaluated against the
    // FRESH record, so a status the host reported while the probe was in flight
    // is never clobbered by a bare liveness bit.
    const reported =
      status.state === "unavailable" || status.state === "unknown" ? undefined : status.state;
    const promoted =
      !reported && status.alive === true && fresh.status === "starting" ? "running" : undefined;
    const nextStatus = reported ?? promoted;
    const observedAt = status.lastEventAt ?? status.termination?.at ?? now;

    this.writeAttachment(sessionKey, attachmentId, {
      observationToken: token,
      lastObservedAt: now,
      error: undefined,
      ...(nextStatus ? { status: nextStatus } : {}),
      // Authoritative when a runtime answered (dispatchAgentSession binds the
      // registered runtime's own provider onto the ref), so a record whose
      // provider came from attachment text heals to what the runtime says.
      ...(status.provider ? { provider: status.provider } : {}),
      ...(status.providerSessionId ? { providerSessionId: status.providerSessionId } : {}),
      ...(status.host ? { host: status.host } : {}),
      ...(status.remoteUrl ? { remoteUrl: status.remoteUrl } : {}),
      ...(status.metadata ? { metadata: status.metadata } : {}),
      ...(status.alive !== undefined ? { alive: status.alive } : {}),
      ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
      ...(status.lastEventAt !== undefined ? { lastEventAt: status.lastEventAt } : {}),
      ...(status.latestResponse ? { latestResponse: capResultText(status.latestResponse) } : {}),
      ...(status.termination ? { termination: status.termination } : {}),
      // normalizeAgentSessionObservation only ever produces finalResponse in a
      // completed-turn state, so this cannot store a running session's partial
      // answer as the turn's result.
      ...(status.finalResponse
        ? {
            lastResult: {
              summary: capResultText(status.finalResponse),
              outputRef: attachmentOutputRef(fresh),
              observedAt,
            },
          }
        : {}),
    });
    return true;
  }

  /**
   * The session's current attachment, or undefined if it has never attached,
   * is currently detached, or the persisted record is malformed (a
   * `currentAttachmentId` with no matching entry in `attachments`, or a
   * missing/non-object `attachments` field — see sanitizeAttachmentState, applied
   * at rehydration; the optional chaining here is a second, independent
   * guard so this can never throw regardless of how a bad record got into
   * the map). Never throws — malformed reads as "no current attachment".
   */
  getAgentSessionAttachment(sessionKey: string): AgentSessionAttachment | undefined {
    const state = this.attachments.get(sessionKey);
    if (!state?.currentAttachmentId) return undefined;
    return state.attachments?.[state.currentAttachmentId];
  }

  /**
   * Every attachment lineage record this session has ever had, current and
   * superseded/detached alike. Never throws: a missing/non-object
   * `attachments` field reads as an empty lineage rather than propagating.
   */
  getAgentSessionLineage(sessionKey: string): AgentSessionAttachment[] {
    const attachments = this.attachments.get(sessionKey)?.attachments;
    return attachments ? Object.values(attachments) : [];
  }

  /**
   * attach and replace share this implementation: both create a fresh
   * record and make it current. The only real difference is lineage —
   * "replace" REQUIRES the caller to supply a reason (enforced by
   * session-handoff.ts's parser before this is ever called), while "attach"
   * only carries one when there happened to be something to supersede. An
   * "attach" that arrives while an attachment is already current is treated
   * as an implicit replace rather than a silent no-op or an overwrite — the
   * prior record is never orphaned without an updated status.
   */
  private attachOrReplace(
    sessionKey: string,
    jobId: string,
    directive: Extract<AgentSessionDirective, { op: "attach" | "replace" }>,
  ): AgentSessionAttachment {
    const state = this.attachments.get(sessionKey) ?? { sessionKey, attachments: {} };
    const previous = state.currentAttachmentId
      ? state.attachments?.[state.currentAttachmentId]
      : undefined;
    const runtime = directive.runtime ?? CLAUDE_FLEET_RUNTIME_ID;

    // An "attach" naming the session that is ALREADY current is a
    // re-statement, not a new delegation target — which is exactly what
    // happens when the host passes the runtime's own <agent-session> marker
    // through on every turn. Minting a fresh record for it would supersede a
    // live attachment with an identical copy of itself and grow the lineage
    // one entry per turn, so it folds into a refresh instead. An explicit
    // "replace" always mints, because it is a stated lineage decision and
    // carries its own reason.
    if (
      directive.op === "attach" &&
      previous &&
      previous.runtime === runtime &&
      previous.handle === directive.handle
    ) {
      return this.refreshCurrentAttachment(sessionKey, jobId, previous, directive);
    }

    const record: AgentSessionAttachment = {
      id: randomUUID(),
      runtime,
      provider: directive.provider,
      handle: directive.handle,
      providerSessionId: directive.providerSessionId,
      host: directive.host,
      worktree: directive.worktree,
      remoteUrl: directive.remoteUrl,
      ...(directive.metadata ? { metadata: directive.metadata } : {}),
      attachedAt: Date.now(),
      status: directive.status ?? "starting",
      // The turn that is dispatching THIS attach/replace is, by construction,
      // delegating its own work to it — see AgentSessionAttachment.delegatedTurnId.
      delegatedTurnId: jobId,
      ...(previous ? { replacesAttachmentId: previous.id } : {}),
    };

    const nextAttachments = { ...(state.attachments ?? {}), [record.id]: record };
    if (previous) {
      nextAttachments[previous.id] = {
        ...previous,
        status: "superseded",
        reason: directive.reason ?? "superseded by a new attachment",
      };
    }

    this.attachments.set(sessionKey, {
      sessionKey,
      currentAttachmentId: record.id,
      attachments: nextAttachments,
    });
    this.persistAttachments();
    logDebug(
      `[attachment] session ${sessionKey.slice(-12)} ${directive.op}ed ${record.handle} (${record.id.slice(0, 8)})` +
        (previous ? `, superseding ${previous.handle} (${previous.id.slice(0, 8)})` : ""),
    );
    return record;
  }

  /**
   * Folds a re-stated attach into the record that is already current: it keeps
   * its id, lineage, and attach time, and learns whatever the new statement
   * knows that the old one didn't. `delegatedTurnId` is re-stamped
   * unconditionally — re-stating the attachment on a new turn IS that turn
   * delegating to it, the same claim a fresh attach makes.
   *
   * Only fills in fields the statement actually carries: a marker that omits
   * `remoteUrl` is not asserting the session has none.
   */
  private refreshCurrentAttachment(
    sessionKey: string,
    jobId: string,
    current: AgentSessionAttachment,
    directive: Extract<AgentSessionDirective, { op: "attach" | "replace" }>,
  ): AgentSessionAttachment {
    this.writeAttachment(sessionKey, current.id, {
      // A re-statement by a DIFFERENT turn is a new delegation to the same
      // session: the previous turn's result/termination/liveness stop being
      // this attachment's current state. See redelegationReset.
      ...(jobId !== current.delegatedTurnId ? this.redelegationReset(current) : {}),
      delegatedTurnId: jobId,
      lastObservedAt: Date.now(),
      ...(directive.provider ? { provider: directive.provider } : {}),
      ...(directive.providerSessionId ? { providerSessionId: directive.providerSessionId } : {}),
      ...(directive.host ? { host: directive.host } : {}),
      ...(directive.worktree ? { worktree: directive.worktree } : {}),
      ...(directive.remoteUrl ? { remoteUrl: directive.remoteUrl } : {}),
      ...(directive.metadata ? { metadata: { ...current.metadata, ...directive.metadata } } : {}),
      // Same reasoning as applyDirectiveObservation's explicit-status write: a
      // re-stated marker is the newest thing anyone has told us about this
      // session, so an older read still in flight must not land on top of it.
      ...(directive.status
        ? { status: directive.status, observationToken: ++this.observationSeq }
        : {}),
    });
    logDebug(
      `[agent-session] session ${sessionKey.slice(-12)} re-stated ${current.runtime}/${current.handle} (${current.id.slice(0, 8)}), delegated to job ${jobId.slice(0, 8)}`,
    );
    return this.getAgentSessionAttachment(sessionKey) ?? current;
  }

  /**
   * The patch that retires the PREVIOUS turn's observations when the same
   * attachment is claimed by a NEW turn (a re-stated marker, or a `continue`
   * from a later job). The attachment itself survives untouched — same id,
   * same lineage, same runtime/handle/host/metadata, same attachedAt — because
   * it is genuinely the same session; what does not survive is everything that
   * described the last turn's OUTCOME, which would otherwise be read as this
   * turn's:
   *
   *   lastResult      — the previous turn's answer;
   *   termination      — why the previous turn stopped;
   *   latestResponse   — what it was saying then;
   *   alive/error      — liveness and read-failures observed for that turn;
   *   status           — reset to "starting" ONLY from a terminal state, since
   *                      a finished turn cannot describe one that just began.
   *                      A non-terminal state (running/needs_input/…) is left
   *                      alone: it may still be true, and a stated status in
   *                      the same directive overwrites it anyway.
   */
  private redelegationReset(current: AgentSessionAttachment): Partial<AgentSessionAttachment> {
    const terminal =
      current.status === "completed" ||
      current.status === "idle" ||
      current.status === "dead" ||
      current.status === "failed";
    return {
      lastResult: undefined,
      termination: undefined,
      latestResponse: undefined,
      alive: undefined,
      error: undefined,
      ...(terminal ? { status: "starting" as const } : {}),
    };
  }

  private detachAttachment(sessionKey: string, reason: string): AgentSessionAttachment | undefined {
    const state = this.attachments.get(sessionKey);
    const current = state?.currentAttachmentId
      ? state.attachments?.[state.currentAttachmentId]
      : undefined;
    if (!state || !current) return undefined;
    const detached: AgentSessionAttachment = { ...current, status: "detached", reason };
    this.attachments.set(sessionKey, {
      sessionKey,
      currentAttachmentId: undefined,
      attachments: { ...(state.attachments ?? {}), [detached.id]: detached },
    });
    this.persistAttachments();
    logDebug(
      `[attachment] session ${sessionKey.slice(-12)} detached ${detached.handle}: ${reason}`,
    );
    return detached;
  }

  private writeAttachment(
    sessionKey: string,
    attachmentId: string,
    patch: Partial<AgentSessionAttachment>,
  ): void {
    const state = this.attachments.get(sessionKey);
    const current = state?.attachments?.[attachmentId];
    if (!state || !current) return;
    const updated: AgentSessionAttachment = { ...current, ...patch };
    this.attachments.set(sessionKey, {
      ...state,
      attachments: { ...(state.attachments ?? {}), [attachmentId]: updated },
    });
    this.persistAttachments();
  }

  /**
   * Compare-and-set READ for a write whose value was computed asynchronously
   * (an adapter call awaited across a tick): returns the FRESH record only
   * when `attachmentId` is STILL this session's current attachment — never
   * the value an async callback closed over before its await, which may be
   * stale by the time it resolves (another observation can have written a
   * new status in the meantime, even without a detach/replace). A
   * detach/replace changes `currentAttachmentId` itself (to undefined, or to
   * a different new id), which this also catches — preventing a stale async
   * result from resurrecting or corrupting a now-historical
   * (detached/superseded) lineage record.
   */
  private getCurrentAttachmentIfUnchanged(
    sessionKey: string,
    attachmentId: string,
  ): AgentSessionAttachment | undefined {
    const state = this.attachments.get(sessionKey);
    if (state?.currentAttachmentId !== attachmentId) return undefined;
    return state.attachments?.[attachmentId];
  }

  /**
   * continue: applies an optional host-reported status to the CURRENT
   * attachment, and — since `continue` is the host explicitly re-affirming
   * "this turn is still delegated to this attachment" — re-stamps
   * `delegatedTurnId` to `jobId` even when status didn't change. No-op (and
   * no persistence) if there is no current attachment, or if the directive
   * states no status and claims no new delegation —
   * "continue" with no directive at all is simply omitting a directive,
   * which already leaves the existing attachment exposed on every
   * subsequent snapshot untouched (just not eligible for recovery on a turn
   * that never claimed it — see tryAttachedSessionRecovery).
   *
   * inspect: applies only an optional host-reported status (never
   * delegatedTurnId — a passive read-refresh is not a new delegation claim).
   *
   * An explicit host-reported status (on either op) is authoritative and
   * is persisted synchronously, THEN this returns immediately — it never
   * also kicks off the background liveness probe below. Two independent
   * reasons: (1) the host's own report is a stronger signal than a bare tmux
   * liveness bit and shouldn't be second-guessed by it, and (2) starting the
   * probe anyway would race it — see the callback's re-read for why a probe
   * that outlives a later status write is unsafe even when CAS-guarded by
   * identity alone.
   *
   * Only when the host supplied NO status does `inspect` fall through to a
   * bounded, single-attachment read through the runtime seam (a host-
   * registered runtime, or the built-in tmux liveness probe for claude-fleet).
   * Deliberately NOT awaited by the caller (submitTask stays synchronous,
   * matching its existing public contract): the result lands a tick later via
   * the fire-and-forget dispatch below, and every write it makes goes through
   * applyAgentSessionStatus's identity/delegation/token compare-and-set rather
   * than trusting anything this closure captured before the await.
   *
   * A `continue` carrying a `prompt` additionally DRIVES the runtime — it is
   * the one directive that delivers a follow-up turn. It dispatches even when
   * no runtime can be resolved, unlike the passive probe: the host asked for
   * something to happen, so "no runtime knows how" has to become a visible
   * `error` on the attachment rather than silence.
   */
  private applyDirectiveObservation(
    sessionKey: string,
    jobId: string | undefined,
    directive: Extract<AgentSessionDirective, { op: "continue" | "inspect" }>,
  ): void {
    const current = this.getAgentSessionAttachment(sessionKey);
    if (!current) return;

    // Built via object-literal keys rather than property assignment on
    // purpose: this file's structural one-writer tripwire test (see
    // completion-reconciliation.test.ts) regex-matches ANY `.status =`
    // assignment regardless of receiver, and `patch.status = …` here would
    // be a false positive against a Job-outcome write it was never meant to
    // catch — `patch` is a AgentSessionAttachment fragment, not a Job.
    const statusStated = directive.status !== undefined;
    const delegationChanged =
      directive.op === "continue" && jobId !== undefined && jobId !== current.delegatedTurnId;
    if (statusStated || delegationChanged) {
      this.writeAttachment(sessionKey, current.id, {
        // Same rule as a re-stated marker: a `continue` from a LATER turn is a
        // new delegation, so the previous turn's outcome fields go. Listed
        // first so an explicitly stated status still wins over the reset.
        ...(delegationChanged ? this.redelegationReset(current) : {}),
        // A status the host states directly IS an observation, and the newest
        // one — so it takes a token like any other. Without that, an `inspect`
        // probe already in flight (which does not re-stamp delegatedTurnId,
        // being a passive read) could resolve afterwards and overwrite it.
        //
        // Keyed off STATED, not CHANGED: a report that repeats the stored
        // status is still a fresh observation of NOW, and an in-flight read
        // that started before it is still older. Treating it as a no-op left
        // the token behind the report, so that older read passed the CAS and
        // replaced a status the host had just re-affirmed with what it saw
        // beforehand. An identical value written again is invisible in the
        // record apart from the token and freshness mark — which is the whole
        // point of writing it.
        ...(statusStated
          ? { status: directive.status, observationToken: ++this.observationSeq }
          : {}),
        ...(delegationChanged ? { delegatedTurnId: jobId } : {}),
        lastObservedAt: Date.now(),
      });
    }
    if (directive.op === "continue" && directive.prompt) {
      void this.runAgentSessionOp(sessionKey, { op: "continue", prompt: directive.prompt });
      return;
    }
    if (directive.status !== undefined) return;

    if (directive.op !== "inspect") return;
    // A passive refresh with nobody to ask stays a no-op, exactly as it was
    // before any runtime existed: there is no news, so the record keeps
    // whatever it already knew instead of gaining an error about our own
    // wiring. A caller who wants that answer asks runAgentSessionOp directly
    // and gets the precise unknown_runtime result.
    if (!this.resolveRuntime(current)) return;
    void this.runAgentSessionOp(sessionKey, { op: "inspect" });
  }

  /**
   * Applies an already-parsed attachment directive. Takes `jobId` explicitly
   * (rather than minting one itself) because attach/replace/continue stamp
   * `delegatedTurnId` to it — see attachOrReplace/applyDirectiveObservation
   * and AgentSessionAttachment.delegatedTurnId. Called from submitTask only
   * on the REAL dispatch path (never for a "session busy" rejection): a
   * directive whose turn never actually dispatched must not claim/burn a
   * delegation slot, and must not silently invalidate whatever turn
   * currently legitimately owns it.
   */
  private applyAgentSessionDirective(
    sessionKey: string,
    jobId: string,
    directive: AgentSessionDirective,
  ): void {
    switch (directive.op) {
      case "attach":
      case "replace":
        this.attachOrReplace(sessionKey, jobId, directive);
        break;
      case "detach": {
        // Ask the runtime to stop the session BEFORE the local pointer goes
        // away (afterwards there is no attachment left to address), but never
        // wait on it and never let it change the outcome: the local detach is
        // the durable decision, and a runtime that is down must not be able to
        // wedge a conversation into staying attached to something it has
        // abandoned. The result is logged, not written back — by the time it
        // lands the record is already terminal lineage.
        const current = this.getAgentSessionAttachment(sessionKey);
        if (current && directive.stopRuntime) this.stopRuntimeSession(current, directive.reason);
        this.detachAttachment(sessionKey, directive.reason);
        break;
      }
      case "continue":
        this.applyDirectiveObservation(sessionKey, jobId, directive);
        break;
      case "inspect":
        // Passive read-refresh — never stamps delegatedTurnId.
        this.applyDirectiveObservation(sessionKey, undefined, directive);
        break;
    }
  }

  /**
   * Best-effort "end this session in its runtime too", for a detach that
   * explicitly asked for it (see AgentSessionDirective's `stopRuntime`). Never
   * throws — dispatchAgentSession turns every failure into a status — and
   * never writes: the local detach that follows is what is durable.
   */
  private stopRuntimeSession(record: AgentSessionAttachment, reason: string): void {
    void dispatchAgentSession(
      this.resolveRuntime(record),
      this.agentSessionRef(record),
      { op: "detach", reason },
      { now: Date.now() },
    ).then((status) => {
      logDebug(
        `[agent-session] runtime detach of ${record.runtime}/${record.handle}: ${status.error ? `${status.error.code} — ${status.error.message}` : status.state}`,
      );
    });
  }

  /**
   * Reads the attachment through whichever path can produce a TRUSTWORTHY
   * final answer for a completed turn, for the recovery tier below:
   *
   *   - a host-registered runtime answers through its own `inspect`, and the
   *     shared normalization guarantees `finalResponse` only exists in a
   *     completed-turn state;
   *   - claude-fleet with no host-registered runtime falls back to the
   *     FleetAdapter's terminal transcript read, which carries its own,
   *     stronger trust gate (the tmux session must have ENDED, and the
   *     transcript entry supplies its own timestamp) than a liveness probe
   *     could. That is why recovery does not simply reuse `inspect` here.
   *
   * Anything else — an unknown runtime, no adapter — yields undefined, and the
   * caller falls through to today's completed_no_summary.
   *
   * The `source` it reports is what the job's `resultSource` becomes:
   * "fleet-transcript" stays the LEGACY claude-fleet transcript path only, so
   * a result recovered from an arbitrary runtime is never mislabelled as one
   * read out of a Claude Code transcript.
   */
  private async observeForRecovery(
    record: AgentSessionAttachment,
  ): Promise<{ status: AgentSessionStatus; source: ResultSource } | undefined> {
    const ref = this.agentSessionRef(record);
    const now = Date.now();
    const registered = this.runtimes?.get(record.runtime);
    if (registered) {
      const status = await dispatchAgentSession(registered, ref, { op: "inspect" }, { now });
      return { status, source: "agent-session" };
    }
    if (record.runtime !== CLAUDE_FLEET_RUNTIME_ID || !this.fleetAdapter) return undefined;
    try {
      // Bounded for the same reason a runtime callback is (see
      // withAgentSessionTimeout): this read runs on the path that decides a
      // job's terminal status, and an adapter that never answers must not be
      // able to hold a job in `running` forever.
      const handoff = await withAgentSessionTimeout((signal) =>
        this.fleetAdapter!.readTerminalHandoff(record, signal),
      );
      if (!handoff?.text) return undefined;
      return {
        status: normalizeAgentSessionObservation(
          ref,
          // `resultAt` is the transcript entry's OWN timestamp — never wall-clock
          // read time — which is what makes the freshness bound below meaningful.
          { state: "completed", finalResponse: handoff.text, lastEventAt: handoff.resultAt },
          now,
        ),
        source: "fleet-transcript",
      };
    } catch (err) {
      logDebug(
        `[agent-session] readTerminalHandoff failed for ${record.handle}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * Recovery order tier 3 (see docs/architecture/2026-08-02-managed-fleet-
   * attachment-plan.md §8) — reached ONLY from the two places in this file
   * where the parent's own live+transcript recovery has already given up.
   * Consults ONLY the session's known current attachment via the injected
   * FleetAdapter; returns undefined (never synthesizes a fake completion)
   * for any of:
   *   - no attachment, or no adapter configured;
   *   - the attachment was not delegated to THIS turn (delegatedTurnId does
   *     not match `job.jobId`) — otherwise a still-current attachment left
   *     over from an earlier, unrelated turn could answer a LATER task it
   *     never actually worked on;
   *   - the attachment is `needs_input`/`needs_permission`/`failed` — an
   *     explicit signal that the child is NOT simply finished, which must
   *     stay actionable rather than being papered over by leftover output;
   *   - the runtime has nothing trustworthy yet, or reported anything short
   *     of a genuinely completed turn (see COMPLETED_TURN_STATES — a partial
   *     answer from a running or blocked session never becomes a result);
   *   - the read failed, or could not date its own answer;
   *   - that answer predates this turn even starting (stale output correlated
   *     to an earlier delegation);
   *   - the attachment was detached/replaced, re-delegated, or overtaken by a
   *     newer observation while the runtime call was in flight (see
   *     applyAgentSessionStatus's three-part compare-and-set).
   */
  private async tryAttachedSessionRecovery(
    job: Job,
  ): Promise<{ summary: string; attachmentId: string; resultSource: ResultSource } | undefined> {
    if (!this.fleetAdapter && !this.runtimes) return undefined;
    const current = this.getAgentSessionAttachment(job.sessionKey);
    if (!current) return undefined;

    if (!current.delegatedTurnId || current.delegatedTurnId !== job.jobId) return undefined;
    if (isBlockedAgentSessionState(current.status) || current.status === "failed") return undefined;
    const attachmentId = current.id;
    const delegatedTurnId = current.delegatedTurnId;
    const token = ++this.observationSeq;

    const observed = await this.observeForRecovery(current);
    if (!observed) return undefined;
    const { status, source } = observed;
    if (status.error) {
      // The read failed, so it says nothing about the session — but THAT it
      // failed is worth keeping, or a timed-out runtime looks identical to one
      // that answered "nothing yet". applyAgentSessionStatus's error branch
      // writes the error and touches no session state.
      this.applyAgentSessionStatus(job.sessionKey, attachmentId, delegatedTurnId, token, status);
      return undefined;
    }
    if (!isCompletedTurnState(status.state) || !status.finalResponse) {
      // Not this turn's answer — but it IS current news about the session
      // ("needs_input", "still running", …), and dropping it on the floor is
      // how a block stays invisible until something else happens to read it.
      // Folded in through the same guarded write-back as any other
      // observation; it cannot produce a result, only a state.
      this.applyAgentSessionStatus(job.sessionKey, attachmentId, delegatedTurnId, token, status);
      return undefined;
    }

    // A result we cannot date cannot be proven to belong to THIS turn, and an
    // undatable answer must read as "nothing trustworthy yet" rather than as
    // an untimestamped success — the same rule fleet-adapter.ts applies when
    // it skips a transcript entry with no parseable timestamp.
    const resultAt = status.lastEventAt ?? status.termination?.at;
    if (resultAt === undefined) {
      logDebug(
        `[agent-session] ignoring undatable result from ${current.runtime}/${current.handle}`,
      );
      return undefined;
    }
    if (resultAt < job.startedAt) {
      logDebug(
        `[agent-session] discarding stale result for ${current.handle}: resultAt ${resultAt} predates job ${job.jobId.slice(0, 8)}'s start ${job.startedAt}`,
      );
      return undefined;
    }

    // The same attachment can be re-delegated to a newer parent turn, or read
    // again, while the runtime call is in flight. The write-back is the one
    // place that decides whether this answer is still allowed to be durable —
    // and if it isn't, it isn't allowed to complete the job either.
    if (!this.applyAgentSessionStatus(job.sessionKey, attachmentId, delegatedTurnId, token, status))
      return undefined;
    return { summary: status.finalResponse, attachmentId, resultSource: source };
  }

  /**
   * The blocked state of the session THIS turn delegated to, when there is
   * one. A turn that ends with nothing to show because its delegate is waiting
   * on a human is not an ordinary quiet finish, and the two must not read
   * alike on any surface — see delegateBlockedTerminalReason.
   *
   * Delegation-scoped like tryAttachedSessionRecovery: an attachment left current from
   * some earlier turn says nothing about this one.
   */
  private blockedDelegation(job: Job): AgentSessionAttachment | undefined {
    const current = this.getAgentSessionAttachment(job.sessionKey);
    if (!current || current.delegatedTurnId !== job.jobId) return undefined;
    return isBlockedAgentSessionState(current.status) ? current : undefined;
  }

  submitTask(input: TaskInput): Job {
    const { sessionKey, migratedFromLegacy } = resolveSessionKey(input.sessionKey, this.agentId);

    // Parse (but do not yet apply) any attachment directive — buildSubmitMessage
    // must never see the raw directive block, so it's stripped here
    // regardless of what happens next. Application is DEFERRED until the
    // busy check below has passed, so a directive always correlates to the
    // REAL job it rides in on (see applyAgentSessionDirective's delegatedTurnId
    // stamping) — a "session busy" rejection must not be able to claim or
    // burn a delegation slot that belongs to the job actually running.
    const parsedDirective = parseSessionHandoff(input.context);
    const strippedContext = parsedDirective ? parsedDirective.strippedText : input.context;
    const effectiveInput: TaskInput =
      strippedContext === input.context ? input : { ...input, context: strippedContext };

    // buildSubmitMessage prepends the `message`-tool veto preamble, the
    // sender identity, and optional context block in the canonical order
    // tested in session.test.ts.
    const message = buildSubmitMessage(effectiveInput);

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
        prompt: {
          task: effectiveInput.task,
          context: effectiveInput.context,
          senderName: effectiveInput.senderName,
        },
      };
      this.jobs.set(busyJobId, busyJob);
      logDebug(
        `[job ${busyJobId.slice(0, 8)}] rejected: session ${sessionKey} busy with job ${priorJobId?.slice(0, 8)}`,
      );
      return busyJob;
    }

    const jobId = randomUUID();
    // Apply the directive now that we know it correlates to a REAL turn.
    if (parsedDirective)
      this.applyAgentSessionDirective(sessionKey, jobId, parsedDirective.directive);
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
      prompt: {
        task: effectiveInput.task,
        context: effectiveInput.context,
        senderName: effectiveInput.senderName,
      },
    };
    if (!input.sessionKey) {
      pushLog(job, {
        ts: now,
        type: "lifecycle",
        text: `Started new thread session: ${sessionKey}`,
      });
    } else if (migratedFromLegacy) {
      pushLog(job, {
        ts: now,
        type: "lifecycle",
        text: `Migrated legacy ChatGPT session to new thread: ${sessionKey}`,
      });
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
      .chat(
        sessionKey,
        message,
        TIMEOUT_MS,
        (event) => {
          job.lastEventAt = Date.now();
          this.noteLiveActivity(jobId, event);
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
        },
        (runId) => {
          // openclaw's handle for this run. Reconciliation correlates against
          // it so "is THIS run still going?" is answered by upstream rather
          // than inferred from transcript stillness.
          this.upstreamRunIds.set(jobId, runId);
          // Persisted immediately (not just kept in the in-memory
          // upstreamRunIds map, which is cleared on clearReconciler) so a
          // restart doesn't lose which upstream run this job corresponds to.
          job.parentRunId = runId;
          this.persistActiveJobs();
          logDebug(`[job ${jobId.slice(0, 8)}] upstream runId ${runId}`);
        },
      )
      .then(
        (reply) => {
          // chat() settled: the live stream answered for itself, so the quiet
          // watchdog has nothing left to reconcile.
          this.clearReconciler(jobId);
          const noSummary = !reply || reply === NO_SUMMARY_SENTINEL;
          if (job.status !== "running") {
            // Reconciliation already finalized this job while chat() was
            // still pending. chat() settling is the last live evidence this
            // job can ever receive, so the outcome stops being provisional
            // either way — that also bounds the re-read loop, which an
            // unchanging transcript would otherwise keep alive forever.
            // When the settlement carries real text it is the run's actual
            // terminal answer and replaces the inference, including a
            // reconciled `completed` whose summary may be text the run had
            // merely written on its way past. An outcome that came from a
            // real terminal event is never provisional and is left alone.
            const wasProvisional = this.provisionalOutcomes.delete(jobId);
            this.recheckSettled.delete(jobId);
            if (!noSummary && wasProvisional) {
              job.lastEventAt = Date.now();
              // Real terminal text always wins over a provisional inference
              // — including one this file itself produced via an attached session
              // recovery — so resultSource is reset to "parent" here
              // unconditionally.
              this.setOutcome(job, "completed", reply, undefined, {
                resultSource: "parent",
                terminalReason: "live-final-late",
              });
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
              logDebug(
                `[job ${jobId}] late live final replaced the provisional reconciled outcome`,
              );
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
          this.setOutcome(job, "completed", reply, undefined, {
            resultSource: "parent",
            terminalReason: "live-final",
          });
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
          // new information about the run. It is still a settlement, though,
          // so the outcome stops being provisional — nothing can replace it
          // now, and the re-read loop has nothing left to wait for.
          if (job.status !== "running") {
            this.provisionalOutcomes.delete(jobId);
            this.recheckSettled.delete(jobId);
            return;
          }
          job.lastEventAt = Date.now();
          if (isParentObservationTimeout(err)) {
            // The parent's observation window elapsed. Nothing aborted the
            // run — openclaw is very likely still executing it, and on real
            // traffic a run that outlasts TIMEOUT_MS still writes its final
            // answer to the durable transcript afterwards. Turning that into
            // `error` invents a failure the caller then can't poll past, so
            // hand the job to the same transcript recovery an empty
            // chat:final uses: it stays `running` (pollable, non-error) and
            // reaches a terminal status from durable evidence rather than
            // from the parent's own impatience. Every other chat()
            // rejection — error/aborted/RPC/connection — is an upstream
            // verdict and stays terminal below.
            this.recoverLateFinalText(
              job,
              sessionKey,
              jobId,
              artifacts,
              "parent_observation_timeout",
            );
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          this.setOutcome(job, "error", undefined, message, {
            resultSource: "parent",
            terminalReason: "chat-error",
          });
          this.sessions.set(sessionKey, {
            sessionKey,
            lastJobId: jobId,
            lastSummary: message,
            artifacts,
            recommendedNextStep: deriveNextStep(artifacts, "error"),
          });
          this.persistActiveJobs();
          logDebug(`[job ${jobId}] error (${classifyError(message).category}): ${message}`);
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
    // The round is fire-and-forget, so an unexpected throw inside it would
    // surface as an unhandledRejection and take the connector down — losing
    // the whole in-memory jobs map. Contain it: drop the watchdog for this
    // job and let the chat() timeout remain its outer bound.
    const timer = setTimeout(() => {
      this.reconcileQuietRun(job).catch((err: unknown) => {
        logDebug(
          `[job ${job.jobId}] reconcile round threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.clearReconciler(job.jobId);
      });
    }, delayMs);
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
    this.reconcilers.set(job.jobId, {
      timer,
      rounds: 0,
      activityGeneration: 0,
      outstandingTools: 0,
      candidateText: "",
      snapshotKey: "",
    });
  }

  /**
   * A live event proves the run is alive right now, which invalidates every
   * quiet round accumulated before it. Without this, two unrelated quiet gaps
   * minutes apart — with real activity in between — would add up to the round
   * cap and force a live run terminal.
   */
  private noteLiveActivity(jobId: string, event: GatewayEvent): void {
    const state = this.reconcilers.get(jobId);
    if (!state) return;
    state.rounds = 0;
    state.candidateText = "";
    state.snapshotKey = "";
    // Invalidates any round currently awaiting a transcript read, which
    // captured this value before it changed.
    state.activityGeneration += 1;
    if (event.type === "tool") state.outstandingTools += 1;
    // Floored: a `tool` start frame lost in a reconnect window would
    // otherwise drive this negative and permanently mask later tool work.
    else if (event.type === "tool-result") {
      state.outstandingTools = Math.max(0, state.outstandingTools - 1);
    }
  }

  private clearReconciler(jobId: string): void {
    this.upstreamRunIds.delete(jobId);
    const state = this.reconcilers.get(jobId);
    if (!state) return;
    clearTimeout(state.timer);
    this.reconcilers.delete(jobId);
  }

  /**
   * The live stream has been silent for RECONCILE_QUIET_MS. Ask upstream what
   * actually happened. Only positive evidence decides anything:
   *
   *   upstream still advancing   → stay `running` (and reset the round count)
   *   upstream settled, has text → `completed`, once the SAME text repeats
   *                                across consecutive successful rounds
   *   upstream settled, no text  → stay `running`
   *   upstream unreadable        → stay `running`
   *
   * Absence is never a verdict: a frozen transcript with no live events is
   * indistinguishable from a model composing a long final answer, which on
   * real traffic runs for 20+ minutes (see the no-terminal-from-absence note
   * below). Runs that genuinely end without producing text stay bounded by
   * chat()'s own TIMEOUT_MS, exactly as before this existed.
   *
   * The `completed` it can produce is an inference, not ground truth, so it
   * is recorded as provisional — a late live final overwrites it, and
   * `maybeRecoverTerminalJob` keeps re-reading it until a CHANGED read
   * confirms it.
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

    // A tool call that started and has not returned is positive evidence the
    // run is alive, and it explains the silence completely: live events fire
    // at a tool's start and its result and nowhere in between, and the
    // transcript stays frozen on whatever the agent wrote before calling it.
    // Two stable samples across a ten-minute Bash therefore say nothing —
    // promoting that frozen text to `completed` would freeze the wrong
    // summary AND release the session guard out from under live work.
    // Nothing upstream can tell us more than we already know, so this
    // doesn't even spend the transcript read.
    if (owner.outstandingTools > 0) {
      logDebug(
        `[job ${job.jobId}] quiet for ${Math.round(quietSinceMs / 1000)}s but ` +
          `${owner.outstandingTools} tool call(s) still in flight — not reconciling`,
      );
      this.scheduleReconcile(job, RECONCILE_QUIET_MS);
      return;
    }

    // Only for the log line — the round that actually decides anything is
    // recomputed after the await, once mid-round activity has been ruled out.
    const attemptedRound = owner.rounds + 1;
    // Captured before anything can await, alongside the ownership token.
    const activityGenerationAtStart = owner.activityGeneration;
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text:
        `No live activity for ${Math.round(quietSinceMs / 1000)}s — reconciling against the ` +
        `upstream transcript (round ${attemptedRound})`,
    });
    logDebug(
      `[job ${job.jobId}] quiet for ${Math.round(quietSinceMs / 1000)}s — reconciling (round ${attemptedRound})`,
    );

    let observation: RunObservation;
    try {
      observation = await this.gateway.reconcileRun(job.sessionKey, {
        samples: 2,
        intervalMs: RECONCILE_SAMPLE_INTERVAL_MS,
        runId: this.upstreamRunIds.get(job.jobId),
      });
    } catch (err) {
      logDebug(
        `[job ${job.jobId}] reconcile threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      observation = {
        ok: false,
        changed: false,
        trailingText: "",
        snapshotKey: "",
        upstream: "unknown",
      };
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

    // Record what this round learned about liveness before deciding anything
    // with it. This is the only place a reader can find out whether a silent
    // run is still executing, and it is recorded on EVERY round — including
    // the ones below that conclude nothing and just re-arm — so a consumer
    // never has to infer "still alive" from the absence of an outcome.
    job.liveness = {
      checkedAt: Date.now(),
      upstream: observation.upstream,
      producing: observation.changed,
    };

    // A live event during the read is proof the run is alive, and it already
    // reset the round count — but this round captured its round number
    // before that happened. Acting on it would let a stale count reach the
    // cap and mark a demonstrably live job terminal, freeing the
    // busy-session guard out from under a run that is still going.
    if (owner.activityGeneration !== activityGenerationAtStart) {
      pushLog(job, {
        ts: Date.now(),
        type: "recovery",
        text: "Live activity arrived while reconciling — the task is still running",
      });
      logDebug(`[job ${job.jobId}] reconcile round superseded by live activity — rescheduling`);
      this.scheduleReconcile(job, RECONCILE_QUIET_MS);
      return;
    }

    // Recomputed now that the observation is known to be current.
    const round = owner.rounds + 1;

    // Upstream says the run is still executing. That is positive evidence,
    // and it is the ONLY thing that separates a model composing a long answer
    // from a run that ended writing nothing — both freeze the transcript.
    // Verified on the wire: a sleeping run reported hasActiveRun=true with
    // its runId listed while the transcript sat at one user message.
    if (observation.upstream === "active") {
      pushLog(job, {
        ts: Date.now(),
        type: "recovery",
        text: "Upstream confirms the run is still executing — the task is still running",
      });
      owner.rounds = 0;
      owner.candidateText = "";
      if (observation.ok) owner.snapshotKey = observation.snapshotKey;
      this.scheduleReconcile(job, RECONCILE_QUIET_MS);
      return;
    }

    // NOTE: there is deliberately no terminal branch here. `hasActiveRun`
    // going false is not a termination receipt — see classifyUpstreamRun.
    // Absence still never ends a job; only confirmed text or chat() itself
    // does.
    //
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
    // and an active run can leave an interim line in the trailing-assistant
    // slot and then work for minutes without returning to it — see the
    // stability note in pollTranscriptForFinalText. Text seen once proves
    // nothing, and there is no round count that substitutes for a second
    // sighting: unconfirmed text simply leaves the job running.
    const textConfirmed =
      observation.ok &&
      observation.trailingText.length > 0 &&
      observation.trailingText === owner.candidateText;
    if (textConfirmed) {
      this.finalizeReconciled(job, observation.trailingText);
      return;
    }

    // Upstream unknown or unreadable: keep waiting. chat()'s TIMEOUT_MS is
    // the outer bound, exactly as before reconciliation existed.
    owner.rounds = round;
    owner.candidateText = observation.ok ? observation.trailingText : "";
    if (observation.ok) owner.snapshotKey = observation.snapshotKey;
    this.scheduleReconcile(job, RECONCILE_QUIET_MS);
  }

  /**
   * Complete a job from recovered transcript text. `completed` is the only
   * outcome reconciliation can produce — absence never terminates a job — so
   * this takes no status parameter. The result is marked provisional: it came
   * from a transcript read, not from a terminal event.
   */
  private finalizeReconciled(
    job: Job,
    summary: string,
    status: "completed" | "completed_no_summary" = "completed",
  ): void {
    this.clearReconciler(job.jobId);
    this.provisionalOutcomes.add(job.jobId);
    job.lastEventAt = Date.now();
    this.setOutcome(
      job,
      status,
      status === "completed" ? summary : NO_SUMMARY_SENTINEL,
      undefined,
      {
        resultSource: "parent",
        terminalReason:
          status === "completed" ? "reconciled-transcript-match" : "reconciled-no-text",
      },
    );
    if (status === "completed") extractPatternsFromSummary(job.artifacts, summary);
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text:
        status === "completed"
          ? "Recovered the final response from the upstream transcript after the live stream went quiet"
          : "Upstream confirms the run ended without producing a visible response",
    });
    this.sessions.set(job.sessionKey, {
      sessionKey: job.sessionKey,
      lastJobId: job.jobId,
      lastSummary: (job.summary ?? "").slice(0, 500),
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
   *
   * Three entry points, one behaviour: an empty chat:final
   * ("no_live_final_text"), a restart reattaching to a job it can no longer
   * stream (rehydrateFromStore), and chat()'s wait window elapsing on a run
   * still executing upstream ("parent_observation_timeout"). All three lose
   * the live channel without learning that the RUN failed, so all three ask
   * the durable transcript instead of inventing a terminal error.
   */
  private recoverLateFinalText(
    job: Job,
    sessionKey: string,
    jobId: string,
    artifacts: Job["artifacts"],
    reason: JobRecoveryState["reason"] = "no_live_final_text",
  ): void {
    const intervalMs = 10_000;
    // The poll auto-extends while the transcript is being actively written —
    // there's no fixed window. The two natural exits are stability (the run
    // produced its final answer) and `idleTimeoutMs` (the run went quiet
    // without writing visible text). `hardCapMs` is a safety net for runs
    // that produce activity forever without ever stabilizing.
    const idleTimeoutMs = 5 * 60_000;
    const hardCapMs = RECOVERY_TIMEOUT_MS;
    const startedAt = Date.now();
    job.recovery = {
      reason,
      startedAt,
      idleTimeoutMs,
      hardCapMs,
    };
    pushLog(job, {
      ts: Date.now(),
      type: "recovery",
      text:
        reason === "parent_observation_timeout"
          ? "The live stream's wait window elapsed while the run was still going — watching the upstream transcript for its final response"
          : "Recovering late transcript final text after live stream ended without visible final text",
    });
    logDebug(
      `[job ${jobId}] ${reason} — starting transcript long-poll ` +
        `(idle-timeout=${idleTimeoutMs / 1000}s, hard-cap=${hardCapMs / 1000}s)`,
    );
    void this.watchTranscript(job, sessionKey, jobId, artifacts, {
      intervalMs,
      idleTimeoutMs,
      hardCapMs,
      startedAt,
    }).catch((err: unknown) => {
      // Belt-and-suspenders: the recovery path is fire-and-forget, so an
      // uncaught error here would otherwise propagate as an unhandledRejection,
      // crash the connector, and force launchd to kickstart — losing the
      // entire in-memory jobs map. Mark the job terminal cleanly instead.
      if (job.status !== "running") return;
      job.lastEventAt = Date.now();
      this.setOutcome(job, "completed_no_summary", NO_SUMMARY_SENTINEL, undefined, {
        resultSource: "parent",
        terminalReason: "late-recovery-threw",
      });
      job.recovery = undefined;
      this.sessions.set(sessionKey, {
        sessionKey,
        lastJobId: jobId,
        lastSummary: NO_SUMMARY_SENTINEL.slice(0, 500),
        artifacts,
        recommendedNextStep: deriveNextStep(artifacts, job.status),
      });
      this.persistActiveJobs();
      logDebug(
        `[job ${jobId}] late-recovery threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * The watch itself, and the one decision the transcript poll is not allowed
   * to make on its own: whether a still transcript may end the turn.
   *
   * The poll exits after `idleTimeoutMs` of no transcript growth. That is a
   * statement about the TRANSCRIPT, not about the run — and the two come apart
   * exactly when it matters. Production shape: openclaw restarts mid-run,
   * re-dispatches the session's interrupted run, and the resumed run works for
   * many minutes through tool rounds and model calls without the persisted
   * transcript advancing. The poll's idle exit fired on schedule, the turn was
   * published `completed_no_summary`, and the busy guard was released out from
   * under a run that was demonstrably still executing — which is precisely the
   * collision submitTask's guard exists to prevent.
   *
   * So absence is never a verdict here either — the same rule reconcileQuietRun
   * has always applied, now applied on this path too, from the same evidence
   * (openclaw's own run registry, via the poll's per-read `onSample`). While
   * upstream says the run is executing, the watch re-arms for the remaining
   * hard-cap budget and the job stays `running`: pollable, non-error, and
   * still holding its session.
   *
   * `hardCapMs` remains the absolute ceiling. Reaching it while upstream STILL
   * reports the run executing is not a quiet finish and must not be published
   * as one — that outcome ends the job in `error` with what was actually
   * observed and the one retry that helps, rather than as a turn that
   * "completed with nothing to say".
   */
  private async watchTranscript(
    job: Job,
    sessionKey: string,
    jobId: string,
    artifacts: Job["artifacts"],
    window: { intervalMs: number; idleTimeoutMs: number; hardCapMs: number; startedAt: number },
  ): Promise<void> {
    // Seeded "unknown" — the absence of positive evidence, never its converse.
    // A gateway that never reports a sample (an unreadable transcript, a
    // legacy/mocked poll) therefore behaves exactly as it did before: the
    // exhaustion path below runs untouched.
    //
    // Held on an object rather than in a plain `let` so the callback's writes
    // are visible to the type checker: a `let` seeded with one member of the
    // union narrows to it at declaration, and a write from inside a closure
    // does not widen it back — every comparison below would then be flagged as
    // impossible while being exactly the comparison that matters.
    //
    // `at` is when this observation was MADE, and it only advances on a read
    // that actually reached upstream. A run of failed reads therefore leaves
    // the verdict standing (deliberately — see the extension branch) while its
    // age grows, which is what stops a minutes-old "active" from being
    // reported as a fresh confirmation.
    const observed: { upstream: RunObservation["upstream"]; at: number } = {
      upstream: "unknown",
      at: window.startedAt,
    };
    let extensions = 0;
    let recovered: string | undefined;

    for (;;) {
      const remainingMs = window.hardCapMs - (Date.now() - window.startedAt);
      if (remainingMs <= 0) break;
      recovered = await this.gateway.pollTranscriptForFinalText(sessionKey, {
        intervalMs: window.intervalMs,
        idleTimeoutMs: window.idleTimeoutMs,
        // The REMAINING budget, not a fresh one: re-arming must not be able to
        // extend the absolute ceiling, only to use what is left of it.
        hardCapMs: remainingMs,
        // Require 3 consecutive same-snapshot polls — 30s of no transcript
        // growth — before accepting the trailing-assistant text as final.
        // Without this the poll grabs whatever short status line happens to
        // be in the trailing slot at first observation, even when the run
        // keeps writing for minutes and never comes back to assistant-text.
        stableThreshold: 3,
        runId: job.parentRunId,
        shouldAbort: () => job.status !== "running",
        onSample: (sample) => {
          // A read that resolves after the job was settled by something else
          // (a late live final, a newer owner) describes a world this job no
          // longer lives in. Writing it would stamp fresh "still executing"
          // evidence onto an already-published turn — the exact contradiction
          // this whole path exists to remove.
          if (job.status !== "running") return;
          observed.upstream = sample.upstream;
          observed.at = sample.checkedAt;
          // Recorded on EVERY read, exactly as reconcileQuietRun records its
          // own rounds. Without it a job spends its whole recovery with
          // liveness frozen at whatever the last quiet round saw — or with
          // none at all — while a read that could answer the question runs
          // every 10 seconds. A consumer that ages liveness out (the widget
          // does, at 5 minutes) then reports a watched, demonstrably live run
          // as one nothing has looked at.
          //
          // Only a read that REACHED upstream gets here (the gateway skips a
          // failed sample), so `checkedAt` measures the evidence, not the
          // attempt — a stretch of failed reads correctly ages this out
          // instead of refreshing a verdict nobody re-confirmed.
          job.liveness = {
            checkedAt: sample.checkedAt,
            upstream: sample.upstream,
            producing: sample.changed,
          };
        },
      });
      if (job.status !== "running") return;
      // Same ownership check its two siblings make. Reachable: a job
      // store carrying two entries for one sessionKey makes both jobs
      // `running` with only the later one owning the session, and this
      // poll then adopts the newer run's answer for the older job. The
      // live writer cannot produce that (busy guard + whole-file
      // overwrite), but a hand-edited, legacy or truncated store can.
      if (this.latestJobBySession.get(sessionKey) !== jobId) return;
      if (recovered && recovered.length > 0) break;
      if (observed.upstream !== "active") break;

      extensions += 1;
      const watchedS = Math.round((Date.now() - window.startedAt) / 1000);
      const evidenceAgeMs = Date.now() - observed.at;
      // The verdict still holds the watch open even when it is old — a stale
      // "active" is still the last thing anyone actually saw, and letting an
      // unreadable gateway release the busy guard would hand the failure mode
      // straight back. What must NOT survive the staleness is the CLAIM: an
      // observation minutes old is reported as one, not as a confirmation of
      // now.
      const fresh = evidenceAgeMs <= window.intervalMs * 3;
      pushLog(job, {
        ts: Date.now(),
        type: "recovery",
        text: fresh
          ? `Upstream confirms the run is still executing (checked ${describeAge(evidenceAgeMs)}) after ` +
            `${watchedS}s with a still transcript — still watching for its final response`
          : `Upstream last reported the run executing ${describeAge(evidenceAgeMs)} and has not been ` +
            `readable since; after ${watchedS}s with a still transcript — still watching rather than ` +
            `assuming it ended`,
      });
      logDebug(
        `[job ${jobId}] transcript idle but upstream${job.parentRunId ? ` run ${job.parentRunId}` : ""} last ` +
          `reported executing ${describeAge(evidenceAgeMs)} (watched ${watchedS}s) — extending the watch ` +
          `(extension ${extensions})`,
      );
    }

    if (job.status !== "running") return;
    if (this.latestJobBySession.get(sessionKey) !== jobId) return;
    job.lastEventAt = Date.now();

    if (recovered && recovered.length > 0) {
      this.setOutcome(job, "completed", recovered, undefined, {
        resultSource: "parent",
        terminalReason: "late-recovery-transcript",
      });
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
      logDebug(`[job ${jobId}] late-recovery succeeded via transcript (${recovered.length} chars)`);
      return;
    }

    // Recovery order tier 3: the parent's own live+transcript avenues
    // are exhausted (this is the ONLY branch where this is called from
    // a still-`running` job, and only after the checks above already
    // confirmed nothing upstream is left to wait for). Consults only
    // this session's known current attachment, never a scan —
    // see tryAttachedSessionRecovery.
    const attached = await this.tryAttachedSessionRecovery(job);
    if (attached && job.status === "running" && this.latestJobBySession.get(sessionKey) === jobId) {
      // Marked provisional so the existing lazy-recheck path
      // (maybeRecoverTerminalJob) keeps re-reading the PARENT
      // transcript on later polls and can still upgrade this to a real
      // parent result — see the "late parent final replaces
      // provisional attached-session result" requirement.
      this.provisionalOutcomes.add(jobId);
      job.lastEventAt = Date.now();
      this.setOutcome(job, "completed", attached.summary, undefined, {
        resultSource: attached.resultSource,
        terminalReason: `${attached.resultSource}-recovery`,
      });
      job.recovery = undefined;
      extractPatternsFromSummary(artifacts, attached.summary);
      pushLog(job, {
        ts: Date.now(),
        type: "recovery",
        text: `Recovered the final response from the attached agent session (${attached.attachmentId.slice(0, 8)}) after the parent transcript produced nothing`,
      });
      this.sessions.set(sessionKey, {
        sessionKey,
        lastJobId: jobId,
        lastSummary: attached.summary.slice(0, 500),
        artifacts,
        recommendedNextStep: deriveNextStep(artifacts, job.status),
      });
      this.persistActiveJobs();
      logDebug(
        `[job ${jobId}] recovered via the attached session (${attached.summary.length} chars)`,
      );
      return;
    }
    // There IS one thing left to say when the delegate is waiting on a
    // human: this turn is not an ordinary quiet finish, and presenting
    // it as one hides an action the caller has to take. The job status
    // stays `completed_no_summary` (no new JobStatus, so every existing
    // consumer keeps working) — what changes is that the summary and
    // terminalReason say what is actually blocked. See blockedDelegation.
    //
    // Checked BEFORE the still-active branch below, and deliberately: a
    // blocked delegate is a MORE specific answer to "why has nothing
    // happened" than "the parent gave up on a run that was still ticking",
    // and it is the one that carries the action a human can take. The
    // resulting `completed_no_summary` is not the "quietly finished with
    // nothing to say" outcome this path otherwise refuses to publish over an
    // active run — it carries a notice and reads as `needs-human` on every
    // listing (see deriveTaskStatus / isDelegateBlockedTerminalReason).
    const blocked = this.blockedDelegation(job);
    const blockedNotice = describeBlockedAgentSession(blocked);
    if (blocked && blockedNotice) {
      this.setOutcome(job, "completed_no_summary", blockedNotice, undefined, {
        resultSource: "parent",
        terminalReason: delegateBlockedTerminalReason(blocked.status as AgentSessionState),
      });
      job.recovery = undefined;
      pushLog(job, { ts: Date.now(), type: "recovery", text: blockedNotice });
      this.sessions.set(sessionKey, {
        sessionKey,
        lastJobId: jobId,
        lastSummary: blockedNotice.slice(0, 500),
        artifacts,
        recommendedNextStep: deriveNextStep(artifacts, job.status),
      });
      this.persistActiveJobs();
      logDebug(
        `[job ${jobId}] late-recovery exhausted — delegate is ${blocked.status}, so the turn is blocked, not finished`,
      );
      return;
    }

    // Nothing was recoverable from anywhere, and the hard cap ran out while
    // upstream had reported the run executing. Falling through to
    // `completed_no_summary` here would state as fact the one thing the
    // evidence contradicts — that the turn finished with nothing to say — so
    // this ends honestly instead: what was observed and WHEN, and the one
    // action that helps. The job stays eligible for the lazy transcript
    // re-check on every later poll, so an answer that lands afterwards still
    // reaches the caller (see maybeRecoverTerminalJob).
    if (observed.upstream === "active") {
      const watchedMin = Math.max(1, Math.round((Date.now() - window.startedAt) / 60_000));
      const runLabel = job.parentRunId ? `upstream run ${job.parentRunId}` : "the upstream run";
      // Never present-tense: `observed` is the last read that SUCCEEDED, and
      // if the later reads failed it can be minutes old. Saying "is still
      // executing" off a stale read manufactures a confirmation nobody made.
      const message =
        `Stopped watching after ${watchedMin}m: ${runLabel} was last reported executing ` +
        `${describeAge(Date.now() - observed.at)}, and wrote no visible response to the transcript ` +
        `in that time.`;
      const guidance = upstreamStillActiveGuidance(jobId, job.parentRunId);
      this.setOutcome(job, "error", undefined, message, {
        resultSource: "parent",
        terminalReason: "late-recovery-upstream-still-active",
        errorInfo: { category: "timeout", message, suggestedRecovery: guidance.suggestedRecovery },
      });
      job.recovery = undefined;
      pushLog(job, { ts: Date.now(), type: "recovery", text: message });
      this.sessions.set(sessionKey, {
        sessionKey,
        lastJobId: jobId,
        lastSummary: message.slice(0, 500),
        artifacts,
        // NOT deriveNextStep: its `error` answer is "Fix the issue and retry.",
        // which on this one outcome tells the caller to do the exact thing
        // errorInfo tells them not to. Two surfaces of the same job disagreeing
        // about whether to retry is worse than either being silent, so both
        // come from one place — see upstreamStillActiveGuidance.
        recommendedNextStep: guidance.nextStep,
      });
      this.persistActiveJobs();
      logDebug(
        `[job ${jobId}] late-recovery hit the hard cap with upstream still active — error, not a quiet finish`,
      );
      return;
    }

    this.setOutcome(job, "completed_no_summary", NO_SUMMARY_SENTINEL, undefined, {
      resultSource: "parent",
      terminalReason: "late-recovery-exhausted",
    });
    job.recovery = undefined;
    this.sessions.set(sessionKey, {
      sessionKey,
      lastJobId: jobId,
      lastSummary: NO_SUMMARY_SENTINEL.slice(0, 500),
      artifacts,
      recommendedNextStep: deriveNextStep(artifacts, job.status),
    });
    this.persistActiveJobs();
    logDebug(
      `[job ${jobId}] late-recovery exhausted (idle-timeout=${window.idleTimeoutMs / 1000}s, ` +
        `hard-cap=${window.hardCapMs / 1000}s, extensions=${extensions}) — completed_no_summary`,
    );
  }

  /**
   * The one place a job's terminal outcome is written. Every write bumps
   * `outcomeVersion`, which is what lets an in-flight transcript read tell
   * afterwards that it was superseded — including by a write of IDENTICAL
   * text, which comparing the values before and after cannot detect.
   *
   * Route every status/summary assignment through here. The invariant is
   * "an outcome write is a version bump"; enforcing it by construction is why
   * this exists rather than a comment asking future callers to remember.
   *
   * `meta.resultSource`/`meta.terminalReason` follow the same one-writer
   * discipline even though the structural tripwire test (see
   * completion-reconciliation.test.ts) only regex-checks status/summary/
   * error/errorInfo — every terminal write in this file passes them
   * explicitly rather than leaving them to a prior call's stale value.
   */
  private setOutcome(
    job: Job,
    status: JobStatus,
    summary: string | undefined,
    error?: string,
    meta?: { resultSource?: ResultSource; terminalReason?: string; errorInfo?: ErrorInfo },
  ): void {
    job.status = status;
    job.summary = summary;
    job.error = error;
    // classifyError pattern-matches the message, which is the right default for
    // an error whose text came from somewhere else (a provider, an RPC). A
    // caller that KNOWS the failure mode — and therefore knows the one action
    // that actually helps — passes the classification instead of hoping the
    // regexes infer it. Still written here, so the one-writer invariant holds.
    job.errorInfo = error === undefined ? undefined : (meta?.errorInfo ?? classifyError(error));
    job.outcomeVersion = (job.outcomeVersion ?? 0) + 1;
    job.resultSource = meta?.resultSource;
    job.terminalReason = meta?.terminalReason;
  }

  /**
   * Lazy transcript re-check for a terminal job. Called from waitForJob for a
   * job in a non-running, non-success terminal state (completed_no_summary /
   * error) OR one whose success was merely inferred by reconciliation and is
   * still marked provisional. Reads chat.history for the sessionKey with a
   * brief stability window — if a substantial trailing-assistant text now
   * exists that wasn't there when we originally marked the job terminal,
   * upgrade the job to completed.
   *
   * A read that returns exactly what the job already has heals nothing and
   * leaves it provisional, so it keeps being re-read; only a changed text or
   * a genuine status upgrade retires it.
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
    // One read at a time. A read can outlive the cooldown that is meant to
    // space reads apart — its own budget is attempts*intervalMs (12s here) but
    // that is only checked BETWEEN attempts, so a single slow chat.history (20s
    // RPC timeout) overruns it, ~32s worst case against a 20s cooldown. Two
    // reads in flight then race to write the outcome, and every ordering
    // question that follows from that ("which started first?", "what if the
    // newer one comes back empty?") simply does not arise if there is only
    // ever one. Cheaper to forbid the overlap than to arbitrate it.
    if (job.recheckInFlight) return;
    const RECHECK_COOLDOWN_MS = 20_000;
    const last = job.lastRecheckAt ?? 0;
    if (Date.now() - last < RECHECK_COOLDOWN_MS) return;
    job.lastRecheckAt = Date.now();
    // The run's own live final can still land while this read is out. Capture
    // the outcome version rather than the summary text: a version bump catches
    // a superseding write even when it happens to carry identical text, and it
    // does NOT fire when chat() settles carrying nothing to supersede with (a
    // reject, or the no-summary sentinel), which writes no outcome at all.
    const outcomeAtStart = job.outcomeVersion ?? 0;
    job.recheckInFlight = true;
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
    } finally {
      // In `finally` so a throw cannot strand the flag and wedge the job out
      // of ever being re-read again.
      job.recheckInFlight = false;
    }
    if (!recovered) {
      // Recovery order tier 3, revisited on every subsequent poll: the
      // parent transcript still has nothing. Only meaningful when the job is
      // ALREADY sitting at completed_no_summary — a job that's "completed"
      // with a provisional attached-session result already has the best answer this
      // path can produce, and an "error" job's chat() genuinely rejected,
      // which is a different failure mode entirely. Never runs while the
      // job is `running` — that path is recoverLateFinalText's, not this
      // lazy re-check's.
      if (job.status === "completed_no_summary") {
        const attached = await this.tryAttachedSessionRecovery(job);
        if (!attached) {
          // tryAttachedSessionRecovery refuses a blocked delegation outright, and this
          // poll may be the first read that DISCOVERED the block — the turn
          // was already terminal by then, still carrying the ordinary
          // "nothing to report" outcome. Relabel it so every surface that
          // reads the job (not just the ones that read the attachment) tells
          // the two apart. Same status, same ownership/version guards as the
          // recovery branch below, and idempotent: a job already labelled
          // blocked is left alone.
          const blocked = this.blockedDelegation(job);
          const notice = describeBlockedAgentSession(blocked);
          if (
            blocked &&
            notice &&
            !isDelegateBlockedTerminalReason(job.terminalReason) &&
            this.latestJobBySession.get(job.sessionKey) === job.jobId &&
            (job.outcomeVersion ?? 0) === outcomeAtStart
          ) {
            job.lastEventAt = Date.now();
            this.setOutcome(job, "completed_no_summary", notice, undefined, {
              resultSource: "parent",
              terminalReason: delegateBlockedTerminalReason(blocked.status as AgentSessionState),
            });
            pushLog(job, { ts: Date.now(), type: "recovery", text: notice });
            logDebug(
              `[job ${job.jobId}] lazy-recheck: delegate is ${blocked.status} — turn is blocked, not finished`,
            );
          }
          return;
        }
        if (
          this.latestJobBySession.get(job.sessionKey) === job.jobId &&
          (job.outcomeVersion ?? 0) === outcomeAtStart
        ) {
          this.provisionalOutcomes.add(job.jobId);
          job.lastEventAt = Date.now();
          this.setOutcome(job, "completed", attached.summary, undefined, {
            resultSource: attached.resultSource,
            terminalReason: `${attached.resultSource}-recovery`,
          });
          extractPatternsFromSummary(job.artifacts, attached.summary);
          pushLog(job, {
            ts: Date.now(),
            type: "recovery",
            text: `Recovered the final response from the attached agent session (${attached.attachmentId.slice(0, 8)}) after a lazy parent-transcript recheck found nothing`,
          });
          this.sessions.set(job.sessionKey, {
            sessionKey: job.sessionKey,
            lastJobId: job.jobId,
            lastSummary: attached.summary.slice(0, 500),
            artifacts: job.artifacts,
            recommendedNextStep: deriveNextStep(job.artifacts, "completed"),
          });
          logDebug(
            `[job ${job.jobId}] lazy-recheck: recovered via the attached session (${attached.summary.length} chars)`,
          );
        }
      }
      return;
    }
    // The poll above takes seconds, so re-check ownership: a new job may have
    // claimed the session while it ran.
    if (this.latestJobBySession.get(job.sessionKey) !== job.jobId) return;
    // Superseded while reading. Writing over the live final would be
    // PERMANENT: chat() settling retires the provisional flag, so nothing
    // replaces the summary again and no later poll re-reads it.
    if ((job.outcomeVersion ?? 0) !== outcomeAtStart) {
      logDebug(
        `[job ${job.jobId}] lazy-recheck superseded while reading — discarding the stale read`,
      );
      return;
    }
    // Did this read actually heal anything? Either it brought text the job
    // did not have, or it moved a non-success terminal status to completed.
    // Re-reading the SAME text off a still-frozen transcript is NOT
    // confirmation — it is the same inference a second time, and a frozen
    // transcript is exactly the condition under which that inference was
    // unsafe to begin with. Such a job stays provisional so later polls
    // keep re-reading it.
    // Stops the re-read loop only. The outcome stays provisional: a
    // transcript read is another inference, and the live final — when it
    // eventually arrives — is the run's own terminal text and outranks it.
    const healed = recovered !== job.summary || job.status !== "completed";
    if (healed) this.recheckSettled.add(job.jobId);
    job.lastEventAt = Date.now();
    // A real parent-transcript read always wins over a provisional attached-session
    // result, so resultSource is reset to "parent" here unconditionally —
    // same rule as the live-final-late branch in submitTask.
    this.setOutcome(job, "completed", recovered, undefined, {
      resultSource: "parent",
      terminalReason: "lazy-recheck-transcript",
    });
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
    const agentSession = this.getAgentSessionAttachment(job.sessionKey);
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
      liveness: job.liveness,
      pollCount: job.pollCount,
      continuePolling,
      // A wait-mode check_task call already blocked for its full window
      // before returning, so it's normally safe to call again immediately —
      // except during late-recovery, where the transcript is only re-read
      // every ~10s server-side (see recoverLateFinalText below), so hammering
      // check_task faster than that just burns round-trips for no new info.
      retryAfterMs: continuePolling ? (job.recovery ? 10_000 : 0) : 0,
      nextAction: buildNextAction(job),
      resultSource: job.resultSource,
      terminalReason: job.terminalReason,
      // The upstream run this turn dispatched. Absent until chat.send answers,
      // and on a job reloaded from a store written before it existed. Exposed
      // because a diagnostic that names no run cannot be checked against
      // anything: this is the id that correlates a ClawConnect job to what
      // openclaw is actually executing. See Job.parentRunId.
      ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}),
      ...(continuation ? { continuationState: continuation } : {}),
      // Unconditional, like `recovery` above — the owning host needs to see the
      // session's current attachment on every turn to decide continue vs.
      // replace vs. detach, not just under a detail preset.
      ...(agentSession ? { agentSession } : {}),
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
    signal?: AbortSignal,
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
      // Provisional outcomes are included: a reconciled `completed` was
      // inferred from a transcript read, not from a terminal event, so it
      // stays eligible for re-reading until a poll confirms it.
      if (
        job.status === "completed_no_summary" ||
        job.status === "error" ||
        (this.provisionalOutcomes.has(job.jobId) && !this.recheckSettled.has(job.jobId))
      ) {
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
    while (Date.now() < deadline && job.status === "running" && !signal?.aborted) {
      await waitForPollInterval(signal);
      if (signal?.aborted) break;
      // In "poll" mode: return early on new logs (live progress for widgets)
      // In "wait" mode: only return on terminal state or timeout (fewer round-trips for agentic use)
      if (mode === "poll" && job.logs.length > knownLogCount) {
        const freshEntries = job.logs.slice(knownLogCount);
        const hasLifecycleTransition = freshEntries.some(
          (e) => e.type === "lifecycle" || e.type === "recovery",
        );
        if (hasLifecycleTransition) {
          logDebug(
            `[waitForJob] job ${job.jobId.slice(0, 8)} lifecycle activity — waking immediately`,
          );
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
      `[waitForJob] job ${job.jobId.slice(0, 8)} ${signal?.aborted ? "request aborted" : `${mode} timeout`} (logs=${job.logs.length}, status=${job.status})`,
    );
    return job;
  }
}
