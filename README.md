# ClawConnect

MCP server and CLI for connecting AI coding agents to [OpenClaw](https://github.com/lambda-curry/openclaw) instances. Submit tasks, poll for progress, and continue conversations — all through the MCP protocol.

> **Use at your own risk.** This software is provided as-is under the [MIT License](LICENSE). ClawConnect connects to your OpenClaw instance using credentials you provide — **you are responsible for securing your `OPENCLAW_PASSWORD` and `OPENCLAW_URL`**. Treat these like any other secret: never commit them to version control, restrict network access to your OpenClaw instance, and rotate credentials regularly. The authors are not liable for any damages, data loss, or security incidents arising from the use of this software.

## Packages

| Package | Description |
|---------|-------------|
| `packages/core` | Shared gateway, session management, and tool handlers |
| `packages/mcp` | MCP server (stdio transport) |
| `packages/cli` | CLI (`clawconnect`) |
| `apps/chatgpt` | ChatGPT MCP app (HTTP transport + widget) |

## Quick Start

```bash
git clone git@github.com:lambda-curry/clawconnect.git
cd clawconnect
pnpm install
pnpm run ready
```

## MCP Tools

The core, unversioned task-contract surface — same names and behavior across every client (Claude Code, Cursor, Codex, ChatGPT, the CLI); see `docs/decisions/2026-07-27-task-contract.md` and `docs/architecture/2026-07-27-multi-client-compatibility.md` for the accepted contract and the implementation boundaries behind it:

- **`run_task`** — Submit a task to your OpenClaw agent. Returns `jobId`/`taskId`, `sessionKey`, status, and a structured `nextAction` (`{tool: "check_task", args: {...}}`) telling the caller exactly what to call next.
- **`check_task`** — The only tool that waits. Blocks server-side for up to `waitMs` (default **45000ms**, override per call, clamped to `[1000, 120000]` — out-of-range values clamp rather than error) and returns early on a terminal status (`completed` / `completed_no_summary` / `error`). A timeout return is **not** an error and **not** terminal: `continuePolling` is `true`, `nextAction` says to call `check_task` again with the same `jobId` — never submit a new `run_task` because a poll timed out (the session-busy guard would refuse it as a duplicate anyway). `mode: "poll"` (also bounded by `waitMs`) returns as soon as any new log activity appears, for live-progress use cases distinct from "give me the final result".
- **`get_task`** — An **immediate, non-waiting** snapshot for diagnostics, manual reads, or UI refresh — including `status: "running"` if that's the current truth. Never blocks, unlike `check_task`. `detail` controls which fields come back (`core`/`summary`/`updates`/`artifacts`/`diagnostics`/`full`/`fullWithDiagnostics`), plus `detail: "prompt"` to retrieve the original submitted `{task, context, senderName}` — not included at any other detail level, so it never appears in a normal response by accident.
- **`list_tasks`** — Aggregate, immediate view of tasks across agents; `view: "active"` filters to non-terminal ones.
- **`get_session`** — Debug-level inspection of one session: `snapshot` (default), `events` (bounded slice), or `tail` (cursor-based pagination via `after`/`nextAfter`).
- **`list_sessions`** / **`list_agents`** / **`search_memory`** / **`get_memory`** / **`list_collections`** — session/agent listing and QMD memory search, independent of the task lifecycle above.

MCP tool annotations (`readOnlyHint`, `idempotentHint`, etc.) classify intent per the MCP spec — they are hints for client UX, not behavioral guarantees.

### Polling

| Mode | Behavior | Best for |
|------|----------|----------|
| `check_task` `mode: "wait"` (default) | Blocks up to `waitMs` (default 45s) and returns early only on a terminal status | AI agents (Claude Code, Codex) — minimizes round-trips, `continuePolling`/`nextAction` make the loop machine-readable |
| `check_task` `mode: "poll"` | Returns as soon as any new log activity occurs (still bounded by `waitMs`) | Live-progress consumers that want intermediate updates, not just the final result |
| `get_task` | Never waits — immediate snapshot of whatever state exists right now | Diagnostics, manual reads, UI refresh — read-only, no polling loop implied |

A typical 3-minute task with `check_task mode: "wait"` at the 45s default needs a handful of calls (1 `run_task` + a few `check_task` calls).

## Configuration

The MCP server reads three environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCLAW_URL` | Yes | WebSocket URL for your OpenClaw instance (e.g., `ws://127.0.0.1:18789`) |
| `OPENCLAW_PASSWORD` | Yes | OpenClaw gateway password |
| `OPENCLAW_AGENT_ID` | No | Agent name to connect to (default: `main`) |

## Setup

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "clawconnect": {
      "command": "node",
      "args": ["/path/to/clawconnect/packages/mcp/dist/bin.mjs"],
      "env": {
        "OPENCLAW_URL": "ws://YOUR_OPENCLAW_HOST:18789",
        "OPENCLAW_PASSWORD": "your-openclaw-password",
        "OPENCLAW_AGENT_ID": "your-agent-name"
      }
    }
  }
}
```

Restart Claude Code to pick up the new MCP server.

### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "clawconnect": {
      "command": "node",
      "args": ["/path/to/clawconnect/packages/mcp/dist/bin.mjs"],
      "env": {
        "OPENCLAW_URL": "ws://YOUR_OPENCLAW_HOST:18789",
        "OPENCLAW_PASSWORD": "your-openclaw-password",
        "OPENCLAW_AGENT_ID": "your-agent-name"
      }
    }
  }
}
```

