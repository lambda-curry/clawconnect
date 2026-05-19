/**
 * Linear Agent Gateway task source for ClawConnect.
 *
 * Reads session traces from the Linear Agent Gateway's HTTP API and maps
 * them into ClawConnect's TaskSummary / CheckTaskResult / SessionInspectResult
 * types so Linear-delegated runs appear alongside direct OpenClaw runs in
 * list_tasks / get_task / list_sessions.
 *
 * The Linear Gateway runs at a known URL (typically localhost:18820) and
 * exposes:
 *   GET /sessions          → SessionTraceSummary[]
 *   GET /sessions/:id      → SessionTrace (full detail)
 *
 * This module is a read-only observer — it never initiates Linear sessions
 * or modifies gateway state.
 */

import type {
  CheckTaskResult,
  JobSnapshot,
  LogEntry,
  SessionInspectResult,
  TaskStatus,
  TaskSummary,
  Artifacts,
} from "./types.ts";

// ── Linear Gateway API types ────────────────────────────────────────────────

export interface LinearSessionTraceSummary {
  agentSessionId: string;
  linearAgentName: string;
  issueIdentifier: string;
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number;
  endedReason?: string;
  eventCount: number;
}

export interface LinearTraceEntry {
  ts: number;
  kind: "lifecycle" | "frame" | "emit" | "error";
  label: string;
  detail?: Record<string, unknown>;
}

export interface LinearSessionTrace {
  agentSessionId: string;
  linearAgentName: string;
  openclawSessionKey: string;
  issueIdentifier: string;
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number;
  endedReason?: string;
  events: LinearTraceEntry[];
}

// ── Status mapping ──────────────────────────────────────────────────────────

const TERMINAL_REASONS = new Set([
  "completed",
  "stream-error",
  "stop-signal",
  "dual-ignition-reject",
  "team-filter-reject",
  "action-archived",
  "action-removed",
]);

const ERROR_REASONS = new Set([
  "stream-error",
  "dual-ignition-reject",
  "team-filter-reject",
]);

function mapLinearStatus(
  trace: LinearSessionTraceSummary,
): TaskStatus {
  if (!trace.endedAt) return "running";
  const reason = trace.endedReason ?? "";
  if (reason === "completed") return "done";
  if (reason === "stop-signal") return "blocked";
  if (ERROR_REASONS.has(reason)) return "failed";
  // Lifecycle actions that aren't errors
  if (reason.startsWith("action-")) return "done";
  return "failed";
}

// ── Client ──────────────────────────────────────────────────────────────────

export class LinearGatewayClient {
  private baseUrl: string;
  private cache = new Map<string, { ts: number; data: LinearSessionTraceSummary }>();
  private cacheTtlMs = 5_000; // 5s — frequent enough for live coordination

  constructor(url: string) {
    // Normalise: strip trailing slash
    this.baseUrl = url.replace(/\/+$/, "");
  }

  // ── Public API (used by tools.ts) ───────────────────────────────────────

  /**
   * Fetch all sessions and map to TaskSummary[].
   * Errors are non-fatal — returns empty array so listTasks degrades gracefully.
   */
  async fetchTaskSummaries(): Promise<TaskSummary[]> {
    const traces = await this.listSessions();
    return traces.map((t) => this.toTaskSummary(t));
  }

  /**
   * Fetch a single session by agentSessionId and return a CheckTaskResult.
   * Returns { found: false } on miss or error.
   */
  async fetchCheckTask(agentSessionId: string): Promise<CheckTaskResult> {
    const trace = await this.getSession(agentSessionId);
    if (!trace) return { found: false };

    const status = mapLinearStatus(trace);
    const logs = this.toLogs(trace);

    const snapshot: JobSnapshot = {
      jobId: trace.agentSessionId,
      sessionKey: trace.openclawSessionKey,
      status: status === "done"
        ? "completed"
        : status === "failed"
          ? "error"
          : status === "blocked"
            ? "completed_no_summary"
            : "running",
      startedAt: trace.startedAt,
      lastEventAt: trace.lastActiveAt,
      lastPollAt: Date.now(),
      summary: this.deriveSummary(trace),
      error: trace.endedReason && ERROR_REASONS.has(trace.endedReason)
        ? `Linear gateway: ${trace.endedReason}`
        : undefined,
      logs,
      artifacts: emptyLinearArtifacts(),
      agent: trace.linearAgentName,
    };

    const isTerminal = trace.endedAt !== undefined;
    const isError = trace.endedReason !== undefined && ERROR_REASONS.has(trace.endedReason);

    return { found: true, snapshot, isTerminal, isError };
  }

