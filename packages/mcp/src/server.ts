import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GatewayPool,
  runTask,
  checkTask,
  getTask,
  getTaskPrompt,
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

/** Non-terminal task statuses — tasks that still need attention. */
const ACTIVE_STATUSES: ReadonlySet<TaskSummary["status"]> = new Set([
  "queued",
  "running",
  "blocked",
  "needs-human",
]);

function isActiveTaskStatus(status: TaskSummary["status"]): boolean {
  return ACTIVE_STATUSES.has(status);
}

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
  const payload = {
    jobId: result.jobId,
    taskId: result.taskId,
    sessionKey: result.sessionKey,
    status: result.status,
    agent: result.agent,
    nextAction: result.nextAction,
    message: "Task submitted. Use check_task to poll for progress.",
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function defaultFormatCheckTask(result: CheckTaskResult): McpToolResponse {
  if (!result.found) {
    return {
      content: [{ type: "text" as const, text: "Job not found. The server may have restarted." }],
      isError: true,
    };
  }

  const { snapshot, isTerminal, isError, continuePolling } = result;

  if (!isTerminal) {
    // While running: keep response minimal to save tokens during polling
    const payload = {
      status: "running",
      jobId: snapshot.jobId,
      sessionKey: snapshot.sessionKey,
      agent: snapshot.agent,
      elapsedSeconds: Math.round((Date.now() - snapshot.startedAt) / 1000),
      logCount: snapshot.logs.length,
      pollCount: snapshot.pollCount,
      recovery: snapshot.recovery,
      continuePolling,
      nextAction: snapshot.nextAction,
      hint: snapshot.recovery
        ? "Task is recovering late transcript final text. Call check_task again to continue waiting."
        : "Task is actively running (this is a non-terminal timeout, not an error). Call check_task again with the same jobId to continue waiting.",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }

  // Terminal: deliver the full payload
  const payload = {
    jobId: snapshot.jobId,
    sessionKey: snapshot.sessionKey,
    agent: snapshot.agent,
    status: snapshot.status,
    recovery: snapshot.recovery,
    summary: snapshot.summary,
    error: snapshot.error,
    errorInfo: snapshot.errorInfo,
    artifacts: snapshot.artifacts,
    continuationState: snapshot.continuationState,
    pollCount: snapshot.pollCount,
    continuePolling,
    nextAction: snapshot.nextAction,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
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

The actual result is what the user wants — not the jobId. After calling run_task, immediately call check_task with mode="wait" in a loop, passing the same jobId, until status is no longer "running" (equivalently: until continuePolling is false). Then report the real outcome (summary, files changed, errors, etc.) to the user. A typical short task takes 30s–3min and needs a handful of check_task calls at the default 45s wait window. The response's nextAction field always names the exact next call to make.

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
    // Annotations classify intent, not a behavioral guarantee (MCP spec) —
    // openWorldHint:true because the dispatched agent's own tool use is
    // genuinely open-world; run_task itself always creates a new job.
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ task, agent, context, sessionKey, senderName }) => {
      const result = runTask(pool, { task, agent, context, sessionKey, senderName });
      return fmtRun(result);
    },
  );

  server.tool(
    "check_task",
    `Check whether a previously dispatched run_task job has finished, and collect the result. This is the only tool that waits — get_task is for an immediate, non-blocking read.

With mode="wait" (recommended, default): blocks for up to waitMs (default 45000ms, override with waitMs, clamped to [1000, 120000]) and only returns early on a terminal status (completed / completed_no_summary / error). A timeout return is NOT an error and NOT terminal — continuePolling is true and nextAction says to call check_task again with the same jobId. There is no cap on how many times you may do this; never submit a new run_task because a check_task call timed out (that risks a duplicate — the session-busy guard will reject it anyway).

With mode="poll": returns as soon as any new log activity appears (also bounded by waitMs). Use this only when you need intermediate progress (live UI), not when you just want the final result.

If a job returns status="completed_no_summary" or status="error" on a long, tool-heavy run, calling check_task again 30–60 seconds later can upgrade it: the openclaw session may have produced the final answer after the connector marked terminal, and a lazy re-read of the transcript on subsequent polls will surface it. Worth one or two follow-up polls before reporting back that no result was produced.

Pass the jobId returned by run_task. Available agents: ${agentList}.`,
    {
      jobId: z.string().optional().describe("The jobId from run_task"),
      sessionKey: z.string().optional().describe("The sessionKey from run_task (alternative to jobId)"),
      agent: agentEnum.optional().describe(`${agentDescription} Usually inferred from jobId; only set if you started run_task in a different process.`),
      knownLogCount: z.number().optional().describe("Number of log entries already seen — in poll mode, server returns early on new activity"),
      mode: z.enum(["poll", "wait"]).optional().describe('Polling mode: "wait" (default) blocks up to waitMs and only returns early on a terminal status — a timeout return is non-terminal, just call again. "poll" returns on any new log activity — use for live progress UIs.'),
      waitMs: z.number().optional().describe("Max time to block, in ms. Default 45000. Clamped to [1000, 120000] — out-of-range values clamp rather than error."),
    },
    // idempotentHint:true because repeated calls with the same args don't create
    // duplicate side effects (each call only reads/advances polling state) — it
    // does NOT mean the response is identical across calls. Annotations are
    // hints for client UX, not enforced guarantees (MCP spec).
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ jobId, sessionKey, agent, knownLogCount, mode, waitMs }) => {
      const result = await checkTask(pool, {
        jobId,
        sessionKey,
        agent,
        knownLogCount,
        mode: (mode as CheckMode) ?? defaultMode,
        waitMs,
      });
      return fmtCheck(result);
    },
  );

  server.tool(
    "list_tasks",
    `List manager-friendly task summaries across agents. This is task-level coordination (what needs attention), not low-level session debugging.`,
    {
      view: z.enum(["active", "all"]).optional().describe('Optional preset. "active" returns non-terminal tasks (queued, running, blocked, needs-human) that still need attention.'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ view }) => {
      const tasks = listTasks(pool);
      const filtered = view === "active" ? tasks.filter((t) => isActiveTaskStatus(t.status)) : tasks;
      return fmtListTasks(filtered);
    },
  );

  server.tool(
    "get_task",
    `Inspect a task by taskId/jobId with a detail preset controlling which fields are returned. Unlike check_task, this NEVER waits — it's an immediate snapshot of whatever state exists right now (including status="running"), for diagnostics, manual reads, or UI refresh. Use check_task to actually wait for a result.`,
    {
      taskId: z.string().describe("Task identifier (same as jobId in v1)"),
      detail: z
        .enum(["core", "summary", "updates", "artifacts", "diagnostics", "prompt", "full", "fullWithDiagnostics"])
        .optional()
        .describe(
          "Detail preset. Omit for summary. core=ids+status only; summary=+summary; updates=+logs; artifacts=+artifacts; diagnostics=+error info; prompt=the original submitted task/context (not included by any other preset); full=core+summary+updates+artifacts; fullWithDiagnostics=full+diagnostics",
        ),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ taskId, detail }) => {
      const d = detail ?? "summary";
      if (d === "prompt") {
        const result = getTaskPrompt(pool, { jobId: taskId });
        if (!result.found) {
          return { content: [{ type: "text", text: "Task not found. The server may have restarted." }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ taskId, prompt: result.prompt }) }], structuredContent: { taskId, prompt: result.prompt } };
      }
      const result = getTask(pool, { jobId: taskId });
      if (!result.found) return defaultFormatCheckTask(result);
      const snapshot = result.snapshot;
      const has = (field: string) => d === field || d === "full" || d === "fullWithDiagnostics";
      const payload = {
        taskId: snapshot.jobId,
        jobId: snapshot.jobId,
        sessionKey: snapshot.sessionKey,
        agent: snapshot.agent,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        lastEventAt: snapshot.lastEventAt,
        recovery: snapshot.recovery,
        pollCount: snapshot.pollCount,
        continuePolling: result.continuePolling,
        nextAction: snapshot.nextAction,
        summary: d === "summary" || has("summary") ? snapshot.summary : undefined,
        updates: has("updates") ? snapshot.logs : undefined,
        artifacts: has("artifacts") ? snapshot.artifacts : undefined,
        diagnostics:
          d === "diagnostics" || d === "fullWithDiagnostics"
            ? { error: snapshot.error, errorInfo: snapshot.errorInfo, recovery: snapshot.recovery, continuationState: snapshot.continuationState }
            : undefined,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
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
