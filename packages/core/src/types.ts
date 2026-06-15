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
};

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

export type SessionInspectMode = "snapshot" | "events" | "tail";

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
    };

export type CheckTaskOpts = {
  jobId?: string;
  sessionKey?: string;
  knownLogCount?: number;
  mode?: CheckMode;
  /** Optional explicit agent. If omitted, resolved from jobId/sessionKey. */
  agent?: string;
};

export type CheckTaskResult =
  | { found: false }
  | {
      found: true;
      snapshot: JobSnapshot;
      isTerminal: boolean;
      isError: boolean;
    };
