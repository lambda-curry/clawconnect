import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GatewayPool,
  runTask,
  checkTask,
  listSessions,
  agentBlurb,
  agentDescriptor,
  searchMemory,
  getMemory,
  listCollections,
} from "@clawconnect/core";
import type {
  AgentRegistry,
  CheckMode,
  CheckTaskResult,
  ContinuationState,
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
          agent: result.agent,
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
            agent: snapshot.agent,
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
          agent: snapshot.agent,
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
            agent: s.agent,
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

export function createMcpServer(config: { registry: AgentRegistry; provider?: ProviderConfig }) {
  const server = new McpServer({
    name: "ClawConnect",
    version: "0.1.0",
  });

  const pool = new GatewayPool(config.registry);

  const provider = config.provider ?? {};
  const defaultMode = provider.defaultCheckMode ?? "wait";
  const fmtRun = provider.formatRunTask ?? defaultFormatRunTask;
  const fmtCheck = provider.formatCheckTask ?? defaultFormatCheckTask;
  const fmtList = provider.formatListSessions ?? defaultFormatListSessions;

  const agentIds = config.registry.agents.map((a) => a.id);
  const agentBlurbs = config.registry.agents.map(agentBlurb).join("; ");
  const agentList = agentIds.join(", ");
  const agentEnum = z.enum(agentIds as [string, ...string[]]);
  const defaultAgent = config.registry.default;
  const agentDescription = `OpenClaw agent to dispatch to. Available: ${agentBlurbs}. Default: ${defaultAgent}. Use list_agents for full descriptions and routing guidance.`;

  server.tool(
    "run_task",
    `Submit a task to an OpenClaw agent. Returns a jobId and sessionKey immediately. Use check_task to poll for progress. Pass a sessionKey from a previous task to continue the same conversation thread. Available agents: ${agentList}.`,
    {
      task: z.string().describe("The task to perform"),
      agent: agentEnum.optional().describe(agentDescription),
      context: z.string().optional().describe("Additional context for the task"),
      sessionKey: z.string().optional().describe("Session key from a previous task to continue the same thread"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ task, agent, context, sessionKey }) => {
      const result = runTask(pool, { task, agent, context, sessionKey });
      return fmtRun(result);
    },
  );

  server.tool(
    "check_task",
    `Check the status of a running OpenClaw task. Blocks for up to 50 seconds before returning. Call in a loop until status is not "running". Pass the jobId from run_task. Available agents: ${agentList}.`,
    {
      jobId: z.string().optional().describe("The jobId from run_task"),
      sessionKey: z.string().optional().describe("The sessionKey from run_task (alternative to jobId)"),
      agent: agentEnum.optional().describe(`${agentDescription} Usually inferred from jobId; only set if you started run_task in a different process.`),
      knownLogCount: z.number().optional().describe("Number of log entries already seen — in poll mode, server returns early on new activity"),
      mode: z.enum(["poll", "wait"]).optional().describe('Polling mode: "wait" blocks until completion or timeout (recommended for agentic use), "poll" returns on any new log activity'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ jobId, sessionKey, agent, knownLogCount, mode }) => {
      const result = await checkTask(pool, {
        jobId,
        sessionKey,
        agent,
        knownLogCount,
        mode: (mode as CheckMode) ?? defaultMode,
      });
      return fmtCheck(result);
    },
  );

  server.tool(
    "list_sessions",
    `List active OpenClaw sessions across configured agents. Shows agent, session keys, last job status, and recommended next steps. Available agents: ${agentList}.`,
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      const result = listSessions(pool);
      return fmtList(result);
    },
  );

  server.tool(
    "list_agents",
    `List the OpenClaw agents reachable from this connection, with role, emoji, description, and "when to use" guidance. Call this first to decide which agent (samwise/scout/meg/etc.) to dispatch a task to.`,
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      const agents = config.registry.agents.map(agentDescriptor);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ default: config.registry.default, agents }),
          },
        ],
      };
    },
  );

  server.tool(
    "search_memory",
    `Search the shared QMD memory store before dispatching a task — find what's already known. Returns top-matching snippets across the collections this connection can reach. Use this first for any question that might already be answered in notes, decisions, or past cycle records. Call list_collections to see which collections are available.`,
    {
      query: z.string().describe("Search query (keyword + semantic combined)"),
      limit: z.number().int().positive().max(50).optional().describe("Max results to return (default 8)"),
      collections: z.array(z.string()).optional().describe("Restrict to these collection names. Omit to search all collections the connection can reach."),
      intent: z.string().optional().describe("One-line description of why you're searching — for telemetry only, not sent to QMD."),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ query, limit, collections, intent }) => {
      const result = await searchMemory(config.registry.agents, { query, limit, collections, intent });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.tool(
    "get_memory",
    `Fetch the full body of a memory document by its qmd:// path (returned in search_memory hits as 'file').`,
    {
      file: z.string().describe("qmd://collection/<id>.md path from a search_memory hit"),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ file }) => {
      const result = await getMemory(config.registry.agents, file);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        ...(result.found ? {} : { isError: true }),
      };
    },
  );

  server.tool(
    "list_collections",
    `List the QMD memory collections searchable from this connection. Each entry shows which agents grant access. Call before search_memory to see what's available.`,
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      const collections = listCollections(config.registry.agents);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ collections }) }],
      };
    },
  );

  return { server, pool };
}
