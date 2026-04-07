# Architecture

ClawConnect is a monorepo that provides multiple ways to connect AI coding agents to an OpenClaw instance. It uses a shared core library with thin transport layers on top.

## Package Structure

```
clawconnect/
├── packages/
│   ├── core/       # Shared library — gateway, sessions, artifacts, tools
│   ├── mcp/        # MCP server (stdio transport)
│   └── cli/        # CLI tool (clawconnect)
└── apps/
    └── chatgpt/    # ChatGPT MCP app (HTTP transport + widget)
```

## Data Flow

```
AI Agent (Claude Code / Cursor / Codex / Windsurf)
    │
    ├── MCP (stdio) ──▶ packages/mcp ──▶ packages/core ──▶ OpenClaw Gateway (WebSocket)
    │                                                              │
    │                                                        OpenClaw Agent
ChatGPT                                                     (clawdy, etc.)
    │
    ├── MCP (HTTP) ──▶ apps/chatgpt ──▶ packages/core ──▶ OpenClaw Gateway (WebSocket)
```

## packages/core

The core package owns all communication with OpenClaw. Nothing else speaks WebSocket directly.

| File | Responsibility |
|------|----------------|
| `gateway.ts` | WebSocket client — connects to OpenClaw, handles auth via Ed25519 device identity, manages reconnection |
| `session.ts` | Job and session management — submit tasks, track job state, long-poll for completion |
| `tools.ts` | MCP tool definitions and handlers (`run_task`, `check_task`, `list_sessions`) |
| `artifacts.ts` | Extracts structured data (files changed, PRs, branches) from gateway events and summaries |
| `errors.ts` | Classifies gateway errors into categories (auth, timeout, connection, etc.) |
| `types.ts` | Shared TypeScript types |

Key design decisions:
- Gateway accepts config explicitly — no environment variable reads in core
- SessionManager is stateful but does not own the gateway (receives it as a dependency)
- Device identity stored at `~/.openclaw/clawd-ui-device.json`

## packages/mcp

Thin stdio MCP server using `@modelcontextprotocol/sdk`. Reads `OPENCLAW_URL`, `OPENCLAW_PASSWORD`, and `OPENCLAW_AGENT_ID` from environment variables, creates a core gateway, and exposes the tool handlers.

## packages/cli

Shell-friendly CLI for use with `clawconnect run`, `clawconnect status`, etc. Designed for AI agents that can run background shell commands (Claude Code's `run_in_background`, Codex).

- `--wait` blocks until task completion (default for AI workflows)
- `--json` emits machine-readable output
- Progress goes to stderr, results to stdout
- Config via env vars or `~/.clawconnect/config.json`

## apps/chatgpt

HTTP-based MCP server with an embedded progress widget. Uses Hono for the HTTP layer. This is the only package that serves a UI — the widget shows real-time task progress in ChatGPT's interface.

## Build System

The monorepo uses [VitePlus](https://github.com/nicepkg/vite-plus) (`vp`) for workspace orchestration. `pnpm run ready` builds all packages in dependency order.
