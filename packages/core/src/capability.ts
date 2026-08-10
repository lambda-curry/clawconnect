import { agentBlurb, agentDescriptor, type AgentEntry, type AgentRegistry } from "./agent-registry.ts";
import { SERVER_VERSION, buildSha, toolsetVersion } from "./build-info.ts";
import type { GatewayPool } from "./gateway-pool.ts";
import { getMemory, listCollections, searchMemory } from "./memory.ts";
import {
  buildCheckTaskStructuredContent,
  buildGetTaskStructuredContent,
  buildRunTaskStructuredContent,
  type TaskDetail,
} from "./structured-content.ts";
import {
  TASK_SUMMARY_PREVIEW_MAX,
  checkTask,
  getSession,
  getTask,
  getTaskPrompt,
  listSessions,
  listTasks,
  runTask,
} from "./tools.ts";
import type { CheckMode, SessionInspectMode, TaskSummary } from "./types.ts";

/**
 * The one tool surface.
 *
 * Every transport ClawConnect speaks — stdio, HTTP, and whatever comes next —
 * projects this array. It was previously declared three times (the stdio
 * server, the HTTP server's modern path, and the HTTP server's hand-rolled
 * legacy router), and the copies had already drifted: different parameter
 * descriptions for the same argument, an `outputSchema` on one surface only,
 * and identity handling that existed on exactly one of them. Worse, the
 * per-agent authorization checks were implemented three times too, so the
 * check that decides whether a caller may see another agent's work had three
 * chances to be wrong independently.
 *
 * A capability here is a declaration, a policy, and a handler together — not
 * a schema that each transport then re-implements. The transport's remaining
 * job is genuinely transport-shaped: negotiate the protocol, carry the bytes,
 * and optionally render nicer human-facing text than the default.
 */

/**
 * Which agents a connection may see, and which it defaults to.
 *
 * stdio has no per-connection narrowing and passes every configured agent;
 * HTTP derives this from `?group=` / `?agents=` on the connection URL. Both
 * get the same enforcement because both hand the same object to the same
 * handlers.
 */
export interface Scope {
  allowedIds: string[];
  defaultId: string;
  /** MCP serverInfo.name to report — a group's label when the connection is pinned to one. */
  serverName: string;
}

/**
 * Who the caller is, established from the credential rather than from
 * anything the model said.
 *
 * `user` is set when a personal token matched; `legacy` marks the shared
 * pass, which authenticates but identifies nobody. A model-supplied
 * `senderName` is only ever consulted when `user` is null — identity derives
 * from the credential, so a model cannot claim to be someone else.
 */
export interface Identity {
  user: string | null;
  legacy?: boolean;
}

export interface CapabilityContext {
  pool: GatewayPool;
  registry: AgentRegistry;
  scope: Scope;
  identity: Identity;
  /** "wait" for agentic clients, "poll" for live progress UIs. */
  defaultCheckMode: CheckMode;
  /**
   * Protocol era and revision as the TRANSPORT observed them for the CURRENT
   * request — never a constant, and a thunk rather than a value because a
   * stdio connection settles its era in the opening exchange, after the
   * capabilities are built. The previous implementation hardcoded
   * "2025-06-18" for every legacy connection while `initialize` separately
   * answered whatever the client asked for, so the one tool whose job was
   * reporting the truth about the connection could contradict the handshake.
   */
  protocol: () => { era: "legacy" | "modern"; version?: string };
}

export interface CapabilityResult {
  structuredContent?: unknown;
  /** Fallback model-facing text. A transport may render its own instead. */
  text?: string;
  isError?: boolean;
}

export interface Capability {
  name: string;
  title: string;
  description: string;
  /** JSON Schema 2020-12. Canonical — transports convert, never re-declare. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  /** True for the one capability that changes anything. Drives the description prefix and the annotations. */
  mutates: boolean;
  handler: (
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ) => Promise<CapabilityResult> | CapabilityResult;
}

export const GET_TOKEN_HINT =
  "this connection uses the shared legacy token, so tasks arrive unattributed. " +
  "Tell the user to ask for their own personal ClawConnect token — it stamps their name on every task so agents know who they're working with.";

