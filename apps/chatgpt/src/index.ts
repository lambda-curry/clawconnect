import "dotenv/config";
import { createServer } from "node:http";

// Process-level safety net: a bug anywhere in a fire-and-forget Promise (e.g.,
// the background long-poll / lazy re-check in SessionManager) would otherwise
// kill the connector via unhandledRejection / uncaughtException. launchd
// kickstarts it back up, but the in-memory jobs map is gone — every active
// run lands at "Task state not found for that session." Log loudly and keep
// the process up. See the f873d89 incident (totalMs ReferenceError took the
// connector down mid-long-poll for an active discovery run).
process.on("unhandledRejection", (reason) => {
  console.error("[connector] unhandledRejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[connector] uncaughtException (kept alive):", err);
});
// import { readFileSync } from "node:fs";  // widget temporarily disabled — see below
// import { join, dirname } from "node:path";
// import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  GatewayPool,
  loadAgentRegistry,
  runTask,
  checkTask,
  listSessions,
  listTasks,
  getSession,
  agentBlurb,
  agentDescriptor,
  searchMemory,
  getMemory,
  listCollections,
} from "@clawconnect/core";
import type { AgentEntry, AgentRegistry, CheckMode, TaskSummary } from "@clawconnect/core";

// Widget UI is temporarily disabled to keep the surface focused on
// run_task / check_task. Re-enable by restoring the widget imports and
// the `resources/list` + `resources/read` handlers below.
// const __dirname = dirname(fileURLToPath(import.meta.url));
// const WIDGET_HTML = readFileSync(join(__dirname, "widget.html"), "utf-8");

const hono = new Hono();

// Try the shared multi-agent registry (~/.clawconnect/agents.json) first.
// Fall back to env-only single-agent so existing deployments keep working.
let registry: AgentRegistry;
try {
  registry = loadAgentRegistry();
  console.log(
    `[chatgpt-app] loaded ${registry.agents.length} agent(s) from ${registry.source} (default=${registry.default}, agents=${registry.agents.map((a) => a.id).join(",")})`,
  );
} catch (err) {
  const url = process.env.OPENCLAW_URL;
  const password = process.env.OPENCLAW_PASSWORD;
  if (!url || !password) {
    console.error(`[chatgpt-app] no registry: ${(err as Error).message}`);
    process.exit(1);
  }
  const singleAgentId = process.env.CLAWCONNECT_AGENT_ALIAS?.trim() || "default";
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID?.trim() || "main";
  registry = {
    default: singleAgentId,
    source: "env",
    agents: [{ id: singleAgentId, url, password, openclawAgentId }],
    groups: {},
    groupLabels: {},
  };
  console.log(`[chatgpt-app] env fallback registry: single agent "${singleAgentId}"`);
}
const pool = new GatewayPool(registry);
const AGENT_IDS = registry.agents.map((a) => a.id);
const AGENT_LIST = AGENT_IDS.join(", ");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

// Widget temporarily disabled — re-enable by uncommenting and the
// resources/list + resources/read handlers below.
// const WIDGET_URI = "ui://widget/openclaw-status.html";
// const WIDGET_ENABLED = process.env.ENABLE_CHATGPT_UI_WIDGET === "true";
const WIDGET_META: Record<string, unknown> = {};

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

  // Server name: a single matched, labelled group names the connector.
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
  // Identified connections don't need the model to guess who it's talking to —
  // the server stamps the token's name on every task and ignores senderName.
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

