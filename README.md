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

### ChatGPT

The ChatGPT integration runs as an HTTP server with a live progress widget:

```bash
cd apps/chatgpt
cp .env.example .env  # edit with your OPENCLAW_URL, OPENCLAW_PASSWORD, OPENCLAW_AGENT_ID
pnpm run dev
```

Then add the MCP server URL (`http://localhost:7331/mcp`) in ChatGPT's MCP settings.

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
