// ── Event types from the gateway ──────────────���──────────────────────────────

export type GatewayEvent =
  | { type: "lifecycle"; text: string }
  | { type: "tool"; text: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; text: string; toolName: string; isError: boolean };

// ── Artifacts ───────────────────────���───────────────────────────��────────────

export type Artifacts = {
  filesChanged: string[];
  commandsRun: string[];
  branchName?: string;
  commitSha?: string;
  prUrl?: string;
  needsHumanDecision: boolean;
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

export type JobStatus = "running" | "completed" | "completed_no_summary" | "error";
export type TaskStatus = "queued" | "running" | "blocked" | "needs-human" | "done" | "failed";

export type JobRecoveryState = {
  reason: "no_live_final_text";
  startedAt: number;
  idleTimeoutMs: number;
  hardCapMs: number;
};

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
  continuationState?: ContinuationState;
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
  /** ClawConnect agent alias the task was dispatched to. */
  agent?: string;
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
  /** Bounded preview (see TASK_SUMMARY_PREVIEW_MAX). Use get_task for the full text. */
  summary?: string;
  /** True when `summary` was cut short — the full text is available from get_task. */
  summaryTruncated?: boolean;
  error?: string;
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