/** Non-terminal task statuses — the ones that still need someone's attention. */
const ACTIVE_STATUSES: ReadonlySet<TaskSummary["status"]> = new Set([
  "queued",
  "running",
  "blocked",
  "needs-human",
]);

/**
 * The read-only preamble.
 *
 * Annotations already say `readOnlyHint: true`, but an annotation is a
 * structured hint a host may or may not surface to the model, while the
 * description is text the model reads directly. Saying it in both places
 * costs a line and removes the ambiguity about which one a given client's
 * safety layer is actually reading.
 */
const READ_ONLY = "READ ONLY: never starts, changes, or cancels any work.";

function jsonResult(payload: unknown, isError?: boolean): CapabilityResult {
  return { structuredContent: payload, text: JSON.stringify(payload), ...(isError ? { isError: true } : {}) };
}

function errorResult(message: string): CapabilityResult {
  return { text: message, structuredContent: { error: message }, isError: true };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ── Shared schema fragments ─────────────────────────────────────────────────

/**
 * Output schemas are deliberately permissive: `additionalProperties` stays
 * open and `required` names only what every branch genuinely returns. A
 * strict client validates `structuredContent` against these, so a schema that
 * over-promises turns an ordinary response into a client-side error. The
 * schema is here to make chaining predictable, not to police our own payload.
 */
const OPEN: Record<string, unknown> = { type: "object", additionalProperties: true };

/**
 * The chaining contract: fields a caller reads to decide its NEXT call.
 *
 * These get declared types so they arrive in stable, typed locations instead
 * of being extracted from prose — that is where structured output actually
 * pays, because it removes the chance to manufacture a malformed follow-up.
 * `required` stays deliberately minimal: several of these tools answer
 * not-found (and get_task's `prompt` preset) with a legitimately different
 * payload, so requiring a field the error branch omits would turn an ordinary
 * "not found" into a client-side schema violation. Strict where it chains,
 * permissive everywhere else.
 */
const TASK_CHAINING_PROPERTIES: Record<string, unknown> = {
  jobId: { type: "string" },
  taskId: { type: "string" },
  sessionKey: { type: "string" },
  agent: { type: "string" },
  status: { type: "string" },
  isTerminal: { type: "boolean" },
  isError: { type: "boolean" },
  continuePolling: { type: "boolean" },
  // The opaque resume token a caller must hand back verbatim as knownLogCount.
  logCursor: { type: "number" },
  logEventCount: { type: "number" },
  summary: { type: "string" },
  error: { type: "string" },
  nextAction: { type: ["object", "null"] },
};

const TASK_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    taskId: { type: "string" },
    jobId: { type: "string" },
    sessionKey: { type: "string" },
    agent: { type: "string" },
    status: { type: "string", enum: ["queued", "running", "done", "failed", "blocked", "needs-human"] },
    startedAt: { type: "number" },
    lastEventAt: { type: "number" },
    summary: { type: "string" },
    summaryTruncated: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["taskId", "jobId", "sessionKey", "status"],
};

// ── The capabilities ────────────────────────────────────────────────────────