Restart Cursor after adding the config.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.clawconnect]
command = "node"
args = ["/path/to/clawconnect/packages/mcp/dist/bin.mjs"]
env = { OPENCLAW_URL = "ws://YOUR_OPENCLAW_HOST:18789", OPENCLAW_PASSWORD = "your-openclaw-password", OPENCLAW_AGENT_ID = "your-agent-name" }
tool_timeout_sec = 60.0
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "clawconnect": {
      "command": "node",
      "args": ["/path/to/clawconnect/packages/mcp/dist/bin.mjs"],
      "env": {
        "OPENCLAW_URL": "ws://YOUR_OPENCLAW_HOST:18789",
        "OPENCLAW_PASSWORD": "your-openclaw-password",
        "OPENCLAW_AGENT_ID": "your-agent-name"
      }
    }
  }
}
```

### ChatGPT (Advanced)

The ChatGPT integration runs as an HTTP MCP server with an optional live progress widget. It requires ChatGPT's **Developer Mode** and a publicly reachable URL.

#### Prerequisites

- ChatGPT Plus/Pro/Team account with **Developer Mode** enabled
- A way to expose the server publicly (e.g., [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), ngrok, Cloudflare Tunnel, or a VPS)

#### 1. Enable Developer Mode in ChatGPT

1. Open ChatGPT → **Settings** → **Developer** (or **Beta features**)
2. Toggle **Developer Mode** on
3. You should now see an **MCP Servers** section under Settings → Developer

#### 2. Configure and run the server

```bash
cd apps/chatgpt
cp .env.example .env
```

Edit `.env` with your values:

```env
PORT=7331
OPENCLAW_URL=ws://YOUR_OPENCLAW_HOST:18789
OPENCLAW_PASSWORD=your-openclaw-password
OPENCLAW_AGENT_ID=main
ENABLE_CHATGPT_UI_WIDGET=true   # optional: enables a live progress widget in ChatGPT
```

Then start the server:

```bash
pnpm run dev    # development with hot reload
# or
pnpm run build && pnpm run start   # production
```

#### 3. Expose the server

ChatGPT needs a publicly reachable HTTPS URL. Example with Tailscale Funnel:

```bash
tailscale funnel 7331
```

This gives you a URL like `https://your-machine.tail1234.ts.net:443`.

#### 4. Add the MCP server in ChatGPT

1. Go to **Settings** → **Developer** → **MCP Servers**
2. Click **Add MCP Server**
3. Enter your public URL with the `/mcp` path: `https://your-machine.tail1234.ts.net/mcp`
4. Save and start a new chat

#### 5. Test it

In a new ChatGPT conversation, ask:

