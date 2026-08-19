import type {
  AgentSessionError,
  AgentSessionProviderId,
  AgentSessionRuntimeId,
  AgentSessionState,
  AgentSessionTermination,
  BlockedDelegation,
} from "./agent-session.ts";

// ── Event types from the gateway ──────────────���──────────────────────────────

/**
 * `assistant` carries what the agent actually SAID, and exists because a card
 * that can only render lifecycle notices and tool rows goes blank for minutes
 * during any stretch of reasoning or prose — which is indistinguishable from a
 * stalled run. It is emitted at message boundaries from the durable transcript,
 * never from the live cumulative delta: a delta is the whole reply so far and
 * re-emitting it per frame would append a growing near-duplicate every time.
 */
export type GatewayEvent =
  | { type: "lifecycle"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; text: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; text: string; toolName: string; isError: boolean };

// ── Artifacts ───────────────────────���───────────────────────────��────────────

/**
 * How an inferred identifier was obtained. `"command"` means it was read off a
 * command the agent actually ran; `"summary-text"` means it was scraped from
 * free-form prose, which is a guess about what the prose meant and must not be
 * presented as established fact.
 */
export type ArtifactProvenance = "summary-text" | "command";

export type Artifacts = {
  filesChanged: string[];
  commandsRun: string[];
  branchName?: string;
  commitSha?: string;
  prUrl?: string;
  needsHumanDecision: boolean;
  /**
   * How each inferred identifier was obtained. An identifier present without a
   * provenance entry is a bug; an absent identifier makes no claim at all.
   * Optional so job records persisted before this field existed deserialize
   * unchanged.
   */
  provenance?: Partial<Record<"commitSha" | "branchName" | "prUrl", ArtifactProvenance>>;
};

// ── Errors ─��───────────────────────────────────────────��─────────────────────

export type ErrorCategory =
  | "auth"
  | "timeout"
  | "merge_conflict"
  | "test_failure"
  | "tooling"
  | "unknown";

export type ErrorInfo = {
  category: ErrorCategory;
  message: string;
  suggestedRecovery: string;
};

// ── Jobs & Sessions ────────��──────────────────────────��─────────────────────

/**
 * `seq` is a 1-based, monotonically increasing, per-job event id — the
 * explicit cursor unit for the log-projection window (see
 * log-projection.ts). It happens to equal the entry's position in
 * `Job.logs` today (append-only, never trimmed from the front), but callers
 * must treat it as an opaque cursor, not an array index: that's what lets
 * storage strategy change later without moving the client contract. Absent
 * only on entries constructed before this field existed (defensive; every
 * current write path stamps it).
 */
export type LogEntry = { ts: number; type: string; text: string; isError?: boolean; seq?: number };

/**
 * `cancelled` is a distinct TERMINAL state, not a flavour of error. Sending
 * "stop" into a busy OpenClaw session genuinely aborts the run upstream (the
 * gateway answers state:"aborted", see gateway.ts) — verified twice against a
 * live agent. That arrives on the same rejection path as a real failure, so
 * without its own status every cancellation a user asked for would be
 * reported back to them as something that went wrong.
 *
 * Deriving the rest for free is the reason it lives on JobStatus rather than
 * being faked further up: `isTerminal` is `status !== "running"` and
 * `isError` is `status === "error"`, so a cancelled job is correctly terminal
 * and correctly not an error without either check being touched.
 */
export type JobStatus = "running" | "completed" | "completed_no_summary" | "error" | "cancelled";
export type TaskStatus = "queued" | "running" | "blocked" | "needs-human" | "done" | "failed" | "cancelled";

/** Independent lifecycle axes exposed to callers. */
export type TaskExecutionState = "running" | "completed" | "failed" | "cancelled";
export type TaskUpstreamState = "connected" | "reconnecting" | "unavailable";
export type TaskTranscriptState = "live" | "replaying" | "detached" | "complete";
export type TaskCancellationState = "none" | "requested" | "acknowledged" | "reconciled";

/** Transport observation emitted by the resumable OpenClaw transcript reader. */
export type TranscriptTransportUpdate = {
  upstream: TaskUpstreamState;
  transcript: TaskTranscriptState;
  lastSeenSequence?: number;
};

