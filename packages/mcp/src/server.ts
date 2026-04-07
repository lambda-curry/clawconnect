import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OpenClawGateway,
  SessionManager,
  runTask,
  checkTask,
  listSessions,
} from "@clawconnect/core";
import type {
  CheckMode,
  CheckTaskResult,
  ContinuationState,
  GatewayConfig,
  RunTaskResult,
} from "@clawconnect/core";

// ── Provider config ─────────────────────────────────────────────────────────

type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type ProviderConfig = {
  /** Default check mode: "wait" blocks until terminal/timeout, "poll" returns on new logs */
  defaultCheckMode?: CheckMode;
  /** Extra _meta to attach to tool definitions (e.g., widget binding for ChatGPT) */
  toolMeta?: Record<string, Record<string, unknown>>;
  /** Custom response formatter. Receives the tool result and returns an MCP response. */
  formatRunTask?: (result: RunTaskResult) => McpToolResponse;
  formatCheckTask?: (result: CheckTaskResult) => McpToolResponse;
  formatListSessions?: (result: ContinuationState[]) => McpToolResponse;
};

// ── Default formatters (optimized for agentic use / Claude Code) ────────────

function defaultFormatRunTask(result: RunTaskResult): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          jobId: result.jobId,
          sessionKey: result.sessionKey,
          status: result.status,
          message: "Task submitted. Use check_task to poll for progress.",
        }),
      },
    ],
  };
}

function defaultFormatCheckTask(result: CheckTaskResult): McpToolResponse {
  if (!result.found) {
    return {
      content: [{ type: "text" as const, text: "Job not found. The server may have restarted." }],
      isError: true,
    };
  }

  const { snapshot, isTerminal, isError } = result;

  if (!isTerminal) {
    // While running: keep response minimal to save tokens during polling
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "running",
            jobId: snapshot.jobId,
            sessionKey: snapshot.sessionKey,
            elapsedSeconds: Math.round((Date.now() - snapshot.startedAt) / 1000),
            logCount: snapshot.logs.length,
            hint: "Task is actively running. Call check_task again to continue waiting.",
          }),
        },
      ],
    };
  }

  // Terminal: deliver the full payload
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          jobId: snapshot.jobId,
          sessionKey: snapshot.sessionKey,
          status: snapshot.status,
          summary: snapshot.summary,
          error: snapshot.error,
          errorInfo: snapshot.errorInfo,
          artifacts: snapshot.artifacts,
          continuationState: snapshot.continuationState,
        }),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function defaultFormatListSessions(result: ContinuationState[]): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          result.map((s) => ({
            sessionKey: s.sessionKey,
            lastJobId: s.lastJobId,
            lastSummary: s.lastSummary?.slice(0, 200),
            recommendedNextStep: s.recommendedNextStep,
            filesChanged: s.artifacts.filesChanged,
          })),
        ),
      },
    ],
  };
}

// ── Server factory ──────────────────────────────────────────────────────────

export function createMcpServer(config: GatewayConfig & { agentId: string; provider?: ProviderConfig }) {
  const server = new McpServer({
    name: "clawconnect",
    version: "0.0.1",
  });

  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  const provider = config.provider ?? {};
  const defaultMode = provider.defaultCheckMode ?? "wait";
  const fmtRun = provider.formatRunTask ?? defaultFormatRunTask;
  const fmtCheck = provider.formatCheckTask ?? defaultFormatCheckTask;
  const fmtList = provider.formatListSessions ?? defaultFormatListSessions;

  server.tool(
    "run_task",
    "Submit a task to OpenClaw. Returns a jobId and sessionKey immediately. Use check_task to poll for progress. Pass a sessionKey from a previous task to continue the same conversation thread.",
    {
      task: z.string().describe("The task to perform"),
      context: z.string().optional().describe("Additional context for the task"),
      sessionKey: z.string().optional().describe("Session key from a previous task to continue the same thread"),
    },
    async ({ task, context, sessionKey }) => {
      const result = runTask(sessions, { task, context, sessionKey });
      return fmtRun(result);
    },
  );

  server.tool(
    "check_task",
    `Check the status of a running OpenClaw task. Blocks for up to 50 seconds before returning. Call in a loop until status is not "running". Pass the jobId from run_task.`,
    {
      jobId: z.string().optional().describe("The jobId from run_task"),
      sessionKey: z.string().optional().describe("The sessionKey from run_task (alternative to jobId)"),
      knownLogCount: z.number().optional().describe("Number of log entries already seen — in poll mode, server returns early on new activity"),
      mode: z.enum(["poll", "wait"]).optional().describe('Polling mode: "wait" blocks until completion or timeout (recommended for agentic use), "poll" returns on any new log activity'),
    },
    async ({ jobId, sessionKey, knownLogCount, mode }) => {
      const result = await checkTask(sessions, {
        jobId,
        sessionKey,
        knownLogCount,
        mode: (mode as CheckMode) ?? defaultMode,
      });
      return fmtCheck(result);
    },
  );

  server.tool(
    "list_sessions",
    "List all active OpenClaw sessions. Shows session keys, last job status, and recommended next steps.",
    {},
    async () => {
      const result = listSessions(sessions);
      return fmtList(result);
    },
  );

  return { server, gateway, sessions };
}
