import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GatewayPool,
  runTask,
  checkTask,
  getSession,
  listTasks,
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
  TaskSummary,
  SessionInspectResult,
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
  formatListTasks?: (result: TaskSummary[]) => McpToolResponse;
  formatGetSession?: (result: SessionInspectResult) => McpToolResponse;
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

function defaultFormatListTasks(result: TaskSummary[]): McpToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ tasks: result }) }],
  };
}

function defaultFormatGetSession(result: SessionInspectResult): McpToolResponse {
  if (!result.found) return { content: [{ type: "text", text: "Session not found." }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
  const fmtListTasks = provider.formatListTasks ?? defaultFormatListTasks;
  const fmtGetSession = provider.formatGetSession ?? defaultFormatGetSession;

  const agentIds = config.registry.agents.map((a) => a.id);
  const agentBlurbs = config.registry.agents.map(agentBlurb).join("; ");
  const agentList = agentIds.join(", ");
  const agentEnum = z.enum(agentIds as [string, ...string[]]);
  const defaultAgent = config.registry.default;
  const agentDescription = `OpenClaw agent to dispatch to. Available: ${agentBlurbs}. Default: ${defaultAgent}. Use list_agents for full descriptions and routing guidance.`;

  server.tool(
    "run_task",
    `Delegate work to an OpenClaw agent for deeper investigation, implementation, or judgment that benefits from that agent's own context, tools, and identity. Returns a jobId and sessionKey immediately while the task runs in the background.

The actual result is what the user wants — not the jobId. After calling run_task, immediately call check_task with mode="wait" in a loop, passing the same jobId, until status is no longer "running". Then report the real outcome (summary, files changed, errors, etc.) to the user. A typical short task takes 30s–3min and needs 1–5 check_task calls.

Skip the polling loop only when:
- The user explicitly asked for fire-and-forget ("just dispatch it, I'll check later").
- You are parallel-dispatching multiple jobs to different agents — in that case dispatch all first, then poll each in turn.

Pass a sessionKey from a previous task to continue the same thread. Available agents: ${agentList}.`,
    {
      task: z.string().describe("The task to perform"),
      agent: agentEnum.optional().describe(agentDescription),
      context: z.string().optional().describe("Additional context for the task"),
      sessionKey: z.string().optional().describe("Session key from a previous task to continue the same thread"),
      senderName: z.string().optional().describe("Name of the person you're chatting with, on whose behalf this task is dispatched. This connection may be shared by multiple people — when the user has identified themselves (or you otherwise know who you're talking to), pass their name so the receiving agent knows who it's helping. The agent has no other way to tell."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ task, agent, context, sessionKey, senderName }) => {
      const result = runTask(pool, { task, agent, context, sessionKey, senderName });
      return fmtRun(result);
    },
  );

  server.tool(
    "check_task",
    `Check whether a previously dispatched run_task job has finished, and collect the result.

With mode="wait" (recommended): blocks for up to 50 seconds and only returns on a terminal status (completed / completed_no_summary / error) or timeout. Call repeatedly with the same jobId until status is no longer "running" — that's how you get the actual answer.

With mode="poll": returns as soon as any new log activity appears. Use this only when you need intermediate progress (live UI), not when you just want the final result.

If a job returns status="completed_no_summary" or status="error" on a long, tool-heavy run, calling check_task again 30–60 seconds later can upgrade it: the openclaw session may have produced the final answer after the connector marked terminal, and a lazy re-read of the transcript on subsequent polls will surface it. Worth one or two follow-up polls before reporting back that no result was produced.

Pass the jobId returned by run_task. Available agents: ${agentList}.`,
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
    "list_tasks",
    `List manager-friendly task summaries across agents. This is task-level coordination (what needs attention), not low-level session debugging.`,
    {
      view: z.enum(["active", "all"]).optional().describe('Optional preset. "active" returns running tasks only.'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ view }) => {
      const tasks = listTasks(pool);
      const filtered = view === "active" ? tasks.filter((t) => t.status === "running") : tasks;
      return fmtListTasks(filtered);
    },
  );

  server.tool(
    "get_task",
    `Inspect a task by taskId/jobId and optionally include updates/logs/artifacts for richer manager status.`,
    {
      taskId: z.string().describe("Task identifier (same as jobId in v1)"),
      include: z.array(z.enum(["summary", "updates", "artifacts", "diagnostics"])).optional(),
      mode: z.enum(["poll", "wait"]).optional().describe('Uses check semantics: "wait" blocks up to timeout; "poll" returns on updates'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ taskId, include, mode }) => {
      const result = await checkTask(pool, { jobId: taskId, mode: (mode as CheckMode) ?? defaultMode });
      if (!result.found) return defaultFormatCheckTask(result);
      const snapshot = result.snapshot;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId: snapshot.jobId,
              jobId: snapshot.jobId,
              sessionKey: snapshot.sessionKey,
              agent: snapshot.agent,
              status: snapshot.status,
              startedAt: snapshot.startedAt,
              lastEventAt: snapshot.lastEventAt,
              summary: include ? (include.includes("summary") ? snapshot.summary : undefined) : snapshot.summary,
              updates: include?.includes("updates") ? snapshot.logs : undefined,
              artifacts: include?.includes("artifacts") ? snapshot.artifacts : undefined,
              diagnostics: include?.includes("diagnostics")
                ? { error: snapshot.error, errorInfo: snapshot.errorInfo, continuationState: snapshot.continuationState }
                : undefined,
            }),
          },
        ],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );

  server.tool(
    "get_session",
    `Inspect one session for debugging ("what exactly happened?"). Use mode="snapshot" for current state, "events" for bounded event retrieval, or "tail" for cursor-based tailing.`,
    {
      sessionId: z.string().describe("Session key to inspect"),
      mode: z.enum(["snapshot", "events", "tail"]).optional(),
      limit: z.number().int().positive().max(200).optional().describe("Max events to return for events/tail modes"),
      after: z.number().int().nonnegative().optional().describe("Zero-based event cursor; for tail mode use returned nextAfter"),
      agent: agentEnum.optional().describe(`${agentDescription} Usually inferred from sessionId.`),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ sessionId, mode, limit, after, agent }) => {
      const result = getSession(pool, { sessionId, mode, limit, after, agent });
      return fmtGetSession(result);
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
    `List the OpenClaw agents reachable from this connection, with role, emoji, description, and "when to use" guidance. Useful when deciding which agent (samwise/scout/meg/etc.) to delegate to.`,
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
    `Search shared QMD memory for context — notes, decisions, identity files, project docs, past cycle records. Useful any time you want to ground yourself in what's already known about a topic: to answer directly without delegating, to enrich a prompt before run_task, or just to recall something. Returns top-matching snippets across the collections this connection can reach. Independent of run_task — use whenever it helps.`,
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
    `List the QMD memory collections this connection can search. Each entry shows which agents grant access. Useful when you want to scope a search_memory call to a particular collection.`,
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