/**
 * Where a job's terminal summary text actually came from. Absent (undefined)
 * on every pre-existing terminal path — including the ordinary live-final and
 * transcript-reconciliation paths that predate this field — and reads as the
 * implicit historical default "parent".
 *
 *   agent-session — a registered runtime answered through the neutral
 *                   callback seam (agent-session.ts), from the recovery
 *                   fallback in session.ts and only once the parent's own
 *                   live+transcript recovery has given up.
 *
 * There is deliberately no value naming a PARTICULAR runtime's provenance.
 * How strongly a runtime can vouch for the text it returns is the runtime's
 * own claim, made inside its module and enforced by the gate it chooses to
 * apply before reporting a completed turn at all; ClawConnect cannot verify
 * that claim and so does not restate it. The record already names which
 * runtime answered — see AgentSessionAttachment.runtime, carried on the same
 * snapshot — which is a more precise answer than a fixed enum here could be.
 */
export type ResultSource = "parent" | "agent-session";

// ── Managed agent-session attachment ──────────────────────────────────────

/**
 * The substates a directive may report the host observing directly, and the only
 * ones a record's `status` may hold: the neutral AgentSessionState vocabulary
 * minus the two values that describe a READ rather than a session
 * ("unavailable", "unknown"). The host supervises the managed session and knows
 * things — e.g. "it's asking me something" — that ClawConnect's own
 * tmux-liveness-only adapter cannot determine on its own; "we could not reach
 * the runtime" is never one of them, and lives on `error` instead.
 *
 * Deliberately excludes "superseded"/"detached" too: those are lineage states
 * only session.ts's own replace/detach transitions may set, never a directive
 * directly — see AgentSessionDirective.
 *
 * One record serves every runtime: a pane-based one (terminal success
 * "idle") and a service-style one (terminal success "completed") share this
 * type rather than each getting a model of its own.
 */
export type AttachmentLiveStatus = Exclude<AgentSessionState, "unavailable" | "unknown">;

/**
 * One conversation may have at most one CURRENT managed-session
 * attachment at a time, but every attachment it has ever had is kept (see
 * SessionAttachmentState) — `id` is ClawConnect's own identifier for this record,
 * distinct from `handle` (the session's own id in its runtime's namespace), so
 * replacement lineage can chain through `replacesAttachmentId` even if a
 * handle were ever reused.
 *
 * Fields below the lineage block are the NORMALIZED runtime observation (see
 * agent-session.ts): everything a runtime told us about the session, in one
 * vocabulary, written only through the guarded write-back in session.ts.
 */