> "Use the run_task tool to ask Clawdy to say hello"

ChatGPT will call `run_task`, then poll with `check_task` until the task completes. If the widget is enabled, you'll see live progress inline.

#### Notes

- `check_task` is annotated as read-only/idempotent, which may reduce approval prompts during polling
- The widget polls the server directly via `oai.callTool()` — it does not require `check_task` to have widget metadata
- If the widget causes issues, set `ENABLE_CHATGPT_UI_WIDGET=false` and restart

#### Authentication & user identity

The HTTP server (`apps/chatgpt`) gates `/mcp` with tokens supplied via `?pass=<token>` on the connector URL or `Authorization: Bearer <token>`. Two env vars control it:

```env
# Personal tokens — token authenticates AND identifies the caller.
MCP_USER_TOKENS=Jake:a1b2c3...,Mohsen:d4e5f6...

# Optional runtime-editable JSON token file. Changes are picked up without restart.
MCP_USER_TOKENS_FILE=/data/clawconnect/user-tokens.json

# Legacy shared pass — still accepted, but resolves to an anonymous caller.
PUBLIC_MCP_PASS=shared-secret
```

When a request authenticates with a personal token:

- every `run_task` is stamped with that person's name (`[Message from: Jake]` in the task the agent receives) — the model-supplied `senderName` argument is ignored, so identity derives from the credential rather than from anything spoofable
- `serverInfo.name` becomes `ClawConnect (Jake)` so multiple people's connectors are distinguishable

`MCP_USER_TOKENS_FILE` is additive with `MCP_USER_TOKENS` and supports these JSON shapes:

```json
{ "Faraz": "cc-faraz-...", "Junaid": "cc-junaid-..." }
```

```json
{ "tokens": { "Faraz": "cc-faraz-...", "Junaid": "cc-junaid-..." } }
```

```json
[{ "name": "Faraz", "token": "cc-faraz-..." }]
```

When a request authenticates with the legacy `PUBLIC_MCP_PASS`, tasks arrive unattributed (unless the model passes `senderName`) and tool responses nudge the caller to get a personal token. Revoking one person = removing their entry from `MCP_USER_TOKENS` or the runtime token file; the shared pass never needs rotating for that.

If neither env var is set, `/mcp` is open (no gate) — only do that on a private network.

## Usage

Once configured, your AI agent has access to the MCP tools. Example flow:

1. Ask your agent to delegate work: *"Ask clawdy to fix the login bug"*
2. The agent calls `run_task` with the task description
3. It polls `check_task(mode: "wait")` until the task completes
4. It presents the results: summary, files changed, PRs created, etc.
5. Follow up: *"Tell clawdy to add tests for that fix"* — continues the same session

### Session Continuation

Every task returns a `sessionKey`. Passing it back to `run_task` continues the same conversation thread in OpenClaw, preserving context from previous tasks.

## `/claw` Slash Command (Claude Code)

For a streamlined experience, copy the slash command:

```bash
mkdir -p ~/.claude/commands
cp .claude/commands/claw.md ~/.claude/commands/claw.md
```

Then use `/claw fix the auth bug` from any project.

## CLI

The CLI is also available for shell-based workflows:

```bash
# Install globally
pnpm -w run ready
npm install -g ./packages/cli/clawconnect-cli-0.0.0.tgz

# Submit and wait
clawconnect run "fix the login bug" --wait --json

# Submit and poll separately
clawconnect run "fix the login bug" --json
clawconnect status <job-id> --json

# Continue a session
clawconnect run "add tests" --session <session-key> --wait --json
```

## Telemetry & Privacy

Every `run_task`/`check_task`/`get_task`/`list_tasks` call emits one structured JSON line to **stderr** (never stdout, which would corrupt the stdio JSON-RPC stream): tool name, job/task id, session key, agent, poll count, requested/effective wait duration, request duration, returned status, duplicate-job detection, and whether the retrieval was terminal.

