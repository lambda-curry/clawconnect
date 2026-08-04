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
    // session's current Fleet attachment on every get_task call, not just
    // under a detail preset. Absent entirely when there is no attachment
    // (buildSnapshot never sets the key), so this stays undefined for every
    // session that has never used Fleet.
    fleetAttachment: snapshot.fleetAttachment,
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