export type AgentSessionAttachment = {
  id: string;
  /**
   * Which system owns this session's lifecycle — a host-registered runtime
   * id. ClawConnect has no default and no built-in value here: an id it does
   * not recognise reads back as a normalized `unknown_runtime` result, never
   * an error.
   */
  runtime: AgentSessionRuntimeId;
  /** Which agent/model runs inside the session, when the runtime reports it. */
  provider?: AgentSessionProviderId;
  /** The session's id in its runtime's namespace. Called `handle` because that is the name production already publishes. */
  handle: string;
  providerSessionId?: string;
  /**
   * Host whose runtime state owns this session. Optional: a service runtime's
   * session lives on a server, not on a machine ClawConnect can name, and the
   * neutral marker may legitimately omit it. The explicit
   * `[[clawconnect:agent-session]]` directive still requires one.
   */
  host?: string;
  worktree?: string;
  remoteUrl?: string;
  attachedAt: number;
  lastObservedAt?: number;
  status: AttachmentLiveStatus | "superseded" | "detached";
  /** Set only on a record created by an explicit `replace` transition. */
  replacesAttachmentId?: string;
  /**
   * Correlates this attachment to ONE specific parent turn (a jobId) —
   * stamped by session.ts whenever an attach/replace/continue directive
   * rides in on a real (non-busy-rejected) submitTask call. A Fleet-transcript
   * recovery is only ever trusted for the turn that currently owns this id:
   * without it, an attachment left current from an earlier delegated turn
   * could answer a LATER, unrelated task that never actually used it. Never
   * set by "inspect" (a passive read-refresh, not a new delegation claim).
   */
  delegatedTurnId?: string;
  /** Set only when status is "detached" or "superseded" — why it stopped being current. */
  reason?: string;
  /**
   * Best-effort FINAL result observed from the attached session — populated
   * only from a genuinely completed turn (see COMPLETED_TURN_STATES in
   * agent-session.ts), never from a partial answer a running or blocked
   * session happened to have written. `summary` is capped (see
   * ATTACHMENT_RESULT_SUMMARY_MAX in session.ts) — `outputRef` is the durable
   * pointer (transcript path / session key) so the full text is always
   * re-derivable rather than duplicated unbounded here.
   */
  lastResult?: {
    summary?: string;
    outputRef?: string;
    observedAt: number;
  };
  /**
   * The most recent assistant text the runtime reported, in ANY state —
   * capped the same way. Distinct from `lastResult` on purpose: this is what
   * the session is saying now, which is exactly the thing that must never be
   * mistaken for the turn's answer.
   */
  latestResponse?: string;
  /** Liveness as the runtime last reported it. undefined when it could not say — different from `false`. */
  alive?: boolean;
  /** Session creation time as the runtime reports it (epoch ms) — not `attachedAt`, which is when ClawConnect first saw it. */
  startedAt?: number;
  /** Most recent activity the runtime knows about (epoch ms). */
  lastEventAt?: number;
  /**
   * The last failure of a READ, not of the session (see AgentSessionError):
   * "we could not reach the runtime" must never be stored as a session state.
   * Cleared by the next read that actually reaches the runtime.
   */
  error?: AgentSessionError;
  /** Why the session stopped, for the terminal states only. */
  termination?: AgentSessionTermination;
  /** Runtime-specific extras carried through untouched from the marker and every observation. Strings only. */
  metadata?: Record<string, string>;
  /**
   * Monotonic token of the newest runtime observation already written to this
   * record. Every dispatch takes a token BEFORE it calls out, and its result
   * is written back only if no higher-token observation has landed meanwhile —
   * so a slow inspect that resolves after a later one cannot roll the record
   * back to what it saw. The attachment-identity and delegated-turn checks
   * guard a different axis (a different attachment / a different parent turn);
   * this one guards two reads of the SAME attachment on the same turn.
   */
  observationToken?: number;
};

/**
 * Session-scoped, not job-scoped: survives across every job submitted on the
 * same sessionKey. `attachments` never drops a record — replacement and
 * detachment both leave their prior record in place with an updated status,
 * so the full lineage is always readable.
 */
export type SessionAttachmentState = {
  sessionKey: string;
  /** undefined when nothing is currently attached (never attached, or detached). */
  currentAttachmentId?: string;
  attachments: Record<string, AgentSessionAttachment>;
};

/**
 * Structured directive the owning host embeds in TaskInput.context to drive an
 * explicit attachment transition — parsed and stripped by session-handoff.ts
 * before the message reaches the agent. See docs/architecture/2026-08-02-
 * managed-fleet-attachment-plan.md §4; this is deliberately not a new public
 * MCP tool.
 */
export type AgentSessionDirective =
  | {
      op: "attach" | "replace";
      /** Required: ClawConnect has no built-in runtime to fall back to. Matches the neutral marker, which has always required it. */
      runtime: AgentSessionRuntimeId;
      provider?: AgentSessionProviderId;
      handle: string;
      providerSessionId?: string;
      host?: string;
      worktree?: string;
      remoteUrl?: string;
      metadata?: Record<string, string>;
      /** Required for "replace"; ignored for "attach". */
      reason?: string;
      status?: AttachmentLiveStatus;
    }
  | {
      op: "continue";
      status?: AttachmentLiveStatus;
      /**
       * When present, the follow-up turn to deliver to the attached session
       * through its runtime's `continue` callback. Omit for the historical
       * meaning: re-affirm that this parent turn is delegated to the current
       * attachment, without driving the runtime at all.
       */
      prompt?: string;
    }
  | {
      op: "detach";
      reason: string;
      /**
       * Whether to also stop the session in its runtime, not just stop
       * tracking it here. Defaults to false because ending someone else's
       * agent session is not recoverable and "detach" has always meant the
       * local, reversible thing — a caller that wants the session killed has
       * to say so.
       */
      stopRuntime?: boolean;
    }
  | { op: "inspect"; status?: AttachmentLiveStatus };

