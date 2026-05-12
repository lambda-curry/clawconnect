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
  sessionKey: string;
  status: "running";
  /** ClawConnect agent alias the task was dispatched to. */
  agent?: string;
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
