import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { GatewayPool, loadAgentRegistry, runTask, checkTask, listSessions } from "@clawconnect/core";
import type { AgentRegistry, CheckMode } from "@clawconnect/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_HTML = readFileSync(join(__dirname, "widget.html"), "utf-8");

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

const WIDGET_URI = "ui://widget/openclaw-status.html";
const WIDGET_ENABLED = process.env.ENABLE_CHATGPT_UI_WIDGET === "true";

const WIDGET_META = WIDGET_ENABLED
  ? { ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI }
  : {};

const AGENT_PROP = {
  type: "string" as const,
  enum: AGENT_IDS,
  description: `OpenClaw agent to dispatch to. Configured agents: ${AGENT_LIST}. Default: ${registry.default}.`,
};

const TOOLS = [
  {
    name: "run_task",
    description: `Submit a task to an OpenClaw agent. Returns quickly with a jobId and sessionKey. Use check_task to poll for progress. Pass sessionKey from a previous result to continue the same thread. Available agents: ${AGENT_LIST}.`,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to perform" },
        agent: AGENT_PROP,
        context: { type: "string", description: "Optional context for the task" },
        sessionKey: {
          type: "string",
          description: "Session key from a previous call to continue the same thread. Omit to start a new thread.",
        },
      },
      required: ["task"],
    },
    annotations: {
      title: "Run Task",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    _meta: {
      ...WIDGET_META,
      "openai/toolInvocation/invoking": "Sending task to OpenClaw agent...",
    },
  },
  {
    name: "check_task",
    description: `Check the status of a previously submitted task. Waits up to 50 seconds for completion before returning. Poll with jobId. Available agents: ${AGENT_LIST}.`,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The jobId returned by run_task" },
        sessionKey: {
          type: "string",
          description: "Optional session key for reattaching status checks after refresh.",
        },
        agent: {
          ...AGENT_PROP,
          description: `${AGENT_PROP.description} Usually inferred from jobId; set explicitly if you started run_task elsewhere.`,
        },
        knownLogCount: {
          type: "number",
          description: "Number of log entries already seen. Server returns as soon as new entries appear.",
        },
        mode: {
          type: "string",
          enum: ["poll", "wait"],
          description: 'Polling mode: "poll" returns on new logs (default for ChatGPT widget), "wait" blocks until completion.',
        },
      },
    },
    annotations: {
      title: "Check Task Status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_sessions",
    description: `List active OpenClaw sessions across configured agents. Available agents: ${AGENT_LIST}.`,
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "List Sessions",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

hono.get("/", (c) => c.text("OK"));
hono.get("/health", (c) => c.json({ ok: true }));

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp")) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

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
        serverInfo: { name: "ClawConnect", version: "0.1.0" },
      });
    } else if (isNotification) {
      res.writeHead(202);
      res.end();
    } else if (msg.method === "tools/list") {
      respond({ tools: TOOLS });
    } else if (msg.method === "resources/list") {
      respond({
        resources: WIDGET_ENABLED
          ? [{ uri: WIDGET_URI, name: "OpenClaw Status Widget", mimeType: "text/html;profile=mcp-app" }]
          : [],
      });
    } else if (msg.method === "resources/read") {
      const uri = (msg.params as { uri?: string })?.uri;
      if (uri === WIDGET_URI) {
        respond({
          contents: [
            {
              uri: WIDGET_URI,
              mimeType: "text/html;profile=mcp-app",
              text: WIDGET_HTML,
              _meta: {
                ui: {
                  borders: "square",
                  domains: ["*"],
                },
              },
            },
          ],
        });
      } else {
        respondError(-32602, `Unknown resource: ${uri}`);
      }
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, string> };

      if (name === "run_task") {
        try {
          const result = runTask(pool, {
            task: args.task,
            agent: typeof args.agent === "string" ? args.agent : undefined,
            context: args.context,
            sessionKey: args.sessionKey,
          });
          console.log(`[mcp] submitted job ${result.jobId} on agent ${result.agent} session ${result.sessionKey}`);
          const entry = pool.forJob(result.jobId)!;
          const snapshot = entry.sessions.buildSnapshot(entry.sessions.getJob(result.jobId)!);
          respond({
            content: [{ type: "text", text: `Task submitted to ${result.agent}. Job ID: ${result.jobId}` }],
            structuredContent: { ...snapshot, agent: result.agent },
          });
        } catch (err) {
          respond({
            content: [{ type: "text", text: `Failed to submit: ${(err as Error).message}` }],
            isError: true,
          });
        }
      } else if (name === "check_task") {
        const mode = (args.mode as CheckMode) ?? "poll";
        const result = await checkTask(pool, {
          jobId: typeof args.jobId === "string" ? args.jobId : undefined,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          agent: typeof args.agent === "string" ? args.agent : undefined,
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
        } else {
          const { snapshot, isTerminal, isError } = result;
          respond({
            content: [
              {
                type: "text",
                text: isTerminal ? (snapshot.summary ?? snapshot.error ?? "") : "Still running. Poll again.",
              },
            ],
            structuredContent: snapshot,
            ...(isError ? { isError: true } : {}),
          });
        }
      } else if (name === "list_sessions") {
        const sessions = listSessions(pool);
        const summary = sessions.length === 0
          ? "No active sessions."
          : sessions.map((s) => `${s.agent ?? "?"}: ${s.sessionKey.slice(-12)} (${s.lastJobId.slice(0, 8)})`).join("\n");
        respond({
          content: [{ type: "text", text: summary }],
          structuredContent: { sessions, configuredAgents: AGENT_IDS },
        });
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