  /**
   * Fetch a single session and return a SessionInspectResult.
   */
  async fetchSession(
    agentSessionId: string,
    mode: "snapshot" | "events" | "tail" = "snapshot",
    limit = 50,
    after = 0,
  ): Promise<SessionInspectResult> {
    const trace = await this.getSession(agentSessionId);
    if (!trace) return { found: false };

    const events = this.toLogs(trace);
    const sliced = events.slice(after, after + Math.max(1, Math.min(200, limit)));

    return {
      found: true,
      sessionKey: trace.openclawSessionKey,
      agent: trace.linearAgentName,
      jobId: trace.agentSessionId,
      status: mapLinearStatus(trace) === "done" ? "completed"
        : mapLinearStatus(trace) === "failed" ? "error"
        : mapLinearStatus(trace) === "blocked" ? "completed_no_summary"
        : "running",
      startedAt: trace.startedAt,
      lastEventAt: trace.lastActiveAt,
      summary: this.deriveSummary(trace),
      error: trace.endedReason && ERROR_REASONS.has(trace.endedReason)
        ? `Linear gateway: ${trace.endedReason}`
        : undefined,
      ...(mode !== "snapshot" ? { events: sliced } : {}),
      ...(mode === "tail" ? { nextAfter: after + sliced.length } : {}),
    };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async listSessions(): Promise<LinearSessionTraceSummary[]> {
    try {
      const res = await fetch(`${this.baseUrl}/sessions`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return [];
      const body = await res.json() as { sessions?: LinearSessionTraceSummary[] };
      return body.sessions ?? [];
    } catch {
      return [];
    }
  }

  private async getSession(id: string): Promise<LinearSessionTrace | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return undefined;
      return await res.json() as LinearSessionTrace;
    } catch {
      return undefined;
    }
  }

  // ── Mappers ───────────────────────────────────────────────────────────────

  private toTaskSummary(t: LinearSessionTraceSummary): TaskSummary {
    return {
      taskId: t.agentSessionId,
      jobId: t.agentSessionId,
      sessionKey: `linear:${t.agentSessionId}`,
      agent: t.linearAgentName,
      status: mapLinearStatus(t),
      startedAt: t.startedAt,
      lastEventAt: t.lastActiveAt,
      summary: t.endedReason === "completed"
        ? `Linear gateway run completed (${t.issueIdentifier})`
        : undefined,
      error: t.endedReason && ERROR_REASONS.has(t.endedReason)
        ? `Linear gateway: ${t.endedReason}`
        : undefined,
      source: "linear",
    };
  }

  private toLogs(trace: LinearSessionTrace): LogEntry[] {
    return trace.events.map((e) => ({
      ts: e.ts,
      type: e.kind,
      text: e.label + (e.detail ? ` ${JSON.stringify(e.detail)}` : ""),
    }));
  }

  private deriveSummary(trace: LinearSessionTrace): string | undefined {
    if (trace.endedReason === "completed") {
      return `Linear gateway run for ${trace.issueIdentifier} (${trace.linearAgentName}) completed.`;
    }
    if (!trace.endedAt) {
      return `Linear gateway run for ${trace.issueIdentifier} (${trace.linearAgentName}) in progress.`;
    }
    return `Linear gateway run ended: ${trace.endedReason}`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyLinearArtifacts(): Artifacts {
  return {
    filesChanged: [],
    commandsRun: [],
    needsHumanDecision: false,
  };
}

/**
 * Try to create a LinearGatewayClient from the registry config.
 * Returns undefined if no linearGatewayUrl is configured.
 */
export function createLinearGatewayClient(
  registry: { linearGatewayUrl?: string },
): LinearGatewayClient | undefined {
  const url = registry.linearGatewayUrl?.trim();
  if (!url) return undefined;
  return new LinearGatewayClient(url);
}