/**
 * What upstream last told us about whether this run is still executing — the
 * difference between "working quietly" and "stalled".
 *
 * A caller cannot derive this from `lastEventAt` alone. A coding agent inside
 * a long shell command or a compaction pass legitimately emits nothing for
 * minutes, and stillness looks identical to death from the outside. This is
 * the evidence that separates them, and it is deliberately NOT a self-report:
 * a heartbeat emitted by the same process that is wedged proves nothing, so
 * `upstream` comes from openclaw's own run registry (see classifyUpstreamRun)
 * and `producing` from the transcript advancing between reads.
 *
 * Written by the two places that read upstream on a job's behalf: a quiet
 * reconcile round (only after RECONCILE_QUIET_MS of live silence), and the
 * late-recovery transcript watch (every read, ~10s, for as long as it runs).
 * Both write only from a read that actually REACHED upstream, so `checkedAt`
 * dates the evidence rather than the attempt — a stretch of failed reads ages
 * this out instead of refreshing it.
 *
 * Absence means "nothing has had cause to look yet", never "checked and found
 * dead" — a consumer must not read undefined as bad news. For the same reason
 * `upstream: "unknown"` is the absence of positive evidence, never evidence of
 * the opposite. And `checkedAt` matters: this is a statement about the moment
 * it was made, so a consumer that acts on it should age it out (the widget
 * does, at 5 minutes).
 */
export type JobLiveness = {
  /** When the check ran — i.e. how old this evidence is. Only ever a read that reached upstream. */
  checkedAt: number;
  /** Positive evidence execution is ongoing, as of `checkedAt`. `unknown` is not the converse. */
  upstream: "active" | "unknown";
  /** The transcript advanced since the previous read. */
  producing: boolean;
};

export type JobRecoveryState = {
  /**
   * "no_live_final_text" — chat() settled without visible final text.
   * "parent_observation_timeout" — chat()'s own wait window elapsed while the
   * run was, as far as anyone knows, still executing upstream. Both reasons
   * drive the same durable transcript recovery; they differ only in what the
   * caller is told about why the parent stopped watching.
   */
  reason: "no_live_final_text" | "parent_observation_timeout";
  startedAt: number;
  idleTimeoutMs: number;
  hardCapMs: number;
};

/**
 * chat()'s wait window elapsed before any terminal event arrived. Distinct
 * from every other chat() rejection because it says nothing about the run:
 * error/aborted/RPC/connection failures are upstream verdicts, this one is
 * only the parent giving up on watching. session.ts routes it into transcript
 * recovery instead of a terminal error.
 *
 * Lives here for the same reason NO_SUMMARY_SENTINEL does: gateway.ts throws
 * it and session.ts tests for it, and gateway.ts is mocked wholesale by
 * several test files, so a definition either side could drift from would
 * silently break the comparison.
 */
export class ParentObservationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("OpenClaw task timed out");
    this.name = "ParentObservationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * `instanceof` alone would miss an error crossing a module-instance boundary
 * (two copies of this module in one process, structured-cloned rejections),
 * and the class carries a stable `name` precisely so the check can fall back
 * to it. Deliberately does NOT sniff the message: "OpenClaw handshake
 * timeout" and "RPC timeout: chat.send" are genuine failures that must stay
 * terminal.
 */
export function isParentObservationTimeout(err: unknown): boolean {
  if (err instanceof ParentObservationTimeoutError) return true;
  return err instanceof Error && err.name === "ParentObservationTimeoutError";
}

/**
 * What `chat()` resolves with when a run ended without producing visible text,
 * and the summary such a job carries. Lives here — not in gateway.ts, which
 * produces it, nor session.ts, which tests for it — because two copies would
 * let a change on one side silently break the comparison on the other, and
 * because gateway.ts is mocked wholesale by several test files.
 */
export const NO_SUMMARY_SENTINEL = "Stream finished with no response collected.";

/**
 * The original submitted task, stored so it can be retrieved later (e.g. for
 * diagnostics or "what did I actually ask for" recall). Deliberately never
 * included in JobSnapshot / telemetry — only exposed through the dedicated
 * getTaskPrompt() read path (get_task detail="prompt"), gated by the same
 * per-agent scope authorization as every other field.
 */
