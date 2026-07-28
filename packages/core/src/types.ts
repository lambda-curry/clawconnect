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

export type LogEntry = { ts: number; type: string; text: string };

export type JobStatus = "running" | "completed" | "completed_no_summary" | "error";
export type TaskStatus = "queued" | "running" | "blocked" | "needs-human" | "done" | "failed";

export type JobRecoveryState = {
  reason: "no_live_final_text";
  startedAt: number;
  idleTimeoutMs: number;
  hardCapMs: number;
};

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
  /** Number of times waitForJob has been called for this job (check_task calls). */
  pollCount: number;
  /** The original submitted task/context/senderName. See JobPrompt. */
  prompt: JobPrompt;
};

/**
 * Exact next call a caller should make. `null` once the job is terminal —
 * there's nothing left to poll. A hint derived from current status, not a
 * guarantee: the job can still transition (e.g. late-recovery upgrade)
 * between when this is computed and when the caller acts on it.
 */
export type NextAction = { tool: "check_task"; args: { taskId: string; sessionKey: string } } | null;

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
  logs: LogEntry[];
  artifacts: Artifacts;
  recovery?: JobRecoveryState;
  continuationState?: ContinuationState;
  /** ClawConnect agent alias this job ran against. Present from multi-agent gateway onward. */
  agent?: string;
  /** Number of check_task waits served for this job so far. */
  pollCount: number;
  /** True while status is "running" — the caller should call check_task again. False at any terminal status. */
  continuePolling: boolean;
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

export type TaskSummary = {
  taskId: string;
  jobId: string;
  sessionKey: string;
  agent?: string;
  status: TaskStatus;
  startedAt: number;
  lastEventAt: number;
  summary?: string;
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
