import type { CheckTaskResult, RunTaskResult } from "./types.ts";

/**
 * Client-neutral structuredContent builders. Plain MCP (structuredContent is
 * a normal CallToolResult field, not a ChatGPT extension) — imported by both
 * the stdio McpServer (packages/mcp/server.ts) and the ChatGPT HTTP app
 * (apps/chatgpt/src/index.ts) so their structuredContent payloads for the
 * same underlying snapshot are byte-identical. ChatGPT-only concerns
 * (_meta["openai/*"], the ui:// resource) live only in apps/chatgpt and never
 * touch these builders. See docs/architecture/2026-07-27-multi-client-
 * compatibility.md §1.
 */

export function buildRunTaskStructuredContent(result: RunTaskResult) {
  return {
    jobId: result.jobId,
    taskId: result.taskId,
    sessionKey: result.sessionKey,
    status: result.status,
    execution: result.execution,
    upstream: result.upstream,
    transcript: result.transcript,
    cancellation: result.cancellation,
    agent: result.agent,
    nextAction: result.nextAction,
  };
}

type FoundCheckTaskResult = Extract<CheckTaskResult, { found: true }>;

/** check_task's full structuredContent — always the whole snapshot, regardless of terminal state (the text content is what stays minimal-while-running for token savings; structuredContent is for programmatic/UI consumers who want the full picture). */
export function buildCheckTaskStructuredContent(result: FoundCheckTaskResult) {
  return { ...result.snapshot, isTerminal: result.isTerminal, isError: result.isError };
}

export type TaskDetail = "core" | "summary" | "updates" | "artifacts" | "diagnostics" | "prompt" | "full" | "fullWithDiagnostics";

/** get_task's detail-preset-filtered structuredContent, shared so both transports' detail filtering stays in lockstep instead of two hand-maintained copies. */
export function buildGetTaskStructuredContent(result: FoundCheckTaskResult, detail: TaskDetail | undefined) {
  const { snapshot, isTerminal, isError, continuePolling } = result;
  const d = detail ?? "summary";
  const has = (field: string) => d === field || d === "full" || d === "fullWithDiagnostics";
  const payload: Record<string, unknown> = {
    taskId: snapshot.jobId,
    jobId: snapshot.jobId,
    sessionKey: snapshot.sessionKey,
    agent: snapshot.agent,
    status: snapshot.status,
    execution: snapshot.execution,
    upstream: snapshot.upstream,
    transcript: snapshot.transcript,
    cancellation: snapshot.cancellation,
    lastSeenSequence: snapshot.lastSeenSequence,
    startedAt: snapshot.startedAt,
    lastEventAt: snapshot.lastEventAt,
    recovery: snapshot.recovery,
    pollCount: snapshot.pollCount,
    continuePolling,
    retryAfterMs: snapshot.retryAfterMs,
    nextAction: snapshot.nextAction,
    isTerminal,
    isError,
    resultSource: snapshot.resultSource,
    terminalReason: snapshot.terminalReason,
    // Unconditional, same treatment as `recovery` above — the owning host needs the
    // session's current attachment on every get_task call, not just
    // under a detail preset. Absent entirely when there is no attachment
    // (buildSnapshot never sets the key), so this stays undefined for every
    // session that has never had an attachment.
    agentSession: snapshot.agentSession,
    // Also unconditional, and for a sharper reason than convenience: a
    // TaskSummary ROW already carries `liveness` (see tools.ts) precisely so a
    // listing can say "working quietly" without a per-row get_task. Omitting it
    // from the drill-down made the two surfaces contradict each other — a
    // caller who saw the row's evidence and called get_task to confirm it got
    // NOTHING back, which JobLiveness explicitly says to read as "nothing has
    // had cause to look yet" rather than as bad news. The detail read must be
    // able to confirm what the listing already claimed.
    //
    // `parentRunId` rides the same rule: it exists to correlate this job with
    // the run openclaw is actually executing, so a diagnostic that names no run
    // cannot be checked against anything. Both are small scalars, so no preset
    // gate — the presets exist to bound payload SIZE (logs, artifacts, prompt),
    // and gating an identifier behind one just hides it from the caller who
    // needs it most.
    liveness: snapshot.liveness,
    parentRunId: snapshot.parentRunId,
    // The PATH of this job's opaque payload, if it had one — never its
    // contents, which ClawConnect does not read back and no tool returns.
    // Unconditional for the same reason parentRunId is: a supervisor asking
    // "was a payload delivered, and where did it go" needs to be able to get
    // an answer, and the presets exist to bound payload SIZE, not to hide
    // identifiers from the caller who needs them most.
    payloadPath: snapshot.payloadPath,
  };
  if (d === "summary" || has("summary")) payload.summary = snapshot.summary;
  if (has("updates")) {
    payload.updates = snapshot.logs;
    // The cursor to pass back as knownLogCount next time — only meaningful
    // alongside `updates`, so it rides the same preset gate rather than
    // every detail level.
    payload.logCursor = snapshot.logCursor;
    payload.logEventCount = snapshot.logEventCount;
  }
  if (has("artifacts")) payload.artifacts = snapshot.artifacts;
  if (d === "diagnostics" || d === "fullWithDiagnostics") {
    payload.diagnostics = {
      error: snapshot.error,
      errorInfo: snapshot.errorInfo,
      recovery: snapshot.recovery,
      continuationState: snapshot.continuationState,
    };
  }
  return payload;
}
