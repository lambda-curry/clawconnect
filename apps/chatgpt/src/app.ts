import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { McpServer, createMcpHandler, isJsonContentType } from "@modelcontextprotocol/server";
import type { AuthInfo, McpRequestContext } from "@modelcontextprotocol/server";
import { toWebRequest } from "@modelcontextprotocol/node";
import { GatewayPool, LocalTmuxFleetAdapter, buildCapabilities } from "@clawconnect/core";
import { registerCapability } from "@clawconnect/mcp";
import type {
  AgentRegistry,
  AgentSessionRuntimeRegistry,
  ContinuationState,
  FleetAdapter,
  Identity,
  JobSnapshot,
  Scope,
} from "@clawconnect/core";
import { blockedDelegation, blockedDelegationNotice } from "@clawconnect/core";
import {
  buildExtensionsCapability,
  buildMountMeta,
  buildAppCallableMeta,
  UI_RESOURCE_MIME_TYPE,
} from "./ui-meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/build-widget.mjs always writes to <package root>/dist/widget.html.
// Resolving via "../dist" (not the running module's own directory) finds it
// correctly whether this module is running compiled (dist/app.js, so
// __dirname already is dist/) or via `tsx watch src/index.ts` in dev.
const DEFAULT_WIDGET_HTML_PATH = join(__dirname, "..", "dist", "widget.html");
/** Versioned so a shape change bumps the URI rather than serving a stale cached resource under the same id. */
const WIDGET_URI = "ui://clawconnect/task-center-v1.html";
// One JSON file per agent (see GatewayPool/JsonFileJobStore) — outside dist/
// and src/ so a build never touches it.
const DEFAULT_JOB_STORE_DIR = join(__dirname, "..", ".job-store");

export interface CreateAppOptions {
  /** Path to the built, self-contained widget HTML. Overridable so tests don't depend on a real build having run. */
  widgetHtmlPath?: string;
  /** Directory for per-agent job-persistence files. Defaults on — override so tests write into a scratch dir. */
  jobStoreDir?: string;
  /**
   * Fleet-transcript recovery adapter. Defaults to a real LocalTmuxFleetAdapter
   * so recovery tier 3 is actually reachable in production. Override in tests
   * to inject a fake and assert on wiring.
   */
  fleetAdapter?: FleetAdapter;
  /**
   * Managed-agent-session runtimes this deployment can drive (see
   * agent-session.ts). Omitted, claude-fleet stays the only reachable runtime
   * and an attachment naming any other reads back as a precise
   * unknown_runtime result rather than failing the task.
   */
  agentSessionRuntimes?: AgentSessionRuntimeRegistry;
}

export interface App {
  requestListener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  pool: GatewayPool;
}

/**
 * Model-facing text for a check_task response.
 *
 * While running, the text carries `logCursor` — not just structuredContent.
 * A client reading only `content` still has to hand that value back verbatim
 * as `knownLogCount`, and counting the entries it received would be wrong
 * (the log window is a bounded projection). Split out as a pure function so
 * this is testable without a live gateway keeping a job in "running".
 */
export function checkTaskText(snapshot: JobSnapshot, isTerminal: boolean): string {
  if (isTerminal) {
    // A blocked delegation is terminal for the job and unfinished for the
    // user; the notice leads, so it cannot be missed behind a summary that
    // says nothing (see blockedDelegationNotice).
    const blocked = blockedDelegationNotice(snapshot);
    const summary = snapshot.summary ?? snapshot.error ?? "";
    if (!blocked) return summary;
    return summary && summary !== blocked ? `${blocked}\n\n${summary}` : blocked;
  }
  // A running turn whose delegated session is already waiting on a human.
  // "Still running. Poll again." is true and useless here — polling is exactly
  // what will not move it — so the notice leads instead.
  const blocked = blockedDelegation(snapshot);
  const resume = `Poll again with knownLogCount=${snapshot.logCursor}.`;
  if (blocked) return `${blocked.notice} ${resume}`;
  return snapshot.recovery ? `Recovering late transcript final text. ${resume}` : `Still running. ${resume}`;
}

