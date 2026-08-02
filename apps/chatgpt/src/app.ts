import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  GatewayPool,
  runTask,
  checkTask,
  getTask,
  getTaskPrompt,
  listSessions,
  listTasks,
  getSession,
  agentBlurb,
  agentDescriptor,
  searchMemory,
  getMemory,
  listCollections,
  buildRunTaskStructuredContent,
  buildCheckTaskStructuredContent,
  buildGetTaskStructuredContent,
} from "@clawconnect/core";
import type { AgentEntry, AgentRegistry, CheckMode, TaskDetail, TaskSummary } from "@clawconnect/core";
import {
  negotiateProtocolVersion,
  buildExtensionsCapability,
  buildMountMeta,
  buildAppCallableMeta,
  UI_RESOURCE_MIME_TYPE,
} from "./ui-meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/build-widget.mjs always writes to <package root>/dist/widget.html.
// Resolving via "../dist" (not the running module's own directory) finds it
// correctly whether this module is running compiled (dist/app.js, so
// __dirname already is dist/) or via `tsx watch src/index.ts` in dev
// (__dirname is src/) — as long as `node scripts/build-widget.mjs` has been
// run at least once in either case.
const DEFAULT_WIDGET_HTML_PATH = join(__dirname, "..", "dist", "widget.html");
/** Versioned so a shape change bumps the URI rather than serving a stale cached resource under the same id. */
const WIDGET_URI = "ui://clawconnect/task-center-v1.html";
// One JSON file per agent (see GatewayPool/JsonFileJobStore) — outside dist/
// and src/ so a build never touches it. Restart-safety only: deleting this
// directory just means in-flight jobs re-derive from scratch instead of
// reattaching, same as the pre-persistence behavior.
const DEFAULT_JOB_STORE_DIR = join(__dirname, "..", ".job-store");

export interface CreateAppOptions {
  /** Path to the built, self-contained widget HTML. Overridable so tests don't depend on a real build having run. */
  widgetHtmlPath?: string;
  /** Directory for per-agent job-persistence files. Defaults on (DEFAULT_JOB_STORE_DIR) — override so tests write into a scratch dir instead of the real default. */
  jobStoreDir?: string;
}

export interface App {
  requestListener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  pool: GatewayPool;
}

/**
 * Builds the full ChatGPT HTTP MCP surface for a given agent registry, with
 * no side effects (no env reads beyond feature flags, no listen()). Split
 * out of index.ts so it's testable without the registry-loading /
 * process.exit(1) / server.listen() side effects that used to run at module
 * import time — see docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md.
 */