export function buildCapabilities(ctx: CapabilityContext): Capability[] {
  const { pool, registry, scope, identity } = ctx;
  const agentsById = new Map<string, AgentEntry>(registry.agents.map((a) => [a.id, a]));
  const scopedAgents = () =>
    scope.allowedIds.map((id) => agentsById.get(id)).filter((a): a is AgentEntry => Boolean(a));

  const blurbs = scope.allowedIds
    .map((id) => agentBlurb(agentsById.get(id) ?? { id, url: "", password: "", openclawAgentId: "" }))
    .join("; ");

  const agentProp = {
    type: "string",
    enum: scope.allowedIds,
    description: `OpenClaw agent to dispatch to. Available: ${blurbs}. Default: ${scope.defaultId}. Use list_agents for full descriptions and routing guidance.`,
  };

  /**
   * The single per-agent authorization check. Two shapes, one implementation:
   * refusing a REQUESTED agent outside the scope, and hiding a RESULT that
   * belongs to one. Previously both existed once per transport.
   */
  const refuseAgent = (requested: string): CapabilityResult =>
    errorResult(
      `Agent "${requested}" is not available on this connection. Allowed: ${scope.allowedIds.join(", ")}.`,
    );
  const inScope = (agent: string | undefined): boolean => !agent || scope.allowedIds.includes(agent);

  const senderNameProp = identity.user
    ? {
        type: "string",
        description: `Ignored — this connection is authenticated as ${identity.user}, and the server stamps that identity on every task.`,
      }
    : {
        type: "string",
        description: identity.legacy
          ? `Name of the person you're chatting with, on whose behalf this task is dispatched. Pass it when known so the receiving agent knows who it's helping. Also: ${GET_TOKEN_HINT}`
          : "Name of the person you're chatting with, on whose behalf this task is dispatched. This connection may be shared by multiple people — when the user has identified themselves (or you otherwise know who you're talking to), pass their name so the receiving agent knows who it's helping. The agent has no other way to tell.",
      };

  const capabilities: Capability[] = [
    {
      name: "run_task",
      title: "Run Task",
      mutates: true,
      // Wording restored to what ChatGPT's safety layer demonstrably accepted
      // in production for months. A "this is the only tool here that starts
      // anything; every other tool is read-only" sentence was added here on
      // 2026-08-09 and ChatGPT began hard-blocking run_task pre-execution —
      // the call never reached the server. Read tools SHOULD say they are
      // read-only; a queueing tool should NOT advertise itself as the
      // dangerous one, especially against ten siblings that now emphatically
      // disclaim mutation. Keep this factual and bounded. See AGENTS.md.
      description: `Delegate work to an OpenClaw agent. Returns a jobId and sessionKey immediately; the task runs in the background.

The result is what the user wants — not the jobId. Call check_task in a loop until continuePolling is false, then report the real outcome. \`nextAction\` is the exact next call: its args are check_task's parameters, so pass them through unchanged. A typical short task takes 30s–3min.

Skip the polling loop only for explicit fire-and-forget, or when parallel-dispatching to several agents (dispatch all first, then poll each).

Pass a sessionKey from a previous task to continue the same thread.`,
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task to perform" },
          agent: agentProp,
          context: { type: "string", description: "Additional context for the task" },
          sessionKey: {
            type: "string",
            description:
              "Session key from a previous task to continue the same thread. Omit to start a new thread.",
          },
          senderName: senderNameProp,
        },
        required: ["task"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          jobId: { type: "string" },
          taskId: { type: "string" },
          sessionKey: { type: "string" },
          status: { type: "string", enum: ["running"] },
          agent: { type: "string" },
          nextAction: {
            type: ["object", "null"],
            additionalProperties: true,
            properties: {
              tool: { type: "string", enum: ["check_task"] },
              args: {
                type: "object",
                additionalProperties: true,
                properties: { jobId: { type: "string" }, sessionKey: { type: "string" } },
                required: ["jobId", "sessionKey"],
              },
            },
            required: ["tool", "args"],
          },
        },
        required: ["jobId", "taskId", "sessionKey", "status", "nextAction"],
      },
      annotations: {
        title: "Run Task",
        readOnlyHint: false,
        destructiveHint: false,
        // The dispatched agent has its own tools and can reach outside this
        // connection. run_task itself only queues — but what it queues is
        // genuinely open-world, and the annotation describes the call's
        // reachable effect, not its implementation.
        openWorldHint: true,
      },
      handler: (args) => {
        const requestedAgent = str(args.agent) ?? scope.defaultId;
        if (!scope.allowedIds.includes(requestedAgent)) return refuseAgent(requestedAgent);
        try {
          const result = runTask(pool, {
            task: str(args.task) ?? "",
            agent: requestedAgent,
            context: str(args.context),
            sessionKey: str(args.sessionKey),
            // The credential's identity is ground truth; a model-supplied
            // senderName only fills in when the connection is anonymous.
            senderName: identity.user ?? str(args.senderName),
          });
          const structuredContent = buildRunTaskStructuredContent(result);
          return {
            structuredContent,
            text:
              JSON.stringify({
                ...structuredContent,
                message: "Task submitted. Use check_task to poll for progress.",
              }) + (identity.legacy ? `\n\nNote: ${GET_TOKEN_HINT}` : ""),
          };
        } catch (err) {
          return errorResult(`Failed to submit: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "check_task",
      title: "Check Task Status",
      mutates: false,
      description: `${READ_ONLY} Waits for a dispatched run_task job and collects its result — the only tool that waits. get_task is the immediate, non-blocking read.

mode="wait" (default) blocks up to waitMs and returns early only on a terminal status: completed, completed_no_summary, or error. A timeout return is neither an error nor terminal — continuePolling is true, so call again with the same jobId. Never submit a new run_task because a check_task timed out; the session-busy guard would reject the duplicate anyway.

Do not wait indefinitely inside one reply. Each individual wait is bounded, but chaining them is not: several consecutive 45s waits keep one response open for minutes with nothing visible happening, and that is what breaks the connection — the host gives up on a reply that produces no output for long enough, and the user sees a failure even though the job is fine. After roughly two or three waits (~2 minutes), stop waiting and end your reply: say the task is still running and give the jobId. The job is durable and keeps going without you, its progress card keeps updating on its own, and you or the user can pick it up with another check_task whenever. Ending the reply is a handoff, not an abandonment — a run that outlives one reply is normal, not a failure to report.

mode="poll" returns as soon as any new log activity appears (still bounded by waitMs) — for live progress UIs, not for collecting a final result.

Each response's logCursor is an opaque resume token: pass it back verbatim as knownLogCount on the next call. Do not derive it from how many log entries you received.

completed_no_summary and error are terminal — report them. Rarely, a long tool-heavy run finishes its answer after the connector marks it terminal; one follow-up check_task ~30s later can upgrade such a job to completed. Do that at most once or twice, not as routine.`,
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The jobId returned by run_task." },
          sessionKey: {
            type: "string",
            description:
              "The sessionKey from run_task — resolves the session's latest job. Alternative to jobId, and how a status check reattaches after a refresh.",
          },
          agent: { ...agentProp, description: "Usually inferred from jobId; set only if run_task ran elsewhere." },
          knownLogCount: {
            type: "number",
            description:
              "The previous response's logCursor, passed back UNCHANGED — an opaque resume token, never a count you compute from the entries you received. Omit or 0 for the initial window. The server returns only events after it (a bounded delta, not the full log); in poll mode it also gates the early return.",
          },
          mode: {
            type: "string",
            enum: ["poll", "wait"],
            description:
              '"wait" (default) blocks up to waitMs, returning early only on a terminal status; a timeout return is non-terminal, just call again. "poll" returns on any new log activity — for live progress UIs.',
          },
          waitMs: {
            type: "number",
            description: "Max time to block, in ms. Default 45000; clamped to [1000, 120000] rather than erroring.",
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: TASK_CHAINING_PROPERTIES,
        required: ["status"],
      },
      annotations: {
        title: "Check Task Status",
        readOnlyHint: true,
        destructiveHint: false,
        // Repeated calls with the same args create no duplicate side effects.
        // It does NOT mean the response is identical across calls.
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args, opts) => {
        const requestedAgent = str(args.agent);
        if (requestedAgent && !scope.allowedIds.includes(requestedAgent)) return refuseAgent(requestedAgent);
        const result = await checkTask(pool, {
          jobId: str(args.jobId),
          sessionKey: str(args.sessionKey),
          agent: requestedAgent,
          knownLogCount: num(args.knownLogCount) ?? 0,
          mode: (str(args.mode) as CheckMode | undefined) ?? ctx.defaultCheckMode,
          waitMs: num(args.waitMs),
          signal: opts?.signal,
        });
        if (!result.found) {
          const message = args.sessionKey
            ? "Task state not found for that session. The server may have restarted."
            : "Job not found. The server may have restarted.";
          return {
            text: message,
            structuredContent: {
              jobId: str(args.jobId),
              sessionKey: str(args.sessionKey),
              status: "error",
              error: message,
            },
            isError: true,
          };
        }
        // Don't leak results from agents outside this connection's scope —
        // and say the same thing we'd say if it genuinely did not exist, so
        // the refusal doesn't confirm the job's existence either.
        if (!inScope(result.snapshot.agent)) {
          return {
            text: "Job not found.",
            structuredContent: {
              jobId: str(args.jobId),
              sessionKey: str(args.sessionKey),
              status: "error",
              error: "Job not found.",
            },
            isError: true,
          };
        }
        return {
          structuredContent: buildCheckTaskStructuredContent(result),
          ...(result.isError ? { isError: true } : {}),
        };
      },
    },

    {
      name: "get_task",
      title: "Get Task",
      mutates: false,
      description: `${READ_ONLY} Immediate snapshot of one task — NEVER waits, unlike check_task. Returns whatever state exists right now (including status="running"), for diagnostics, manual reads, or UI refresh. This is also the read path for a task's COMPLETE summary and artifacts; list_tasks only carries a truncated preview.

At detail levels that include it, \`updates\` is a bounded recent-activity window, not the full accumulated log — pass \`knownLogCount\` to get only newer entries. \`summary\`/\`artifacts\` are never bounded by the cursor: once terminal they are always complete.`,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task identifier. Same value as jobId — either name resolves the same task." },
          detail: {
            type: "string",
            enum: ["core", "summary", "updates", "artifacts", "diagnostics", "prompt", "full", "fullWithDiagnostics"],
            description:
              "Detail preset; omit for summary. core=identifiers, status, and polling metadata only; summary=core+summary; updates=core+`updates` (recent activity) with logCursor/logEventCount; artifacts=core+artifacts; diagnostics=core+`diagnostics` (error, errorInfo, recovery, continuationState); prompt=the originally submitted task/context, which no other preset ever returns; full=core+summary+updates+artifacts; fullWithDiagnostics=full+diagnostics.",
          },
          knownLogCount: {
            type: "number",
            description:
              "The previous response's logCursor, passed back UNCHANGED — an opaque resume token, never a count of entries you received. Omit for the initial recent-activity window.",
          },
        },
        required: ["taskId"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: { ...TASK_CHAINING_PROPERTIES, prompt: OPEN },
        required: ["taskId"],
      },
      annotations: {
        title: "Get Task",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args) => {
        const taskId = str(args.taskId) ?? "";
        const detail = str(args.detail) as TaskDetail | undefined;
        const result = getTask(pool, { jobId: taskId, knownLogCount: num(args.knownLogCount) });
        if (!result.found) {
          return {
            text: "Task not found. The server may have restarted.",
            structuredContent: { taskId, status: "error", error: "Task not found." },
            isError: true,
          };
        }
        if (!inScope(result.snapshot.agent)) {
          return {
            text: "Task not found.",
            structuredContent: { taskId, status: "error", error: "Task not found." },
            isError: true,
          };
        }
        // The prompt preset is a separate read path, gated by the SAME
        // per-agent scope check above — which has already run by this point.
        if (detail === "prompt") {
          const promptResult = getTaskPrompt(pool, { jobId: taskId });
          if (!promptResult.found) return errorResult("Task not found.");
          return jsonResult({ taskId, prompt: promptResult.prompt });
        }
        const payload = buildGetTaskStructuredContent(result, detail);
        return { structuredContent: payload, text: JSON.stringify(payload), ...(result.isError ? { isError: true } : {}) };
      },
    },

    {
      name: "list_tasks",
      title: "List Tasks",
      mutates: false,
      description: `${READ_ONLY} Lists task rows across agents — one per session — for coordination ("what needs attention"), not session debugging. Each row's summary is a bounded preview (~${TASK_SUMMARY_PREVIEW_MAX} chars, flagged with summaryTruncated); use get_task for a task's full summary and artifacts.`,
      inputSchema: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["active", "all"],
            description:
              '"active" returns only non-terminal tasks (queued, running, blocked, needs-human); omit to include terminal ones too.',
          },
        },
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: { tasks: { type: "array", items: TASK_SUMMARY_SCHEMA } },
        required: ["tasks"],
      },
      annotations: {
        title: "List Tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args) => {
        const scoped = listTasks(pool).filter((t) => inScope(t.agent));
        const filtered = str(args.view) === "active" ? scoped.filter((t) => ACTIVE_STATUSES.has(t.status)) : scoped;
        return jsonResult({ tasks: filtered });
      },
    },

    {
      name: "get_session",
      title: "Get Session",
      mutates: false,
      description: `${READ_ONLY} Inspects one session for debugging ("what exactly happened?").`,
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session key to inspect." },
          mode: {
            type: "string",
            enum: ["snapshot", "events", "tail", "tasks"],
            description:
              '"snapshot" (default) = the session\'s current state, no events. "events" = one bounded slice from `after`. "tail" = the same slice plus a `nextAfter` cursor for paging FORWARD through the log (oldest-first, not last-N-lines); page again with after=nextAfter until fewer than `limit` events come back. "tasks" = every task ever run under this session, newest first, in list_tasks\' row shape (summaries are truncated previews there).',
          },
          limit: { type: "number", description: "Max events per page for events/tail modes. Default 50, max 200." },
          after: {
            type: "number",
            description:
              "Zero-based event offset to read from; for tail mode pass the previous response's nextAfter. Unrelated to check_task/get_task's logCursor — different cursor space.",
          },
          agent: { ...agentProp, description: "Usually inferred from sessionId." },
        },
        required: ["sessionId"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          found: { type: "boolean" },
          sessionKey: { type: "string" },
          agent: { type: "string" },
          jobId: { type: "string" },
          status: { type: "string" },
          // Pass back as `after` to page forward; pagination is exhausted when
          // it stops advancing.
          nextAfter: { type: "number" },
          tasks: { type: "array", items: TASK_SUMMARY_SCHEMA },
        },
        required: ["found"],
      },
      annotations: {
        title: "Get Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args) => {
        const agent = str(args.agent);
        if (agent && !scope.allowedIds.includes(agent)) return refuseAgent(agent);
        const result = getSession(pool, {
          sessionId: str(args.sessionId) ?? "",
          mode: str(args.mode) as SessionInspectMode | undefined,
          limit: num(args.limit),
          after: num(args.after),
          agent,
        });
        if (!result.found || !inScope(result.agent)) {
          return {
            text: "Session not found.",
            structuredContent: { sessionId: str(args.sessionId), found: false },
            isError: true,
          };
        }
        return jsonResult(result);
      },
    },

    {
      name: "list_sessions",
      title: "List Sessions",
      mutates: false,
      description: `${READ_ONLY} Lists every OpenClaw session this connector knows about, across agents — including finished ones, since a completed session's sessionKey is what you pass to run_task to continue that thread. Shows agent, session key, last job, last summary, and a recommended next step.`,
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          sessions: { type: "array", items: OPEN },
          configuredAgents: { type: "array", items: { type: "string" } },
        },
        required: ["sessions"],
      },
      annotations: {
        title: "List Sessions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: () => {
        const sessions = listSessions(pool).filter((s) => inScope(s.agent));
        return jsonResult({ sessions, configuredAgents: scope.allowedIds });
      },
    },

    {
      name: "list_agents",
      title: "List Agents",
      mutates: false,
      description: `${READ_ONLY} Lists the OpenClaw agents reachable from this connection, with role, emoji, description, and "when to use" guidance. Useful when deciding which agent to delegate to.`,
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: { default: { type: "string" }, agents: { type: "array", items: OPEN } },
        required: ["default", "agents"],
      },
      annotations: {
        title: "List Agents",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: () => jsonResult({ default: scope.defaultId, agents: scopedAgents().map(agentDescriptor) }),
    },

    {
      name: "search_memory",
      title: "Search Memory",
      mutates: false,
      description: `${READ_ONLY} Searches shared QMD memory for context — notes, decisions, identity files, project docs, past cycle records. Useful any time you want to ground yourself in what's already known about a topic: to answer directly without delegating, to enrich a prompt before run_task, or just to recall something. Returns top-matching snippets across the collections this connection can reach. Independent of run_task — use whenever it helps.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (keyword + semantic combined)" },
          limit: { type: "number", description: "Max results to return (default 8, max 50)" },
          collections: {
            type: "array",
            items: { type: "string" },
            description:
              "Restrict to these collection names. Omit to search all collections the connection can reach. Use list_collections to discover them.",
          },
          intent: { type: "string", description: "One-line description of why you're searching — telemetry only." },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              // `file` is the qmd:// path a caller hands straight to
              // get_memory — the one field here that chains.
              properties: {
                file: { type: "string" },
                collection: { type: "string" },
                score: { type: "number" },
                snippet: { type: "string" },
              },
              required: ["file"],
            },
          },
          errors: { type: "array", items: OPEN },
        },
        required: ["hits", "errors"],
      },
      annotations: {
        title: "Search Memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args) =>
        jsonResult(
          await searchMemory(scopedAgents(), {
            query: str(args.query) ?? "",
            limit: num(args.limit),
            collections: Array.isArray(args.collections) ? (args.collections as string[]) : undefined,
            intent: str(args.intent),
          }),
        ),
    },

    {
      name: "get_memory",
      title: "Get Memory",
      mutates: false,
      description: `${READ_ONLY} Fetches the full body of a memory document by its qmd:// path (returned in search_memory hits as 'file').`,
      inputSchema: {
        type: "object",
        properties: { file: { type: "string", description: "qmd://collection/<id>.md path from a search_memory hit" } },
        required: ["file"],
      },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          file: { type: "string" },
          found: { type: "boolean" },
          body: { type: "string" },
          collection: { type: "string" },
          errors: { type: "array", items: OPEN },
        },
        required: ["file", "found", "errors"],
      },
      annotations: {
        title: "Get Memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args) => {
        const result = await getMemory(scopedAgents(), str(args.file) ?? "");
        return jsonResult(result, !result.found);
      },
    },

    {
      name: "list_collections",
      title: "List Collections",
      mutates: false,
      description: `${READ_ONLY} Lists the QMD memory collections this connection can search. Each entry shows which agents grant access. Useful when you want to scope a search_memory call to a particular collection.`,
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: true,
        properties: { collections: { type: "array", items: OPEN } },
        required: ["collections"],
      },
      annotations: {
        title: "List Collections",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: () => jsonResult({ collections: listCollections(scopedAgents()) }),
    },
  ];

  /**
   * The connection manifest.
   *
   * Answers two questions that were previously unanswerable from inside a
   * client: which code is serving me, and which tool catalog does this
   * connection actually have? `toolsetVersion` is derived from the
   * declarations above, so a client holding a stale catalog reports a
   * different value than the server does — which is the only reliable way to
   * tell "the backend is broken" from "my snapshot is old".
   *
   * Declared last, and included in its own fingerprint: the hash covers the
   * declarations only, and is computed per call rather than stored in one, so
   * a tool that reports the fingerprint can still be part of what is
   * fingerprinted.
   */
  capabilities.push({
    name: "get_connection_info",
    title: "Get Connection Info",
    mutates: false,
    description: `${READ_ONLY} Reports what this MCP connection actually is: the protocol era and revision in use, the server version and build commit, a fingerprint of the tool catalog being served, the authenticated identity, and which agents are in scope.

Use it when something looks inconsistent — a tool you expect is missing, a description doesn't match what you were told, or a fix appears not to have taken effect. Compare \`toolsetVersion\` against what you were told to expect: if the server reports one value and your tool catalog was built from another, your client is holding a stale snapshot and needs to reconnect, which is a different problem from the server being wrong.`,
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        protocolEra: { type: "string", enum: ["legacy", "modern"] },
        protocolVersion: { type: "string" },
        serverName: { type: "string" },
        serverVersion: { type: "string" },
        build: { type: "string" },
        toolsetVersion: { type: "string" },
        toolCount: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
        identity: {
          type: "object",
          additionalProperties: true,
          properties: { user: { type: ["string", "null"] }, legacy: { type: "boolean" } },
        },
        agents: {
          type: "object",
          additionalProperties: true,
          properties: {
            allowed: { type: "array", items: { type: "string" } },
            default: { type: "string" },
          },
        },
      },
      required: ["protocolEra", "serverVersion", "build", "toolsetVersion", "tools"],
    },
    annotations: {
      title: "Get Connection Info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: () =>
      jsonResult({
        protocolEra: ctx.protocol().era,
        // Omitted rather than guessed when the transport genuinely cannot
        // know it — a legacy stdio connection carries no version header, and
        // a diagnostic that fills the gap with a plausible constant is how
        // this tool previously came to contradict the handshake it describes.
        ...(ctx.protocol().version ? { protocolVersion: ctx.protocol().version } : {}),
        serverName: scope.serverName,
        serverVersion: SERVER_VERSION,
        build: buildSha(),
        toolsetVersion: toolsetVersion(capabilities),
        toolCount: capabilities.length,
        tools: capabilities.map((c) => c.name).sort(),
        identity: { user: identity.user, ...(identity.legacy ? { legacy: true } : {}) },
        agents: { allowed: scope.allowedIds, default: scope.defaultId },
      }),
  });

  return capabilities;
}
