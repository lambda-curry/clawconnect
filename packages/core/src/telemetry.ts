/**
 * Request-level telemetry for the task-contract tools (run_task/check_task/
 * get_task/list_tasks). Structurally excludes prompt content — TelemetryEvent
 * has no field that could hold task/context/summary/log text, so there is
 * nothing to accidentally forget to redact (contract hard invariant: avoid
 * sensitive prompt logging by default).
 *
 * Default sink writes one JSON line to stderr, matching the existing
 * logDebug convention in session.ts/gateway.ts — never stdout, which would
 * corrupt the stdio JSON-RPC stream.
 */
export type TelemetryEvent = {
  ts: number;
  tool: "run_task" | "check_task" | "get_task" | "list_tasks" | "cancel_task";
  jobId?: string;
  taskId?: string;
  sessionKey?: string;
  agent?: string;
  /** check_task/get_task: Job.pollCount at the time of this call. */
  pollCount?: number;
  /** check_task: the caller-requested waitMs, before clamping. */
  requestedWaitMs?: number;
  /** Returned job/task status (e.g. "running", "completed", "error"). */
  status?: string;
  /** Wall-clock time this tool call took, in ms — for check_task this includes any wait. */
  durationMs: number;
  /** run_task: true when the submission was rejected because the session already had a running job. */
  duplicateJob?: boolean;
  /** check_task/get_task: true when the returned snapshot was a terminal status. */
  terminalRetrieval?: boolean;
  /** list_tasks: number of tasks returned. */
  taskCount?: number;
  /** check_task/get_task: estimated wire size of the returned snapshot, in bytes. Never derived from prompt/log/summary content beyond its length. */
  payloadBytes?: number;
  /** check_task/get_task: number of log entries in the bounded window this response returned (see JobSnapshot.logs). */
  logEventsReturned?: number;
  /** check_task/get_task: the logCursor returned, for correlating a caller's next knownLogCount. */
  logCursor?: number;
};

export type TelemetrySink = (event: TelemetryEvent) => void;

function defaultSink(event: TelemetryEvent): void {
  console.error(`[telemetry] ${JSON.stringify(event)}`);
}

let sink: TelemetrySink = defaultSink;

/** Swap the telemetry sink (e.g. for tests to capture events instead of writing to stderr). Pass undefined to restore the default. */
export function setTelemetrySink(next: TelemetrySink | undefined): void {
  sink = next ?? defaultSink;
}

export function recordTelemetry(event: Omit<TelemetryEvent, "ts">): void {
  sink({ ts: Date.now(), ...event });
}
