import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GatewayPool,
  LocalTmuxFleetAdapter,
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
  buildRunTaskStructuredContent,
  buildCheckTaskStructuredContent,
  buildGetTaskStructuredContent,
  TASK_SUMMARY_PREVIEW_MAX,
} from "@clawconnect/core";
import type {
  AgentRegistry,
  CheckMode,
  CheckTaskResult,
  ContinuationState,
  FleetAdapter,
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
  const structuredContent = buildRunTaskStructuredContent(result);
  const payload = { ...structuredContent, message: "Task submitted. Use check_task to poll for progress." };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent,
  };
}

/** Exported for the contract tests — driving a real running job through the
 *  in-memory transport would need a live gateway, and the model-facing text
 *  (not just structuredContent) is the thing under test. */
export function defaultFormatCheckTask(result: CheckTaskResult): McpToolResponse {
  if (!result.found) {
    return {
      content: [{ type: "text" as const, text: "Job not found. The server may have restarted." }],
      isError: true,
    };
  }

  const { snapshot, isTerminal, isError, continuePolling } = result;
  // structuredContent is always the full snapshot — client-neutral, shared
  // with the ChatGPT transport (buildCheckTaskStructuredContent). Only the
  // TEXT content stays minimal while running, to save tokens during polling.
  const structuredContent = buildCheckTaskStructuredContent(result);

  if (!isTerminal) {
    const payload = {
      status: "running",
      jobId: snapshot.jobId,
      sessionKey: snapshot.sessionKey,
      agent: snapshot.agent,
      elapsedSeconds: Math.round((Date.now() - snapshot.startedAt) / 1000),
      // logCursor, not the returned-entry count: `logs` is a bounded
      // projection, so its length is exactly the number a caller must NOT
      // send back as knownLogCount. logEventCount is the server-side total,
      // for awareness only — it is not a cursor either.
      logCursor: snapshot.logCursor,
      logEventCount: snapshot.logEventCount,
      pollCount: snapshot.pollCount,
      recovery: snapshot.recovery,
      continuePolling,
      retryAfterMs: snapshot.retryAfterMs,
      nextAction: snapshot.nextAction,
      hint: snapshot.recovery
        ? `Task is recovering late transcript final text. Call check_task again to continue waiting; pass knownLogCount=${snapshot.logCursor}.`
        : `Task is actively running (this is a non-terminal timeout, not an error). Call check_task again with the same jobId to continue waiting; pass knownLogCount=${snapshot.logCursor} to resume the log window.`,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent,
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
    retryAfterMs: snapshot.retryAfterMs,
    nextAction: snapshot.nextAction,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent,
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

export function createMcpServer(config: {
  registry: AgentRegistry;
  provider?: ProviderConfig;
  /**
   * Fleet-transcript recovery adapter (see docs/architecture/2026-08-02-
   * managed-fleet-attachment-plan.md). Defaults to a real LocalTmuxFleetAdapter
   * so recovery tier 3 is actually reachable in production. Override in
   * tests to inject a fake and assert on wiring.
   */
  fleetAdapter?: FleetAdapter;
}) {
  const server = new McpServer({
    name: "ClawConnect",
    version: "0.1.0",
  });

  const fleetAdapter = config.fleetAdapter ?? new LocalTmuxFleetAdapter();
  const pool = new GatewayPool(config.registry, undefined, fleetAdapter);

  const provider = config.provider ?? {};
  const defaultMode = provider.defaultCheckMode ?? "wait";
  const fmtRun = provider.formatRunTask ?? defaultFormatRunTask;
  const fmtCheck = provider.formatCheckTask ?? defaultFormatCheckTask;
  const fmtList = provider.formatListSessions ?? defaultFormatListSessions;
  const fmtListTasks = provider.formatListTasks ?? defaultFormatListTasks;
  const fmtGetSession = provider.formatGetSession ?? defaultFormatGetSession;

  const agentIds = config.registry.agents.map((a) => a.id);
  const agentBlurbs = config.registry.agents.map(agentBlurb).join("; ");
  const agentEnum = z.enum(agentIds as [string, ...string[]]);
  const defaultAgent = config.registry.default;
  // The enum already constrains the ids; this adds only the role hint needed
  // to pick between them. Full descriptions live in list_agents — the other
  // tools' agent params infer the agent and don't repeat any of this.
  const agentDescription = `OpenClaw agent to dispatch to: ${agentBlurbs}. Default: ${defaultAgent}. See list_agents for full routing guidance.`;

  server.tool(
    "run_task",
    `Delegate work to an OpenClaw agent. Returns a jobId and sessionKey immediately; the task runs in the background.

The result is what the user wants — not the jobId. Call check_task in a loop until continuePolling is false, then report the real outcome. \`nextAction\` is the exact next call: its args are check_task's parameters, so pass them through unchanged. A typical short task takes 30s–3min.

Skip the polling loop only for explicit fire-and-forget, or when parallel-dispatching to several agents (dispatch all first, then poll each).

Pass a sessionKey from a previous task to continue the same thread.`,
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
    `Wait for a dispatched run_task job and collect its result. The only tool that waits — get_task is the immediate, non-blocking read.

mode="wait" (default) blocks up to waitMs and returns early only on a terminal status: completed, completed_no_summary, or error. A timeout return is neither an error nor terminal — continuePolling is true, so just call again with the same jobId. There is no cap on how many times. Never submit a new run_task because a check_task timed out; the session-busy guard would reject the duplicate anyway.

mode="poll" returns as soon as any new log activity appears (still bounded by waitMs) — for live progress UIs, not for collecting a final result.

Each response's logCursor is an opaque resume token: pass it back verbatim as knownLogCount on the next call. Do not derive it from how many log entries you received.

completed_no_summary and error are terminal — report them. Rarely, a long tool-heavy run finishes its answer after the connector marks it terminal; one follow-up check_task ~30s later can upgrade such a job to completed. Do that at most once or twice, not as routine.`,
    {
      jobId: z.string().optional().describe("The jobId from run_task."),
      sessionKey: z.string().optional().describe("The sessionKey from run_task — resolves the session's latest job. Alternative to jobId."),
      agent: agentEnum.optional().describe("Usually inferred from jobId; set only if run_task ran in a different process."),
      knownLogCount: z.number().optional().describe("The previous response's logCursor, passed back UNCHANGED — an opaque resume token, never a count you compute from the entries you received. Omit or 0 for the initial window. The server returns only events after it (a bounded delta, not the full log); in poll mode it also gates the early return."),
      mode: z.enum(["poll", "wait"]).optional().describe('"wait" (default) blocks up to waitMs, returning early only on a terminal status; a timeout return is non-terminal, just call again. "poll" returns on any new log activity — for live progress UIs.'),
      waitMs: z.number().optional().describe("Max time to block, in ms. Default 45000; clamped to [1000, 120000] rather than erroring."),
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
    `List task rows across agents — one per session — for coordination ("what needs attention"), not session debugging. Each row's summary is a bounded preview (~${TASK_SUMMARY_PREVIEW_MAX} chars, flagged with summaryTruncated); use get_task for a task's full summary and artifacts.`,
    {
      view: z.enum(["active", "all"]).optional().describe('"active" returns only non-terminal tasks (queued, running, blocked, needs-human); omit to include terminal ones too.'),
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
    `Immediate snapshot of one task — NEVER waits, unlike check_task. Returns whatever state exists right now (including status="running"), for diagnostics, manual reads, or UI refresh. This is also the read path for a task's COMPLETE summary and artifacts; list_tasks only carries a truncated preview.

At detail levels that include it, \`updates\` is a bounded recent-activity window, not the full accumulated log — pass \`knownLogCount\` to get only newer entries. \`summary\`/\`artifacts\` are never bounded by the cursor: once terminal they are always complete.`,
    {
      taskId: z.string().describe("Task identifier. Same value as jobId — either name resolves the same task."),
      detail: z
        .enum(["core", "summary", "updates", "artifacts", "diagnostics", "prompt", "full", "fullWithDiagnostics"])
        .optional()
        .describe(
          "Detail preset; omit for summary. core=identifiers, status, and polling metadata only; summary=core+summary; updates=core+`updates` (recent activity) with logCursor/logEventCount; artifacts=core+artifacts; diagnostics=core+`diagnostics` (error, errorInfo, recovery, continuationState); prompt=the originally submitted task/context, which no other preset ever returns; full=core+summary+updates+artifacts; fullWithDiagnostics=full+diagnostics.",
        ),
      knownLogCount: z.number().optional().describe("The previous response's logCursor, passed back UNCHANGED — an opaque resume token, never a count of entries you received. Omit for the initial recent-activity window."),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ taskId, detail, knownLogCount }) => {
      const d = detail ?? "summary";
      if (d === "prompt") {
        const result = getTaskPrompt(pool, { jobId: taskId });
        if (!result.found) {
          return { content: [{ type: "text", text: "Task not found. The server may have restarted." }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify({ taskId, prompt: result.prompt }) }], structuredContent: { taskId, prompt: result.prompt } };
      }
      const result = getTask(pool, { jobId: taskId, knownLogCount });
      if (!result.found) return defaultFormatCheckTask(result);
      const payload = buildGetTaskStructuredContent(result, detail);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );

  server.tool(
    "get_session",
    `Inspect one session for debugging ("what exactly happened?").`,
    {
      sessionId: z.string().describe("Session key to inspect."),
      mode: z
        .enum(["snapshot", "events", "tail", "tasks"])
        .optional()
        .describe('"snapshot" (default) = the session\'s current state, no events. "events" = one bounded slice from `after`. "tail" = the same slice plus a `nextAfter` cursor for paging FORWARD through the log (oldest-first, not last-N-lines); page again with after=nextAfter until fewer than `limit` events come back. "tasks" = every task ever run under this session, newest first, in list_tasks\' row shape (summaries are truncated previews there).'),
      limit: z.number().int().positive().max(200).optional().describe("Max events per page for events/tail modes. Default 50, max 200."),
      after: z.number().int().nonnegative().optional().describe("Zero-based event offset to read from; for tail mode pass the previous response's nextAfter. Unrelated to check_task/get_task's logCursor — different cursor space."),
      agent: agentEnum.optional().describe("Usually inferred from sessionId."),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ sessionId, mode, limit, after, agent }) => {
      const result = getSession(pool, { sessionId, mode, limit, after, agent });
      return fmtGetSession(result);
    },
  );

  server.tool(
    "list_sessions",
    `List every OpenClaw session this connector knows about, across agents — including finished ones, since a completed session's sessionKey is what you pass to run_task to continue that thread. Shows agent, session key, last job, last summary, and a recommended next step.`,
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