The actual result is what the user wants — not the jobId. After calling run_task, immediately call check_task with mode="wait" in a loop, passing the same jobId, until status is no longer "running". Then report the real outcome (summary, files changed, errors, etc.) to the user. A typical short task takes 30s–3min and needs 1–5 check_task calls.

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
      annotations: {
        title: "Run Task",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ...WIDGET_META,
        "openai/toolInvocation/invoking": "Sending task to OpenClaw agent...",
      },
    },
    {
      name: "check_task",
      description: `Check whether a previously dispatched run_task job has finished, and collect the result.

With mode="wait" (recommended): blocks up to 50 seconds and only returns on a terminal status (completed / completed_no_summary / error) or timeout. Call repeatedly with the same jobId until status is no longer "running" — that's how you get the actual answer.

With mode="poll": returns as soon as any new log activity appears. Use this only when you need intermediate progress (live UI), not when you just want the final result.

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
            description: "Number of log entries already seen. Server returns as soon as new entries appear.",
          },
          mode: {
            type: "string",
            enum: ["poll", "wait"],
            description: 'Polling mode: "wait" (default) blocks up to 50s and only returns on a terminal status — use this when you want the result. "poll" returns on any new log activity — use for live progress UIs.',
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
    },
    {
      name: "get_task",
      description: `Inspect a task by taskId/jobId with a detail preset controlling which fields are returned.`,
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task identifier (same as jobId in v1)" },
          detail: {
            type: "string",
            enum: ["core", "summary", "updates", "artifacts", "diagnostics", "full", "fullWithDiagnostics"],
            description:
              'Detail preset. Omit for summary. core=ids+status only; summary=+summary; updates=+logs; artifacts=+artifacts; diagnostics=+error info; full=core+summary+updates+artifacts; fullWithDiagnostics=full+diagnostics',
          },
          mode: {
            type: "string",
            enum: ["poll", "wait"],
            description: 'Uses check semantics: "wait" blocks up to timeout; "poll" returns on updates',
          },
        },
        required: ["taskId"],
      },
      annotations: { title: "Get Task", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_session",
      description: `Inspect one session for debugging ("what exactly happened?"). Use mode="snapshot" for current state, "events" for bounded event retrieval, or "tail" for cursor-based tailing.`,
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session key to inspect" },
          mode: {
            type: "string",
            enum: ["snapshot", "events", "tail"],
            description: "Inspection mode: snapshot (default), events, or tail",
          },
          limit: { type: "number", description: "Max events to return for events/tail modes (1–200)" },
          after: { type: "number", description: "Zero-based event cursor; for tail mode use returned nextAfter" },
          agent: { ...agentProp, description: `${agentProp.description} Usually inferred from sessionId.` },
        },
        required: ["sessionId"],
      },
      annotations: { title: "Get Session", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
 */
const USER_TOKENS = new Map<string, string>();
for (const pair of (process.env.MCP_USER_TOKENS ?? "").split(",")) {
  const trimmed = pair.trim();
  if (!trimmed) continue;
  const sep = trimmed.indexOf(":");
  const name = sep > 0 ? trimmed.slice(0, sep).trim() : "";
  const token = sep > 0 ? trimmed.slice(sep + 1).trim() : "";
  if (!name || !token) {
    console.warn(`[mcp] MCP_USER_TOKENS entry "${trimmed.slice(0, 16)}…" is not "Name:token" — skipped`);
    continue;
  }
  if (USER_TOKENS.has(token)) {
    console.warn(`[mcp] MCP_USER_TOKENS: duplicate token for "${name}" collides with "${USER_TOKENS.get(token)}" — skipped`);
    continue;
  }
  USER_TOKENS.set(token, name);
}
if (USER_TOKENS.size > 0) {
  console.log(`[mcp] personal tokens loaded for: ${[...USER_TOKENS.values()].join(", ")}`);
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
  if (!PUBLIC_MCP_PASS && USER_TOKENS.size === 0) return { user: null }; // no gate configured (legacy open mode)
  const fromQuery = url.searchParams.get("pass");
  const auth = req.headers.authorization ?? (req.headers["authorization"] as string | undefined);
  const fromHeader = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  for (const supplied of [fromQuery, fromHeader]) {
    if (!supplied) continue;
    const name = USER_TOKENS.get(supplied);
    if (name) return { user: name };
    if (PUBLIC_MCP_PASS && supplied === PUBLIC_MCP_PASS) return { user: null, legacy: true };
  }
  return null;
}

const server = createServer(async (req, res) => {
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
      respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
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
      // Widget disabled — return no resources.
      respond({ resources: [] });
    // } else if (msg.method === "resources/read") {
    //   const uri = (msg.params as { uri?: string })?.uri;
    //   if (uri === WIDGET_URI) {
    //     respond({
    //       contents: [
    //         {
    //           uri: WIDGET_URI,
    //           mimeType: "text/html;profile=mcp-app",
    //           text: WIDGET_HTML,
    //           _meta: {
    //             ui: { borders: "square", domains: ["*"] },
    //           },
    //         },
    //       ],
    //     });
    //   } else {
    //     respondError(-32602, `Unknown resource: ${uri}`);
    //   }
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
          const entry = pool.forJob(result.jobId)!;
          const snapshot = entry.sessions.buildSnapshot(entry.sessions.getJob(result.jobId)!);
          const submittedText = `Task submitted to ${result.agent}. Job ID: ${result.jobId}`;
          respond({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: result.jobId,
                  taskId: result.taskId,
                  sessionKey: result.sessionKey,
                  status: result.status,
                  agent: result.agent,
                  message: "Task submitted. Use check_task to poll for progress.",
                }) + (identity.legacy ? `\n\nNote: ${GET_TOKEN_HINT}` : ""),
              },
            ],
            structuredContent: { ...snapshot, agent: result.agent },
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
            structuredContent: snapshot,
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
        const taskId = typeof args.taskId === "string" ? args.taskId : "";
        const detail = typeof args.detail === "string" ? args.detail : undefined;
        const mode = (typeof args.mode === "string" ? args.mode : undefined) as CheckMode | undefined;
        const result = await checkTask(pool, { jobId: taskId, mode: mode ?? "wait" });

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
        } else {
          const s = result.snapshot;
          const d = detail ?? "summary";
          const has = (field: string) => d === field || d === "full" || d === "fullWithDiagnostics";
          const payload: Record<string, unknown> = {
            taskId: s.jobId,
            jobId: s.jobId,
            sessionKey: s.sessionKey,
            agent: s.agent,
            status: s.status,
            startedAt: s.startedAt,
            lastEventAt: s.lastEventAt,
            recovery: s.recovery,
          };
          if (d === "summary" || has("summary")) {
            payload.summary = s.summary;
          }
          if (has("updates")) {
            payload.updates = s.logs;
          }
          if (has("artifacts")) {
            payload.artifacts = s.artifacts;
          }
          if (d === "diagnostics" || d === "fullWithDiagnostics") {
            payload.diagnostics = { error: s.error, errorInfo: s.errorInfo, recovery: s.recovery, continuationState: s.continuationState };
          }
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
});

const port = Number(process.env.PORT || 7331);
server.timeout = 0;
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
