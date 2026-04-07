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

The server exposes three tools:

- **`run_task`** — Submit a task to your OpenClaw agent. Returns a `jobId` and `sessionKey` immediately.
- **`check_task`** — Poll for progress. Blocks up to 50s per call. Use `mode: "wait"` for agentic use (returns only on completion/timeout) or `mode: "poll"` for live progress (returns on any new activity).
- **`list_sessions`** — List active sessions for reconnecting to previous threads.

### Polling Modes

| Mode | Behavior | Best for |
|------|----------|----------|
| `wait` (default) | Returns only when the task completes or 50s elapses | AI agents (Claude Code, Codex) — minimizes round-trips |
| `poll` | Returns as soon as any new log activity occurs | Live UIs (ChatGPT widget) — real-time progress |

A typical 3-minute task with `mode: "wait"` requires ~5 tool calls (1 `run_task` + 4 `check_task`).

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

`packages/core` handles all communication with OpenClaw — the MCP server and ChatGPT app are thin layers that adapt the transport and response format.