export type JobPrompt = {
  task: string;
  context?: string;
  senderName?: string;
};

export type Job = {
  jobId: string;
  sessionKey: string;
  status: JobStatus;
  summary?: string;
  error?: string;
  errorInfo?: ErrorInfo;
  startedAt: number;
  lastEventAt: number;
  logs: LogEntry[];
  artifacts: Artifacts;
  recovery?: JobRecoveryState;
  upstreamState: TaskUpstreamState;
  transcriptState: TaskTranscriptState;
  cancellationState: TaskCancellationState;
  /** Durable OpenClaw transcript cursor, independent of check_task's presentation cursor. */
  lastSeenSequence?: number;
  /** Last upstream liveness check. Unset until something has had cause to look — see JobLiveness. */
  liveness?: JobLiveness;
  /** Timestamp of the most recent lazy-transcript-recheck for a terminal job
   *  (completed_no_summary / error). Used to rate-limit re-reads so a poll
   *  storm doesn't hammer chat.history. Unset until the first recheck. */
  lastRecheckAt?: number;
  /** True while a lazy transcript recheck is awaiting its read. Only one runs
   *  at a time: a read can outlive the cooldown that spaces reads apart, and
   *  two in flight at once race to write the outcome. */
  recheckInFlight?: boolean;
  /** Bumped by SessionManager.setOutcome on every write to status/summary.
   *  An in-flight transcript read captures it and re-checks afterwards, so it
   *  can tell it was superseded — including by a write of identical text,
   *  which comparing the values cannot detect. */
  outcomeVersion?: number;
  /** Number of times waitForJob has been called for this job (check_task calls). */
  pollCount: number;
  /** The original submitted task/context/senderName. See JobPrompt. */
  prompt: JobPrompt;
  /**
   * OpenClaw's handle for this job's run, persisted the moment chat.send's
   * onRunId fires — unlike the in-memory-only upstreamRunIds map this
   * survives a restart, so a reloaded job still knows which upstream run it
   * corresponds to.
   */
  parentRunId?: string;
  /**
   * Where this job's opaque run_task payload was materialised, if it had one
   * (see payload-store.ts). The PATH only — the contents are never read back
   * by ClawConnect and are returned by no tool. Recorded so a supervisor can
   * see that a payload existed and where it went.
   */
  payloadPath?: string;
  /** See ResultSource. Written only by setOutcome. */
  resultSource?: ResultSource;
  /** Short diagnostic code for why the job went terminal. Written only by setOutcome. */
  terminalReason?: string;
};

/**
 * Exact next call a caller should make — `args` keys are literally
 * check_task's parameter names, so the object can be passed straight through
 * without renaming anything. That's why the identifier here is `jobId` (what
 * check_task accepts) and not the `taskId` alias that run_task/get_task carry
 * at the top level.
 *
 * `null` once the job is terminal — there's nothing left to poll. A hint
 * derived from current status, not a guarantee: the job can still transition
 * (e.g. late-recovery upgrade) between when this is computed and when the
 * caller acts on it.
 */
export type NextAction = { tool: "check_task"; args: { jobId: string; sessionKey: string } } | null;

