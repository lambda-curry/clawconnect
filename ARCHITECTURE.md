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
ChatGPT                                                     (your configured agent)
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
| `agent-session.ts` | Optional runtime seam — registry, normalization, and bounded dispatch for host-supplied managed agent sessions |
| `runtime-modules.ts` | Loads operator-named ES modules that register runtimes, so a shipped binary can reach the seam without embedding |
| `session-handoff.ts` | Parses (and strips) the `<agent-session>` marker and the attachment directive out of `TaskInput.context` |
| `attachment-store.ts` | Restart-durable attachment lineage, one JSON file per agent — same shape as `job-store.ts` |
| `types.ts` | Shared TypeScript types |

Key design decisions:
- Gateway accepts config explicitly — no environment variable reads in core
- SessionManager is stateful but does not own the gateway (receives it as a dependency)
- Device identity stored at `~/.openclaw/clawd-ui-device.json`

## Runtime boundary (optional extension)

ClawConnect can attach a task to an agent session that **some other system
already started** — but it never starts, chooses, or enumerates one. Runtime
integrations are optional, host-supplied extensions: a default install
registers no runtime and every MCP tool behaves identically without one.

The embedding host owns runtime choice, lifecycle, transport, authentication,
approvals, and cleanup, and supplies `inspect`/`continue`/`detach` callbacks
for one already-known session — either by constructing the server itself, or,
for a shipped binary, by naming ES modules via
`CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES`. ClawConnect owns the normalized attachment
record, one-current-session authority, lineage, restart durability, and
normalization of whatever the runtime reports.

See [docs/architecture/runtime-boundary.md](docs/architecture/runtime-boundary.md)
for the normative split, the attachment/observation contracts, and the
non-goals; [docs/guides/runtime-integration.md](docs/guides/runtime-integration.md)
is the host-side integration guide.

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