export function createApp(registry: AgentRegistry, opts: CreateAppOptions = {}): App {
  const widgetHtmlPath = opts.widgetHtmlPath ?? DEFAULT_WIDGET_HTML_PATH;
  const WIDGET_ENABLED = process.env.ENABLE_CHATGPT_UI_WIDGET === "true";

  let cachedWidgetHtml: string | undefined;
  let widgetLoadAttempted = false;
  function loadWidgetHtml(): string | undefined {
    if (widgetLoadAttempted) return cachedWidgetHtml;
    widgetLoadAttempted = true;
    try {
      cachedWidgetHtml = readFileSync(widgetHtmlPath, "utf8");
    } catch (err) {
      // Missing/broken widget resource must never take down the connector —
      // run_task/check_task correctness does not depend on this file existing.
      console.error(`[chatgpt-app] failed to load widget resource from ${widgetHtmlPath}: ${(err as Error).message}`);
      cachedWidgetHtml = undefined;
    }
    return cachedWidgetHtml;
  }

  const hono = new Hono();
  const pool = new GatewayPool(registry, opts.jobStoreDir ?? DEFAULT_JOB_STORE_DIR);
  // Reload every configured agent's persisted jobs now, not lazily on first
  // request — otherwise an agent nobody has queried yet since the restart
  // would leave its in-flight jobs unrecovered indefinitely.
  pool.warmAll();
  const AGENT_IDS = registry.agents.map((a) => a.id);
  const AGENT_LIST = AGENT_IDS.join(", ");

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };

  /**
   * Per-request agent scope. A connection can narrow which agents it sees with:
   *   ?group=lc-labs            — a named group from agents.json (stable URL;
   *                               membership edited server-side, no re-paste)
   *   ?agents=clawdy,hank       — an explicit list (ad-hoc scoping)
   *   ?agent=clawdy             — single-agent shorthand
   * `group` and `agents` can be combined and/or repeated — the result is the
   * union. Unknown agent ids and unknown group names are dropped with a
   * warning. If the filter resolves to zero agents, we fall back to all
   * configured agents (so a typo doesn't hand the caller an empty enum).
   *
   * `serverName` is the MCP serverInfo.name to report: when the connection is
   * scoped to exactly one labelled group, it's that group's label (e.g.
   * "Bakery ClawConnect") so multiple connectors on the same client are
   * distinguishable. Otherwise it's the generic "ClawConnect".
   */
  const DEFAULT_SERVER_NAME = "ClawConnect";

  interface Scope {
    allowedIds: string[];
    defaultId: string;
    serverName: string;
  }

  function resolveScope(url: URL): Scope {
    const csv = (vals: string[]) => vals.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

    const groupNames = csv(url.searchParams.getAll("group"));
    const explicitAgents = csv(url.searchParams.getAll("agents").concat(url.searchParams.getAll("agent")));

    const matchedGroups = groupNames.filter((g) => registry.groups[g]);
    const serverName =
      matchedGroups.length === 1 && registry.groupLabels[matchedGroups[0]]
        ? registry.groupLabels[matchedGroups[0]]
        : DEFAULT_SERVER_NAME;

    if (groupNames.length === 0 && explicitAgents.length === 0) {
      return { allowedIds: AGENT_IDS, defaultId: registry.default, serverName };
    }

    const wanted: string[] = [];
    for (const g of groupNames) {
      const members = registry.groups[g];
      if (!members) {
        console.warn(`[mcp] unknown group "${g}" — ignored (known groups: ${Object.keys(registry.groups).join(", ") || "none"})`);
        continue;
      }
      for (const id of members) if (!wanted.includes(id)) wanted.push(id);
    }
    for (const id of explicitAgents) if (!wanted.includes(id)) wanted.push(id);

    const allowed = wanted.filter((id) => AGENT_IDS.includes(id));
    if (allowed.length === 0) {
      console.warn(`[mcp] scope (groups=${JSON.stringify(groupNames)}, agents=${JSON.stringify(explicitAgents)}) resolved to no known agents — falling back to all`);
      return { allowedIds: AGENT_IDS, defaultId: registry.default, serverName };
    }
    const defaultId = allowed.includes(registry.default) ? registry.default : allowed[0];
    return { allowedIds: allowed, defaultId, serverName };
  }

  /** Non-terminal task statuses — tasks that still need attention. */
  const ACTIVE_STATUSES: ReadonlySet<TaskSummary["status"]> = new Set([
    "queued",
    "running",
    "blocked",
    "needs-human",
  ]);

  const AGENTS_BY_ID = new Map<string, AgentEntry>(registry.agents.map((a) => [a.id, a]));

  function blurbsFor(ids: string[]): string {
    return ids.map((id) => agentBlurb(AGENTS_BY_ID.get(id) ?? { id, url: "", password: "", openclawAgentId: "" })).join("; ");
  }

  function buildTools(allowedIds: string[], defaultId: string, identity: Identity) {
    const list = allowedIds.join(", ");
    const blurbs = blurbsFor(allowedIds);
    const senderNameProp = identity.user
      ? {
          type: "string" as const,
          description: `Ignored — this connection is authenticated as ${identity.user}, and the server stamps that identity on every task.`,
        }
      : {
          type: "string" as const,
          description: identity.legacy
            ? `Name of the person you're chatting with, on whose behalf this task is dispatched. Pass it when known so the receiving agent knows who it's helping. Also: ${GET_TOKEN_HINT}`
            : "Name of the person you're chatting with, on whose behalf this task is dispatched. This connection may be shared by multiple people — when the user has identified themselves (or you otherwise know who you're talking to), pass their name so the receiving agent knows who it's helping. The agent has no other way to tell.",
        };
    const agentProp = {
      type: "string" as const,
      enum: allowedIds,
      description: `OpenClaw agent to dispatch to. Available: ${blurbs}. Default: ${defaultId}. Use list_agents for full descriptions and routing guidance.`,
    };
    return [
      {
        name: "run_task",
        description: `Delegate work to an OpenClaw agent for deeper investigation, implementation, or judgment that benefits from that agent's own context, tools, and identity. Returns a jobId and sessionKey immediately while the task runs in the background.

The actual result is what the user wants — not the jobId. After calling run_task, immediately call check_task with mode="wait" in a loop, passing the same jobId, until status is no longer "running" (equivalently: until continuePolling is false). Then report the real outcome (summary, files changed, errors, etc.) to the user. A typical short task takes 30s–3min and needs a handful of check_task calls at the default 45s wait window. The response's nextAction field always names the exact next call to make.

Skip the polling loop only when:
- The user explicitly asked for fire-and-forget ("just dispatch it, I'll check later").
- You are parallel-dispatching multiple jobs to different agents — in that case dispatch all first, then poll each in turn.

Pass sessionKey from a previous result to continue the same thread. Available agents: ${list}.`,
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task to perform" },
            agent: agentProp,
            context: { type: "string", description: "Optional context for the task" },
            sessionKey: {
              type: "string",
              description: "Session key from a previous call to continue the same thread. Omit to start a new thread.",
            },
            senderName: senderNameProp,
          },
          required: ["task"],
        },
        // Matches buildRunTaskStructuredContent's exact shape (packages/core/
        // src/structured-content.ts) — this is what the widget's mount data
        // and any structuredContent-reading client actually receive.
        outputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string" },
            taskId: { type: "string" },
            sessionKey: { type: "string" },
            status: { type: "string", enum: ["running"] },
            agent: { type: "string" },
            nextAction: {
              type: ["object", "null"],
              properties: {
                tool: { type: "string", enum: ["check_task"] },
                args: {
                  type: "object",
                  properties: {
                    taskId: { type: "string" },
                    sessionKey: { type: "string" },
                  },
                  required: ["taskId", "sessionKey"],
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
          // connection (filesystem, network, other services) — this
          // connection has no visibility into what run_task itself does
          // beyond queueing. Matches the generic MCP server's annotation;
          // annotations are hints for client UX, not enforced guarantees.
          openWorldHint: true,
        },
        _meta: {
          ...buildMountMeta(WIDGET_ENABLED, WIDGET_URI),
          "openai/toolInvocation/invoking": "Sending task to OpenClaw agent...",
        },
      },
      {
        name: "check_task",
        description: `Check whether a previously dispatched run_task job has finished, and collect the result. This is the only tool that waits — get_task is for an immediate, non-blocking read.

With mode="wait" (recommended, default): blocks for up to waitMs (default 45000ms, override with waitMs, clamped to [1000, 120000]) and only returns early on a terminal status (completed / completed_no_summary / error). A timeout return is NOT an error and NOT terminal — continuePolling is true and nextAction says to call check_task again with the same jobId. There is no cap on how many times you may do this; never submit a new run_task because a check_task call timed out (that risks a duplicate — the session-busy guard will reject it anyway).

With mode="poll": returns as soon as any new log activity appears (also bounded by waitMs). Use this only when you need intermediate progress (live UI), not when you just want the final result.

If a job returns status="completed_no_summary" or status="error" on a long, tool-heavy run, calling check_task again 30–60 seconds later can upgrade it: the openclaw session may have produced the final answer after the connector marked terminal, and a lazy re-read of the transcript on subsequent polls will surface it. Worth one or two follow-up polls before reporting back that no result was produced.

Pass the jobId returned by run_task. Available agents: ${list}.`,
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "The jobId returned by run_task" },
            sessionKey: {
              type: "string",
              description: "Optional session key for reattaching status checks after refresh.",
            },
            agent: {
              ...agentProp,
              description: `${agentProp.description} Usually inferred from jobId; set explicitly if you started run_task elsewhere.`,
            },
            knownLogCount: {
              type: "number",
              description: "Log cursor from a previous response's logCursor (0/omit for the initial window). Server returns only events after it — a bounded delta, not the full log — and in poll mode returns as soon as new entries appear.",
            },
            mode: {
              type: "string",
              enum: ["poll", "wait"],
              description: 'Polling mode: "wait" (default) blocks up to waitMs and only returns on a terminal status — a timeout return is non-terminal, just call again. "poll" returns on any new log activity — use for live progress UIs.',
            },
            waitMs: {
              type: "number",
              description: "Max time to block, in ms. Default 45000. Clamped to [1000, 120000].",
            },
          },
        },
        annotations: {
          title: "Check Task Status",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "list_sessions",
        description: `List active OpenClaw sessions across configured agents. Available agents: ${list}.`,
        inputSchema: { type: "object", properties: {} },
        annotations: {
          title: "List Sessions",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "list_agents",
        description: `List the OpenClaw agents reachable from this connection, with role, emoji, description, and "when to use" guidance. Useful when deciding which agent to delegate to.`,
        inputSchema: { type: "object", properties: {} },
        annotations: {
          title: "List Agents",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "search_memory",
        description: `Search shared QMD memory for context — notes, decisions, identity files, project docs, past cycle records. Useful any time you want to ground yourself in what's already known about a topic: to answer directly without delegating, to enrich a prompt before run_task, or just to recall something. Returns top-matching snippets across collections this connection can reach. Independent of run_task — use whenever it helps.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (keyword + semantic combined)" },
            limit: { type: "number", description: "Max results to return (default 8, max 50)" },
            collections: {
              type: "array",
              items: { type: "string" },
              description: "Restrict to these collection names. Omit to search all collections the connection can reach. Use list_collections to discover them.",
            },
            intent: { type: "string", description: "One-line description of why you're searching — telemetry only." },
          },
          required: ["query"],
        },
        annotations: { title: "Search Memory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "get_memory",
        description: `Fetch the full body of a memory document by its qmd:// path (returned in search_memory hits as 'file').`,
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "qmd://collection/<id>.md path from a search_memory hit" },
          },
          required: ["file"],
        },
        annotations: { title: "Get Memory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "list_collections",
        description: `List the QMD memory collections this connection can search. Each entry shows which agents grant access. Useful when you want to scope a search_memory call to a particular collection.`,
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "List Collections", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "list_tasks",
        description: `List manager-friendly task summaries across agents. This is task-level coordination (what needs attention), not low-level session debugging.`,
        inputSchema: {
          type: "object",
          properties: {
            view: {
              type: "string",
              enum: ["active", "all"],
              description: 'Optional preset. "active" returns non-terminal tasks (queued, running, blocked, needs-human) that still need attention.',
            },
          },
        },
        annotations: { title: "List Tasks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: buildAppCallableMeta(WIDGET_ENABLED),
      },
      {
        name: "get_task",
        description: `Inspect a task by taskId/jobId with a detail preset controlling which fields are returned. Unlike check_task, this NEVER waits — it's an immediate snapshot of whatever state exists right now (including status="running"), for diagnostics, manual reads, or UI refresh. Use check_task to actually wait for a result.

With detail="updates"/"full"/"fullWithDiagnostics", the returned \`updates\` array is a BOUNDED WINDOW (recent activity), not the full accumulated log — pass \`knownLogCount\` (the \`logCursor\` a previous response returned) to get only newer entries; omit it for the initial recent-activity window. The final \`summary\`/\`artifacts\` are never bounded by this — they're always complete once the task is terminal, regardless of cursor.`,
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task identifier (same as jobId in v1)" },
            detail: {
              type: "string",
              enum: ["core", "summary", "updates", "artifacts", "diagnostics", "prompt", "full", "fullWithDiagnostics"],
              description:
                'Detail preset. Omit for summary. core=ids+status only; summary=+summary; updates=+logs; artifacts=+artifacts; diagnostics=+error info; prompt=the original submitted task/context (not included by any other preset); full=core+summary+updates+artifacts; fullWithDiagnostics=full+diagnostics',
            },
            knownLogCount: {
              type: "number",
              description: "Log cursor from a previous response's logCursor. Server returns only events after it (bounded); omit for the initial recent-activity window.",
            },
          },
          required: ["taskId"],
        },
        annotations: { title: "Get Task", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: buildAppCallableMeta(WIDGET_ENABLED),
      },
      {
        name: "get_session",
        description: `Inspect one session for debugging ("what exactly happened?"). Use mode="snapshot" for current state, "events" for bounded event retrieval, "tail" for cursor-based tailing, or "tasks" to list every task ever run under this session (newest first) — the same TaskSummary shape as list_tasks.`,
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session key to inspect" },
            mode: {
              type: "string",
              enum: ["snapshot", "events", "tail", "tasks"],
              description: "Inspection mode: snapshot (default), events, tail, or tasks",
            },
            limit: { type: "number", description: "Max events to return for events/tail modes (1–200)" },
            after: { type: "number", description: "Zero-based event cursor; for tail mode use returned nextAfter" },
            agent: { ...agentProp, description: `${agentProp.description} Usually inferred from sessionId.` },
          },
          required: ["sessionId"],
        },
        annotations: { title: "Get Session", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: buildAppCallableMeta(WIDGET_ENABLED),
      },
    ];
  }

  hono.get("/", (c) => c.text("OK"));
  hono.get("/health", (c) => c.json({ ok: true }));

  const PUBLIC_MCP_PASS = process.env.PUBLIC_MCP_PASS ?? "";

  /**
   * Personal tokens: MCP_USER_TOKENS="Jake:tok1,Mohsen:tok2,...". A personal
   * token both authenticates the request and identifies the person — identity
   * derives from the credential, not from a spoofable query param — so the
   * server can stamp `[Message from: <name>]` on every dispatched task and a
   * single person's token can be revoked without rotating everyone.
   *
   * PUBLIC_MCP_PASS (the legacy shared pass) keeps working but resolves to an
   * anonymous identity; those connections get a nudge to switch to a personal
   * token so agents know who they're working with.
   *
   * MCP_USER_TOKENS_FILE can point at a runtime-editable JSON file for adding or
   * revoking tokens without restarting the MCP process. Supported JSON shapes:
   *   { "Jake": "tok1", "Mohsen": "tok2" }
   *   { "tokens": { "Jake": "tok1", "Mohsen": "tok2" } }
   *   [{ "name": "Jake", "token": "tok1" }]
   */
  const MCP_USER_TOKENS_FILE = process.env.MCP_USER_TOKENS_FILE?.trim();

  function addToken(target: Map<string, string>, name: string, token: string, source: string) {
    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName || !cleanToken) return;
    if (target.has(cleanToken)) {
      console.warn(`[mcp] ${source}: duplicate token for "${cleanName}" collides with "${target.get(cleanToken)}" — skipped`);
      return;
    }
    target.set(cleanToken, cleanName);
  }

  function parseTokenCsv(raw: string | undefined, source: string): Map<string, string> {
    const tokens = new Map<string, string>();
    for (const pair of (raw ?? "").split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      const name = sep > 0 ? trimmed.slice(0, sep).trim() : "";
      const token = sep > 0 ? trimmed.slice(sep + 1).trim() : "";
      if (!name || !token) {
        console.warn(`[mcp] ${source} entry "${trimmed.slice(0, 16)}..." is not "Name:token" — skipped`);
        continue;
      }
      addToken(tokens, name, token, source);
    }
    return tokens;
  }

  function parseTokenJson(raw: string, source: string): Map<string, string> {
    const parsed = JSON.parse(raw) as unknown;
    const tokens = new Map<string, string>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const { name, token } = entry as Record<string, unknown>;
        if (typeof name === "string" && typeof token === "string") addToken(tokens, name, token, source);
      }
      return tokens;
    }
    if (!parsed || typeof parsed !== "object") return tokens;
    const obj = parsed as Record<string, unknown>;
    const record = obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)
      ? (obj.tokens as Record<string, unknown>)
      : obj;
    for (const [name, token] of Object.entries(record)) {
      if (typeof token === "string") addToken(tokens, name, token, source);
    }
    return tokens;
  }

  const ENV_USER_TOKENS = parseTokenCsv(process.env.MCP_USER_TOKENS, "MCP_USER_TOKENS");
  if (ENV_USER_TOKENS.size > 0) {
    console.log(`[mcp] env personal tokens loaded for: ${[...ENV_USER_TOKENS.values()].join(", ")}`);
  }
  if (MCP_USER_TOKENS_FILE) {
    console.log(`[mcp] runtime token file enabled: ${MCP_USER_TOKENS_FILE}`);
  }

  let fileTokenCache = new Map<string, string>();
  let fileTokenMtimeMs: number | null = null;

  function loadFileTokens(): Map<string, string> {
    if (!MCP_USER_TOKENS_FILE) return fileTokenCache;
    try {
      if (!existsSync(MCP_USER_TOKENS_FILE)) {
        if (fileTokenMtimeMs !== null || fileTokenCache.size > 0) {
          console.warn(`[mcp] token file disappeared: ${MCP_USER_TOKENS_FILE}`);
        }
        fileTokenMtimeMs = null;
        fileTokenCache = new Map();
        return fileTokenCache;
      }
      const mtimeMs = statSync(MCP_USER_TOKENS_FILE).mtimeMs;
      if (fileTokenMtimeMs === mtimeMs) return fileTokenCache;
      fileTokenCache = parseTokenJson(readFileSync(MCP_USER_TOKENS_FILE, "utf8"), MCP_USER_TOKENS_FILE);
      fileTokenMtimeMs = mtimeMs;
      console.log(`[mcp] runtime personal tokens loaded for: ${[...fileTokenCache.values()].join(", ") || "(none)"}`);
    } catch (err) {
      console.warn(`[mcp] failed to read token file ${MCP_USER_TOKENS_FILE}: ${(err as Error).message}`);
    }
    return fileTokenCache;
  }

  function getUserTokens(): Map<string, string> {
    const merged = new Map(ENV_USER_TOKENS);
    for (const [token, name] of loadFileTokens()) addToken(merged, name, token, MCP_USER_TOKENS_FILE ?? "token file");
    return merged;
  }

  const GET_TOKEN_HINT =
    "this connection uses the shared legacy token, so tasks arrive unattributed. " +
    "Tell the user to ask Jake for their personal ClawConnect token — it stamps their name on every task so agents know who they're working with.";

  /**
   * Resolve the caller's identity from the supplied credential (?pass=<v> or
   * Authorization: Bearer <v>). Returns:
   *   { user: "<name>" }                — personal token matched
   *   { user: null, legacy: true }      — legacy shared pass matched
   *   { user: null }                    — no auth configured at all (open mode)
   *   null                              — credential missing or wrong → 403
   */
  type Identity = { user: string | null; legacy?: boolean };

  function resolveIdentity(url: URL, req: import("node:http").IncomingMessage): Identity | null {
    const userTokens = getUserTokens();
    if (!PUBLIC_MCP_PASS && userTokens.size === 0) return { user: null }; // no gate configured (legacy open mode)
    const fromQuery = url.searchParams.get("pass");
    const auth = req.headers.authorization ?? (req.headers["authorization"] as string | undefined);
    const fromHeader = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    for (const supplied of [fromQuery, fromHeader]) {
      if (!supplied) continue;
      const name = userTokens.get(supplied);
      if (name) return { user: name };
      if (PUBLIC_MCP_PASS && supplied === PUBLIC_MCP_PASS) return { user: null, legacy: true };
    }
    return null;
  }

  async function requestListener(req: IncomingMessage, res: ServerResponse) {
    if (req.url?.startsWith("/mcp")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

      const reqUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      // Auth gate — reject /mcp requests without a valid personal token or the legacy shared pass.
      const identity = resolveIdentity(reqUrl, req);
      if (!identity) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Forbidden: token required via ?pass= or Authorization: Bearer" } }));
        return;
      }

      // Streamable HTTP clients (Cursor, MCP SDK) open a GET on /mcp for the
      // optional server→client SSE stream, and DELETE to end a session. We
      // don't offer either — the spec says answer 405 (clients MUST tolerate
      // it). Anything else (the old 400 Parse error) fails the client's
      // transport state machine and kills the whole connection.
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST, OPTIONS" });
        res.end();
        return;
      }

      const scope = resolveScope(reqUrl);

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString();

      let msg: { jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }

      const isNotification = msg.id === undefined;

      const respond = (result: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
      };

      const respondError = (code: number, message: string, httpStatus = 200) => {
        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } }));
      };

      console.log(`[mcp] ${req.method} ${msg.method}`);

      if (msg.method === "initialize") {
        const requestedProtocolVersion = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const extensions = buildExtensionsCapability(WIDGET_ENABLED);
        respond({
          protocolVersion: negotiateProtocolVersion(requestedProtocolVersion),
          capabilities: {
            tools: {},
            resources: {},
            ...(extensions ? { extensions } : {}),
          },
          serverInfo: {
            name: identity.user ? `${scope.serverName} (${identity.user})` : scope.serverName,
            version: "0.1.0",
          },
        });
      } else if (isNotification) {
        res.writeHead(202);
        res.end();
      } else if (msg.method === "tools/list") {
        respond({ tools: buildTools(scope.allowedIds, scope.defaultId, identity) });
      } else if (msg.method === "resources/list") {
        respond({
          resources: WIDGET_ENABLED
            ? [{ uri: WIDGET_URI, name: "ClawConnect Task Center", mimeType: UI_RESOURCE_MIME_TYPE }]
            : [],
        });
      } else if (msg.method === "resources/read") {
        const uri = (msg.params as { uri?: string } | undefined)?.uri;
        if (!WIDGET_ENABLED || uri !== WIDGET_URI) {
          respondError(-32602, `Unknown resource: ${uri}`);
        } else {
          const html = loadWidgetHtml();
          if (html === undefined) {
            respondError(-32603, "Widget resource failed to load — run_task/check_task are unaffected.");
          } else {
            respond({ contents: [{ uri: WIDGET_URI, mimeType: UI_RESOURCE_MIME_TYPE, text: html }] });
          }
        }
      } else if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, string> };

        if (name === "run_task") {
          const requestedAgent = typeof args.agent === "string" && args.agent ? args.agent : scope.defaultId;
          if (!scope.allowedIds.includes(requestedAgent)) {
            respond({
              content: [{ type: "text", text: `Agent "${requestedAgent}" is not available on this connection. Allowed: ${scope.allowedIds.join(", ")}.` }],
              isError: true,
            });
            console.log(`[mcp] -> ${res.statusCode}`);
            return;
          }
          try {
            const result = runTask(pool, {
              task: args.task,
              agent: requestedAgent,
              context: args.context,
              sessionKey: args.sessionKey,
              // The token's identity is ground truth; a model-supplied senderName
              // only fills in when the connection is anonymous (legacy/open).
              senderName: identity.user ?? (typeof args.senderName === "string" ? args.senderName : undefined),
            });
            console.log(`[mcp] submitted job ${result.jobId} on agent ${result.agent} session ${result.sessionKey} sender=${identity.user ?? args.senderName ?? "unknown"}${identity.legacy ? " (legacy token)" : ""}`);
            const structuredContent = buildRunTaskStructuredContent(result);
            respond({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ...structuredContent, message: "Task submitted. Use check_task to poll for progress." }) +
                    (identity.legacy ? `\n\nNote: ${GET_TOKEN_HINT}` : ""),
                },
              ],
              structuredContent,
            });
          } catch (err) {
            respond({
              content: [{ type: "text", text: `Failed to submit: ${(err as Error).message}` }],
              isError: true,
            });
          }
        } else if (name === "check_task") {
          const requestedAgent = typeof args.agent === "string" && args.agent ? args.agent : undefined;
          if (requestedAgent && !scope.allowedIds.includes(requestedAgent)) {
            respond({
              content: [{ type: "text", text: `Agent "${requestedAgent}" is not available on this connection. Allowed: ${scope.allowedIds.join(", ")}.` }],
              isError: true,
            });
            console.log(`[mcp] -> ${res.statusCode}`);
            return;
          }
          const mode = (args.mode as CheckMode) ?? "wait";
          const result = await checkTask(pool, {
            jobId: typeof args.jobId === "string" ? args.jobId : undefined,
            sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
            agent: requestedAgent,
            knownLogCount: Number(args.knownLogCount) || 0,
            mode,
            waitMs: args.waitMs !== undefined ? Number(args.waitMs) : undefined,
          });

          if (!result.found) {
            const notFoundMsg = args.sessionKey
              ? "Task state not found for that session. The server may have restarted."
              : "Job not found. The server may have restarted.";
            respond({
              content: [{ type: "text", text: notFoundMsg }],
              structuredContent: {
                jobId: args.jobId,
                sessionKey: args.sessionKey,
                status: "error",
                error: notFoundMsg,
              },
              isError: true,
            });
          } else if (result.snapshot.agent && !scope.allowedIds.includes(result.snapshot.agent)) {
            // Don't leak results from agents outside this connection's scope.
            respond({
              content: [{ type: "text", text: "Job not found." }],
              structuredContent: { jobId: args.jobId, sessionKey: args.sessionKey, status: "error", error: "Job not found." },
              isError: true,
            });
          } else {
            const { snapshot, isTerminal, isError } = result;
            respond({
              content: [
                {
                  type: "text",
                  text: isTerminal
                    ? (snapshot.summary ?? snapshot.error ?? "")
                    : snapshot.recovery
                      ? "Recovering late transcript final text. Poll again."
                      : "Still running. Poll again.",
                },
              ],
              structuredContent: buildCheckTaskStructuredContent(result),
              ...(isError ? { isError: true } : {}),
            });
          }
        } else if (name === "list_sessions") {
          const all = listSessions(pool);
          const sessions = all.filter((s) => !s.agent || scope.allowedIds.includes(s.agent));
          const summary = sessions.length === 0
            ? "No active sessions."
            : sessions.map((s) => `${s.agent ?? "?"}: ${s.sessionKey.slice(-12)} (${s.lastJobId.slice(0, 8)})`).join("\n");
          respond({
            content: [{ type: "text", text: summary }],
            structuredContent: { sessions, configuredAgents: scope.allowedIds },
          });
        } else if (name === "list_agents") {
          const agents = scope.allowedIds
            .map((id) => AGENTS_BY_ID.get(id))
            .filter((a): a is AgentEntry => Boolean(a))
            .map(agentDescriptor);
          respond({
            content: [{ type: "text", text: JSON.stringify({ default: scope.defaultId, agents }) }],
            structuredContent: { default: scope.defaultId, agents },
          });
        } else if (name === "search_memory") {
          const scopedAgents = scope.allowedIds
            .map((id) => AGENTS_BY_ID.get(id))
            .filter((a): a is AgentEntry => Boolean(a));
          const query = typeof args.query === "string" ? args.query : "";
          const result = await searchMemory(scopedAgents, {
            query,
            limit: args.limit !== undefined ? Number(args.limit) : undefined,
            collections: Array.isArray(args.collections) ? (args.collections as unknown as string[]) : undefined,
            intent: typeof args.intent === "string" ? args.intent : undefined,
          });
          respond({
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          });
        } else if (name === "get_memory") {
          const scopedAgents = scope.allowedIds
            .map((id) => AGENTS_BY_ID.get(id))
            .filter((a): a is AgentEntry => Boolean(a));
          const file = typeof args.file === "string" ? args.file : "";
          const result = await getMemory(scopedAgents, file);
          respond({
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            ...(result.found ? {} : { isError: true }),
          });
        } else if (name === "list_collections") {
          const scopedAgents = scope.allowedIds
            .map((id) => AGENTS_BY_ID.get(id))
            .filter((a): a is AgentEntry => Boolean(a));
          const collections = listCollections(scopedAgents);
          respond({
            content: [{ type: "text", text: JSON.stringify({ collections }) }],
            structuredContent: { collections },
          });
        } else if (name === "list_tasks") {
          const tasks = listTasks(pool);
          const scoped = tasks.filter((t) => !t.agent || scope.allowedIds.includes(t.agent));
          const view = typeof args.view === "string" ? args.view : undefined;
          const filtered = view === "active" ? scoped.filter((t) => ACTIVE_STATUSES.has(t.status)) : scoped;
          respond({
            content: [{ type: "text", text: JSON.stringify({ tasks: filtered }) }],
            structuredContent: { tasks: filtered },
          });
        } else if (name === "get_task") {
          // get_task NEVER waits (contract decision 6) — getTask() is an
          // immediate, synchronous read, unlike check_task's checkTask().
          const taskId = typeof args.taskId === "string" ? args.taskId : "";
          const detail = typeof args.detail === "string" ? args.detail : undefined;
          const knownLogCount = args.knownLogCount !== undefined ? Number(args.knownLogCount) || 0 : undefined;
          const result = getTask(pool, { jobId: taskId, knownLogCount });

          if (!result.found) {
            respond({
              content: [{ type: "text", text: "Task not found. The server may have restarted." }],
              structuredContent: { taskId, status: "error", error: "Task not found." },
              isError: true,
            });
          } else if (result.snapshot.agent && !scope.allowedIds.includes(result.snapshot.agent)) {
            respond({
              content: [{ type: "text", text: "Task not found." }],
              structuredContent: { taskId, status: "error", error: "Task not found." },
              isError: true,
            });
          } else if (detail === "prompt") {
            // Same per-agent scope authorization as every other field — already
            // enforced above before this branch runs.
            const promptResult = getTaskPrompt(pool, { jobId: taskId });
            if (!promptResult.found) {
              respond({ content: [{ type: "text", text: "Task not found." }], isError: true });
            } else {
              const payload = { taskId, prompt: promptResult.prompt };
              respond({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
            }
          } else {
            const payload = buildGetTaskStructuredContent(result, detail as TaskDetail | undefined);
            respond({
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
              ...(result.isError ? { isError: true } : {}),
            });
          }
        } else if (name === "get_session") {
          const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
          const sessionMode = typeof args.mode === "string" ? args.mode : undefined;
          const limit = args.limit !== undefined ? Number(args.limit) : undefined;
          const after = args.after !== undefined ? Number(args.after) : undefined;
          const sessionAgent = typeof args.agent === "string" && args.agent ? args.agent : undefined;

          if (sessionAgent && !scope.allowedIds.includes(sessionAgent)) {
            respond({
              content: [{ type: "text", text: `Agent "${sessionAgent}" is not available on this connection.` }],
              isError: true,
            });
          } else {
            const result = getSession(pool, { sessionId, mode: sessionMode as any, limit, after, agent: sessionAgent });
            if (!result.found) {
              respond({
                content: [{ type: "text", text: "Session not found." }],
                structuredContent: { sessionId, found: false },
                isError: true,
              });
            } else if (result.agent && !scope.allowedIds.includes(result.agent)) {
              respond({
                content: [{ type: "text", text: "Session not found." }],
                isError: true,
              });
            } else {
              respond({
                content: [{ type: "text", text: JSON.stringify(result) }],
                structuredContent: result,
              });
            }
          }
        } else {
          respondError(-32601, `Unknown tool: ${name}`);
        }
      } else {
        respondError(-32601, `Method not found: ${msg.method}`);
      }

      console.log(`[mcp] -> ${res.statusCode}`);
      return;
    }

    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
    });
    const webRes = await hono.fetch(webReq);

    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const buf = await webRes.arrayBuffer();
    res.end(Buffer.from(buf));
  }

  return { requestListener, pool };
}