export type JobSnapshot = {
  jobId: string;
  sessionKey: string;
  status: JobStatus;
  execution: TaskExecutionState;
  upstream: TaskUpstreamState;
  transcript: TaskTranscriptState;
  cancellation: TaskCancellationState;
  lastSeenSequence?: number;
  startedAt: number;
  lastEventAt: number;
  lastPollAt: number;
  summary?: string;
  error?: string;
  errorInfo?: ErrorInfo;
  /**
   * A BOUNDED PROJECTION, not the full accumulated history — at most 8
   * entries when the caller passed no cursor (or 0), at most 5 when it
   * passed a cursor with new activity beyond it. Consecutive tool/tool-result
   * pairs may be collapsed and entry text is truncated (see log-projection.ts).
   * The server retains the full history internally; nothing here ever
   * reflects that history's true size — read `logEventCount` for that.
   */
  logs: LogEntry[];
  artifacts: Artifacts;
  recovery?: JobRecoveryState;
  /**
   * Evidence about whether a quiet run is still executing. Read this before
   * telling anyone a task looks stuck — `lastEventAt` alone cannot tell
   * "working silently" from "dead", and this is what separates them.
   */
  liveness?: JobLiveness;
  continuationState?: ContinuationState;
  resultSource?: ResultSource;
  terminalReason?: string;
  /**
   * OpenClaw's id for the run this turn dispatched (see Job.parentRunId).
   * Absent until chat.send has answered. Present so a caller — or a human
   * reading a failure — can correlate this job with what upstream is actually
   * executing, rather than being told a run misbehaved without being told
   * which one.
   */
  parentRunId?: string;
  /** The session's CURRENT managed-session attachment, if any — not the full lineage. See AgentSessionAttachment. */
  agentSession?: AgentSessionAttachment;
  /** Where this job's opaque payload was written, if it had one. Path only — see Job.payloadPath. */
  payloadPath?: string;
  /**
   * OPAQUE cursor. Pass it back verbatim as the next call's `knownLogCount`
   * to resume exactly where this snapshot left off — never a duplicate,
   * possibly a gap (see `logs`' bounding above; the gap is intentional:
   * cosmetic activity, not the terminal summary/artifacts, which are always
   * delivered in full regardless of cursor). Never derive it by counting
   * `logs` or by accumulating returned entries — `logs` is a bounded
   * projection and its length has no fixed relationship to this value. 0
   * when the job has no logged events yet.
   */
  logCursor: number;
  /** Total events ever recorded for this job server-side — the full,
   *  uncapped authoritative count (Job.logs is never trimmed) — for
   *  telemetry/UI awareness of how much was omitted from the bounded `logs`
   *  projection above. */
  logEventCount: number;
  /** ClawConnect agent alias this job ran against. Present from multi-agent gateway onward. */
  agent?: string;
  /** Number of check_task waits served for this job so far. */
  pollCount: number;
  /** True while status is "running" — the caller should call check_task again. False at any terminal status. */
  continuePolling: boolean;
  /** Suggested delay, in ms, before the next check_task call. 0 when a wait-mode call already blocked for its full window (safe to call again immediately) or when the job is terminal; nonzero during late-recovery, where the transcript is only re-read periodically server-side. */
  retryAfterMs: number;
  /** The exact next call to make, or null once terminal. See NextAction. */
  nextAction: NextAction;
};

export type ContinuationState = {
  sessionKey: string;
  lastJobId: string;
  lastSummary: string;
  artifacts: Artifacts;
  recommendedNextStep?: string;
  /** ClawConnect agent alias this session belongs to. */
  agent?: string;
};

export type TaskInput = {
  task: string;
  context?: string;
  /**
   * Opaque blob that is NOT addressed to the agent. Materialised to a file
   * whose path — and only whose path — reaches the agent; the bytes never
   * enter the conversation. Never parsed, interpreted, templated, or
   * truncated. See payload-store.ts for what problem this exists to solve.
   */
  payload?: string;
  sessionKey?: string;
  /** ClawConnect agent alias. Falls back to the registry default. */
  agent?: string;
  /**
   * Name of the human on whose behalf this task is dispatched. On a shared
   * connection (one ChatGPT account, one connector, many people) this is the
   * only way the receiving agent knows who it's helping. When set, it's
   * prepended to the message the agent receives.
   */
  senderName?: string;
};

// ── Gateway config ─────────────���────────────────────────────────────────────

export type GatewayConfig = {
  url: string;
  token: string;
  agentId?: string;
};

// ── Tool handler types ────────────────────────────────────────────────────

export type CheckMode = "poll" | "wait";

export type RunTaskResult = {
  jobId: string;
  taskId?: string;
  sessionKey: string;
  status: "running";
  execution: TaskExecutionState;
  upstream: TaskUpstreamState;
  transcript: TaskTranscriptState;
  cancellation: TaskCancellationState;
  /** ClawConnect agent alias the task was dispatched to. */
  agent?: string;
  /**
   * Where this task's opaque payload was materialised, when one was passed.
   * Absent otherwise — its PRESENCE is the confirmation that the payload
   * landed. The caller that just handed over the bytes has the strongest
   * claim to the path, and making it call a second tool to learn where its
   * own data went is the interpretation burden this channel exists to remove.
   * Path only; the contents are returned by no tool. See payload-store.ts.
   */
  payloadPath?: string;
  /** Exact next call to make to collect the result. Always non-null immediately after run_task. */
  nextAction: NextAction;
};