**What is never logged, structurally (not just by convention):** the submitted task text, context, sender name, log/summary content, or anything else from a run. `TelemetryEvent` (`packages/core/src/telemetry.ts`) has no field that could hold that content — there's nothing to accidentally forget to redact. The original prompt is stored on the job record for retrieval (`get_task detail: "prompt"`, gated by the same per-agent scope that hides out-of-scope jobs) but is never included in telemetry or in any other `get_task`/`check_task` response.

To capture telemetry events in your own tooling instead of stderr, use `setTelemetrySink` from `@clawconnect/core`.

## Local Testing

```bash
pnpm install
./node_modules/.bin/vp test              # full workspace test suite (vitest via vite-plus)
./node_modules/.bin/vp run -r build --force   # full workspace build + typecheck, all 4 packages
```

As of this contract implementation: **6 test files, 53 tests, all passing.** Coverage by client surface:

| Surface | What's verified | Where |
|---|---|---|
| Generic MCP (Claude Code, Cursor, Codex, any bare MCP client) | `tools/list`/`tools/call` over the real stdio `McpServer` via the SDK's `InMemoryTransport` — unversioned tool names, no ChatGPT-only `_meta` leakage, `check_task` has `waitMs`, `get_task` has neither `waitMs` nor `mode` (it never waits) | `packages/mcp/src/server.test.ts` |
| Claude / Claude Code | Unrecognized extra properties in tool arguments and a request-level `_meta` block (progress tokens, `io.modelcontextprotocol/related-task`) don't reject the call | `packages/mcp/src/server.test.ts` |
| ChatGPT (structural, not live) | `structuredContent` shape is produced by the exact same shared builders (`packages/core/src/structured-content.ts`) the ChatGPT HTTP app calls — cross-transport identity is enforced by construction, not by a live comparison. **Not verified: anything inside ChatGPT itself** — that needs a deploy, which this build deliberately does not do. The ChatGPT UI widget rebuild itself is gated pending review of a prior exploration session; see `docs/architecture/2026-07-27-multi-client-compatibility.md` §8 | `packages/core/src/structured-content.test.ts` |
| Wait semantics | Fake-clock coverage: 45s default, explicit `waitMs` override, invalid values (negative/NaN/huge) clamp instead of erroring, terminal status returns immediately regardless of `waitMs`, a timeout is non-terminal with no duplicate job created on re-poll, `pollCount` increments per call | `packages/core/src/session-wait.test.ts` |
| Concurrency, sessions, prompt authorization | Concurrent `taskId`/`sessionKey` pairs across agents never cross-resolve; a second `run_task` on a still-running session is refused, not silently overwritten; `get_session` snapshot/events/tail pagination; `get_task detail: "prompt"` round-trip and its absence from every other detail level | `packages/core/src/tools.test.ts` |

None of the above touch a live OpenClaw gateway or a live ChatGPT connection — `GatewayPool` connects lazily, so tests that never resolve an agent (unknown job/session ids) do no network I/O at all, and tests that do submit a task mock `OpenClawGateway` at the constructor level.

**Known build-tool quirk:** `vp pack --force` (part of `vp run -r build --force`) sometimes rewrites the `bin` field in `packages/cli/package.json` and `packages/mcp/package.json` (`clawconnect` → `cli`, `clawconnect-mcp` → `mcp`), which would silently break the published binary names if committed. This is a vite-plus behavior, not something this project's code does — after any `vp run -r build --force`, check `git status` on those two files and `git checkout` them if changed, before committing.

## Architecture

```
AI Agent (Claude Code / Cursor / Codex)
    |
    |-- MCP (stdio) --> packages/mcp --> packages/core --> OpenClaw Gateway (WebSocket)
    |                                                            |
    |                                                      OpenClaw Agent
    |                                                      (clawdy, molty, etc.)
    |
ChatGPT
    |
    |-- MCP (HTTP) --> apps/chatgpt --> packages/core --> OpenClaw Gateway (WebSocket)
```

`packages/core` handles all communication with OpenClaw — the MCP server and ChatGPT app are thin layers that adapt the transport and response format. See `docs/architecture/2026-07-27-multi-client-compatibility.md` for the layer boundaries between client-neutral core/`structuredContent` and ChatGPT-only `_meta`/resource metadata.