/**
 * Builds the ChatGPT HTTP MCP surface for a given agent registry, with no
 * side effects (no listen(), no registry loading).
 *
 * This app declares no tools. It projects core's capability registry, which
 * is the same array the stdio transport serves — so a description, a schema,
 * or an authorization rule cannot be right on one transport and wrong on the
 * other. What remains here is genuinely HTTP-shaped: credentials, per-URL
 * agent scoping, CORS, the widget resource, and the terse model-facing text a
 * UI client wants in place of the stdio transport's verbose polling payload.
 *
 * Both protocol eras are served by the SDK from one factory. The ~450-line
 * hand-rolled 2025-era JSON-RPC router this file used to carry is gone:
 * `createMcpHandler` defaults to `legacy: 'stateless'`, answering each 2025
 * request from a fresh instance of the same factory. Deleting it removed the
 * duplicate tool declarations and the duplicate authorization checks that
 * came with it, and version negotiation now belongs to the SDK rather than to
 * a hand-maintained list of supported revisions.
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
      // A missing/broken widget resource must never take down the connector —
      // run_task/check_task correctness does not depend on this file existing.
      console.error(
        `[chatgpt-app] failed to load widget resource from ${widgetHtmlPath}: ${(err as Error).message}`,
      );
      cachedWidgetHtml = undefined;
    }
    return cachedWidgetHtml;
  }

  const hono = new Hono();
  const fleetAdapter = opts.fleetAdapter ?? new LocalTmuxFleetAdapter();
  const pool = new GatewayPool(
    registry,
    opts.jobStoreDir ?? DEFAULT_JOB_STORE_DIR,
    fleetAdapter,
    undefined,
    opts.agentSessionRuntimes,
  );
  // Reload every configured agent's persisted jobs now, not lazily on first
  // request — otherwise an agent nobody has queried yet since the restart
  // would leave its in-flight jobs unrecovered indefinitely.
  pool.warmAll();
  const AGENT_IDS = registry.agents.map((a) => a.id);

  const BASE_ALLOWED_REQUEST_HEADERS = [
    "Content-Type",
    "Authorization",
    "Mcp-Session-Id",
    "MCP-Protocol-Version",
    "Mcp-Method",
    "Mcp-Name",
  ];
  const ALLOWED_PREFLIGHT_HEADER =
    /^(?:content-type|authorization|mcp-session-id|mcp-protocol-version|mcp-method|mcp-name|mcp-param-[a-z0-9_-]+)$/i;

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const requestedHeaders = String(req.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((header) => header.trim())
      .filter((header) => ALLOWED_PREFLIGHT_HEADER.test(header));

    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": [
        ...new Set([...BASE_ALLOWED_REQUEST_HEADERS, ...requestedHeaders]),
      ].join(", "),
      "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    };
  }

  /**
   * Per-request agent scope. A connection can narrow which agents it sees with:
   *   ?group=lc-labs            — a named group from agents.json (stable URL;
   *                               membership edited server-side, no re-paste)
   *   ?agents=assistant,helper  — an explicit list (ad-hoc scoping)
   *   ?agent=assistant          — single-agent shorthand
   * `group` and `agents` can be combined and/or repeated — the result is the
   * union. Unknown agent ids and unknown group names are dropped with a
   * warning. If the filter resolves to zero agents, we fall back to all
   * configured agents (so a typo doesn't hand the caller an empty enum).
   *
   * `serverName` is the MCP serverInfo.name to report: when the connection is
   * scoped to exactly one labelled group, it's that group's label so multiple
   * connectors on the same client are distinguishable.
   */
  const DEFAULT_SERVER_NAME = "ClawConnect";

  function resolveScope(url: URL): Scope {
    const csv = (vals: string[]) =>
      vals
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean);

    const groupNames = csv(url.searchParams.getAll("group"));
    const explicitAgents = csv(
      url.searchParams.getAll("agents").concat(url.searchParams.getAll("agent")),
    );

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
        console.warn(
          `[mcp] unknown group "${g}" — ignored (known groups: ${Object.keys(registry.groups).join(", ") || "none"})`,
        );
        continue;
      }
      for (const id of members) if (!wanted.includes(id)) wanted.push(id);
    }
    for (const id of explicitAgents) if (!wanted.includes(id)) wanted.push(id);

    const allowed = wanted.filter((id) => AGENT_IDS.includes(id));
    if (allowed.length === 0) {
      console.warn(
        `[mcp] scope (groups=${JSON.stringify(groupNames)}, agents=${JSON.stringify(explicitAgents)}) resolved to no known agents — falling back to all`,
      );
      return { allowedIds: AGENT_IDS, defaultId: registry.default, serverName };
    }
    const defaultId = allowed.includes(registry.default) ? registry.default : allowed[0];
    return { allowedIds: allowed, defaultId, serverName };
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  const PUBLIC_MCP_PASS = process.env.PUBLIC_MCP_PASS ?? "";

  /**
   * Personal tokens: MCP_USER_TOKENS="Name:tok1,Other:tok2,...". A personal
   * token both authenticates the request and identifies the person — identity
   * derives from the credential, not from a spoofable query param — so the
   * server can stamp the sender on every dispatched task and a single
   * person's token can be revoked without rotating everyone.
   *
   * PUBLIC_MCP_PASS (the legacy shared pass) keeps working but resolves to an
   * anonymous identity; those connections get a nudge to switch to a personal
   * token so agents know who they're working with.
   *
   * MCP_USER_TOKENS_FILE can point at a runtime-editable JSON file for adding
   * or revoking tokens without restarting the process. Supported shapes:
   *   { "Name": "tok1", "Other": "tok2" }
   *   { "tokens": { "Name": "tok1" } }
   *   [{ "name": "Name", "token": "tok1" }]
   */
  const MCP_USER_TOKENS_FILE = process.env.MCP_USER_TOKENS_FILE?.trim();

  function addToken(target: Map<string, string>, name: string, token: string, source: string) {
    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName || !cleanToken) return;
    if (target.has(cleanToken)) {
      console.warn(
        `[mcp] ${source}: duplicate token for "${cleanName}" collides with "${target.get(cleanToken)}" — skipped`,
      );
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
        console.warn(
          `[mcp] ${source} entry "${trimmed.slice(0, 16)}..." is not "Name:token" — skipped`,
        );
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
        if (typeof name === "string" && typeof token === "string")
          addToken(tokens, name, token, source);
      }
      return tokens;
    }
    if (!parsed || typeof parsed !== "object") return tokens;
    const obj = parsed as Record<string, unknown>;
    const record =
      obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)
        ? (obj.tokens as Record<string, unknown>)
        : obj;
    for (const [name, token] of Object.entries(record)) {
      if (typeof token === "string") addToken(tokens, name, token, source);
    }
    return tokens;
  }

  const ENV_USER_TOKENS = parseTokenCsv(process.env.MCP_USER_TOKENS, "MCP_USER_TOKENS");
  if (ENV_USER_TOKENS.size > 0) {
    console.log(
      `[mcp] env personal tokens loaded for: ${[...ENV_USER_TOKENS.values()].join(", ")}`,
    );
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
      fileTokenCache = parseTokenJson(
        readFileSync(MCP_USER_TOKENS_FILE, "utf8"),
        MCP_USER_TOKENS_FILE,
      );
      fileTokenMtimeMs = mtimeMs;
      console.log(
        `[mcp] runtime personal tokens loaded for: ${[...fileTokenCache.values()].join(", ") || "(none)"}`,
      );
    } catch (err) {
      console.warn(
        `[mcp] failed to read token file ${MCP_USER_TOKENS_FILE}: ${(err as Error).message}`,
      );
    }
    return fileTokenCache;
  }

  function getUserTokens(): Map<string, string> {
    const merged = new Map(ENV_USER_TOKENS);
    for (const [token, name] of loadFileTokens())
      addToken(merged, name, token, MCP_USER_TOKENS_FILE ?? "token file");
    return merged;
  }

  /**
   * Resolve the caller's identity from the supplied credential (?pass=<v> or
   * Authorization: Bearer <v>). Returns:
   *   { user: "<name>" }                — personal token matched
   *   { user: null, legacy: true }      — legacy shared pass matched
   *   { user: null }                    — no auth configured at all (open mode)
   *   null                              — credential missing or wrong → 403
   */
  function resolveIdentity(url: URL, req: IncomingMessage): Identity | null {
    const userTokens = getUserTokens();
    if (!PUBLIC_MCP_PASS && userTokens.size === 0) return { user: null }; // no gate configured
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

  function authInfoFor(identity: Identity): AuthInfo {
    return {
      // Authentication is complete before the SDK entry runs. Do not copy a
      // caller's bearer secret into handler context.
      token: "validated-by-clawconnect",
      clientId: identity.user ?? (identity.legacy ? "legacy-shared-token" : "anonymous"),
      scopes: [],
      extra: { identity },
    };
  }

  // ── Model-facing text (UI-client flavour) ─────────────────────────────────

  /**
   * ChatGPT renders a progress card, so its text stays one line while a task
   * runs and becomes the summary when it finishes — the opposite of the stdio
   * transport, whose agentic client wants the whole polling payload. Both read
   * the SAME structuredContent; only this rendering differs.
   */
  const CHATGPT_TEXT: Record<string, (sc: unknown) => string | undefined> = {
    check_task: (sc) => {
      if (!sc || typeof sc !== "object") return undefined;
      const { isTerminal, ...snapshot } = sc as Record<string, unknown>;
      if (typeof isTerminal !== "boolean") return undefined;
      return checkTaskText(snapshot as unknown as JobSnapshot, isTerminal);
    },
    list_sessions: (sc) => {
      const sessions = (sc as { sessions?: ContinuationState[] } | undefined)?.sessions;
      if (!sessions) return undefined;
      return sessions.length === 0
        ? "No sessions known to this connector yet."
        : sessions
            .map((s) => `${s.agent ?? "?"}: ${s.sessionKey.slice(-12)} (${s.lastJobId.slice(0, 8)})`)
            .join("\n");
    },
  };

  /** Widget-facing _meta, by capability. run_task mounts the card; the rest are only app-callable. */
  const TOOL_META: Record<string, Record<string, unknown>> = {
    run_task: {
      ...buildMountMeta(WIDGET_ENABLED, WIDGET_URI),
      "openai/toolInvocation/invoking": "Sending task to OpenClaw agent...",
    },
    get_task: buildAppCallableMeta(WIDGET_ENABLED),
    list_tasks: buildAppCallableMeta(WIDGET_ENABLED),
    get_session: buildAppCallableMeta(WIDGET_ENABLED),
  };

  // ── The one server factory, serving both eras ─────────────────────────────

  function createHttpMcpServer(ctx: McpRequestContext): McpServer {
    const requestUrl = ctx.requestInfo ? new URL(ctx.requestInfo.url) : new URL("http://localhost/mcp");
    const scope = resolveScope(requestUrl);
    const identity = (ctx.authInfo?.extra?.identity as Identity | undefined) ?? { user: null };
    const extensions = buildExtensionsCapability(WIDGET_ENABLED);

    const server = new McpServer(
      {
        name: identity.user ? `${scope.serverName} (${identity.user})` : scope.serverName,
        version: "0.1.0",
      },
      {
        capabilities: { resources: {}, ...(extensions ? { extensions: extensions as never } : {}) },
        instructions:
          "Use run_task to delegate work, then check_task until continuePolling is false.",
      },
    );

    const capabilities = buildCapabilities({
      pool,
      registry,
      scope,
      identity,
      // "poll" so a live progress card advances on any new activity, rather
      // than only when the whole turn finishes.
      defaultCheckMode: "poll",
      protocol: () => ({
        // The SDK's own classification of this serving unit — not a guess.
        era: ctx.era,
        // 2025-era clients MUST send this header after initialize, so when it
        // is there it is the negotiated revision. When it is not, we say
        // nothing rather than substituting a constant.
        ...(ctx.era === "modern"
          ? { version: "2026-07-28" }
          : (() => {
              const header = ctx.requestInfo?.headers.get("MCP-Protocol-Version") ?? undefined;
              return header ? { version: header } : {};
            })()),
      }),
    });

    for (const capability of capabilities) {
      const meta = TOOL_META[capability.name];
      registerCapability(server, capability, {
        ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
        renderText: CHATGPT_TEXT[capability.name],
      });
    }

    if (WIDGET_ENABLED) {
      server.registerResource(
        "ClawConnect Task Center",
        WIDGET_URI,
        { mimeType: UI_RESOURCE_MIME_TYPE },
        async () => {
          const html = loadWidgetHtml();
          if (html === undefined)
            throw new Error("Widget resource failed to load — run_task/check_task are unaffected.");
          return { contents: [{ uri: WIDGET_URI, mimeType: UI_RESOURCE_MIME_TYPE, text: html }] };
        },
      );
    }
    return server;
  }

  // `legacy` is left at its default of 'stateless', so 2025-era requests are
  // answered from a fresh instance of the same factory. That is what lets the
  // hand-rolled legacy router be deleted without dropping the clients still
  // negotiating that era.
  const mcpHandler = createMcpHandler(createHttpMcpServer, {
    onerror: (error) => console.error("[mcp] serving error:", error),
  });

  hono.get("/", (c) => c.text("OK"));
  hono.get("/health", (c) => c.json({ ok: true }));

  async function requestListener(req: IncomingMessage, res: ServerResponse) {
    if (req.url?.startsWith("/mcp")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      Object.entries(corsHeaders(req)).forEach(([k, v]) => res.setHeader(k, v));

      const reqUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

      // Auth gate — reject /mcp requests without a valid personal token or the
      // legacy shared pass, before anything reaches the SDK.
      const identity = resolveIdentity(reqUrl, req);
      if (!identity) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: "Forbidden: token required via ?pass= or Authorization: Bearer",
            },
          }),
        );
        return;
      }

      if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unsupported Media Type: expected application/json" },
          }),
        );
        return;
      }

      const requestAbort = new AbortController();
      req.once("aborted", () => requestAbort.abort());
      res.once("close", () => requestAbort.abort());
      const webRequest = await toWebRequest(req, undefined, { signal: requestAbort.signal });

      console.log(`[mcp] ${req.method} method=${String(req.headers["mcp-method"] ?? "unknown")}`);

      const webResponse = await mcpHandler.fetch(webRequest, { authInfo: authInfoFor(identity) });
      const headers = Object.fromEntries(webResponse.headers.entries());
      res.writeHead(webResponse.status, { ...corsHeaders(req), ...headers });
      if (webResponse.body) {
        for await (const chunk of webResponse.body) res.write(chunk);
      }
      res.end();
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