/**
 * The manager-level row shape returned by list_tasks and
 * get_session(mode:"tasks"). `summary` here is a bounded PREVIEW, not the
 * task's full response — a listing across every agent and session would
 * otherwise carry every agent's full answer in one payload. get_task is the
 * read path that returns the complete summary.
 */
export type TaskSummary = {
  taskId: string;
  jobId: string;
  sessionKey: string;
  agent?: string;
  status: TaskStatus;
  startedAt: number;
  lastEventAt: number;
  /**
   * Evidence about a quiet run, carried on the ROW so a listing can label it
   * honestly without a per-row get_task — the fan-out this type exists to
   * avoid. Unset until something has had cause to look; read `checkedAt`
   * before trusting it, since it dates the evidence. See JobLiveness.
   */
  liveness?: JobLiveness;
  /** Bounded preview (see TASK_SUMMARY_PREVIEW_MAX). Use get_task for the full text. */
  summary?: string;
  /** True when `summary` was cut short — the full text is available from get_task. */
  summaryTruncated?: boolean;
  error?: string;
  /**
   * Set ONLY when this row's turn is waiting on a human in the session it
   * delegated to. `status` is already "needs-human" in that case; this carries
   * the metadata a caller needs to go answer it (which runtime, which handle,
   * which kind of block, where to open it) without a second round trip. Its
   * `notice` is bounded like `summary` is (see TASK_BLOCKED_NOTICE_MAX) — a
   * listing must not grow without limit per row.
   */
  blockedDelegation?: BlockedDelegation;
};

export type SessionInspectMode = "snapshot" | "events" | "tail" | "tasks";

export type SessionInspectResult =
  | { found: false }
  | {
      found: true;
      sessionKey: string;
      agent?: string;
      jobId: string;
      status: JobStatus;
      startedAt: number;
      lastEventAt: number;
      summary?: string;
      error?: string;
      events?: LogEntry[];
      nextAfter?: number;
      /** mode="tasks": every job ever submitted under this session, newest first. Plain core surface — not UI-specific. */
      tasks?: TaskSummary[];
      /** The session's CURRENT managed-session attachment, if any — not the full lineage. */
      agentSession?: AgentSessionAttachment;
    };

export type CheckTaskOpts = {
  jobId?: string;
  sessionKey?: string;
  /**
   * Log cursor — the `logCursor` a previous check_task/get_task snapshot
   * returned, passed back UNCHANGED, to receive only events after it. It is
   * opaque: never compute it from how many entries the last response
   * contained, and never accumulate a running total client-side. Omit or
   * pass 0 for the initial bounded window (see JobSnapshot.logs). In "poll"
   * mode this also gates the early-return wait loop (poll returns as soon as
   * anything newer than this cursor exists).
   *
   * Named `knownLogCount` for wire compatibility with the original contract;
   * the value it carries is `logCursor`.
   */
  knownLogCount?: number;
  mode?: CheckMode;
  /** Optional explicit agent. If omitted, resolved from jobId/sessionKey. */
  agent?: string;
  /**
   * How long a check_task call may block, in ms, before returning a
   * non-terminal snapshot. Omit for the default (45s — see DEFAULT_WAIT_MS
   * in session.ts). Invalid values (negative, NaN, non-finite, too large)
   * clamp to the nearest bound rather than erroring.
   */
  waitMs?: number;
  /** Cancels only this wait when the requesting transport disconnects. */
  signal?: AbortSignal;
};

export type CheckTaskResult =
  | { found: false }
  | {
      found: true;
      snapshot: JobSnapshot;
      isTerminal: boolean;
      isError: boolean;
      /** True whenever isTerminal is false — mirrors snapshot.continuePolling for callers that don't want to unwrap the snapshot. */
      continuePolling: boolean;
    };

/**
 * Result of a prompt-retrieval read (get_task detail="prompt"). Deliberately
 * a distinct type from CheckTaskResult/JobSnapshot so the prompt can never
 * leak into a normal check_task/get_task response by accident — the only
 * function that returns this type is getTaskPrompt().
 */
export type TaskPromptResult = { found: false } | { found: true; prompt: JobPrompt };
