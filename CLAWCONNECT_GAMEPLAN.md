# ClawConnect — Gameplan Prompt

## Vision

ClawConnect is a monorepo that provides multiple ways to connect AI coding assistants (Claude Code, Codex, Cursor, ChatGPT) to an OpenClaw agent. It extracts the battle-tested gateway and adapter logic from `chatgpt-openclaw` into a shared core, then exposes it through three surfaces:

1. **`@clawconnect/core`** — Shared library: gateway WebSocket client, job/session management, artifact extraction, error classification
2. **`@clawconnect/cli`** — CLI tool optimized for Claude Code and Codex (`run_in_background` friendly)
3. **`@clawconnect/mcp`** — Stdio MCP server for Cursor, Claude Code MCP, and other MCP clients
4. **`apps/chatgpt`** — The existing ChatGPT MCP app (HTTP + widget), preserved as-is

## Why This Structure

- **CLI is king for Claude Code/Codex**: These tools can run `clawconnect run "fix the bug" --wait` in background bash and get notified on completion. No polling, no server process, no context window tax from MCP tool schemas.
- **MCP is king for Cursor**: Cursor only speaks MCP. A stdio MCP server with structured tools is the right interface.
- **ChatGPT needs its own thing**: HTTP-based MCP with an embedded widget — already built, just needs to live in its own app directory.
- **Shared core prevents drift**: The gateway auth, WebSocket reconnect, artifact extraction, and error classification logic should exist once.

---

## Monorepo Structure

```
clawconnect/
├── vp.config.ts                  # VitePlus workspace config
├── package.json                  # Root workspace package.json
├── packages/
│   ├── core/                     # @clawconnect/core
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts          # Public API barrel export
│   │   │   ├── gateway.ts        # OpenClaw WebSocket client (from current gateway.ts)
│   │   │   ├── session.ts        # Job + session management (from current adapter.ts)
│   │   │   ├── artifacts.ts      # Artifact extraction logic (from current adapter.ts)
│   │   │   ├── errors.ts         # Error classification (from current adapter.ts)
│   │   │   └── types.ts          # Shared types
│   │   └── tsconfig.json
│   ├── cli/                      # @clawconnect/cli
│   │   ├── package.json          # bin: { "clawconnect": "./dist/bin.js" }
│   │   ├── src/
│   │   │   ├── bin.ts            # CLI entry point (#!/usr/bin/env node)
│   │   │   ├── commands/
│   │   │   │   ├── run.ts        # clawconnect run <task> [--wait] [--session <key>] [--timeout <ms>]
│   │   │   │   ├── status.ts     # clawconnect status <job-id>
│   │   │   │   ├── logs.ts       # clawconnect logs <job-id> [--tail] [--follow]
│   │   │   │   └── sessions.ts   # clawconnect sessions [list|resume <key>]
│   │   │   └── output.ts         # Terminal formatting (spinners, colors, structured JSON via --json)
│   │   └── tsconfig.json
│   └── mcp/                      # @clawconnect/mcp
│       ├── package.json          # bin: { "clawconnect-mcp": "./dist/bin.js" }
│       ├── src/
│       │   ├── bin.ts            # MCP stdio entry point
│       │   ├── server.ts         # MCP server setup (tools, resources)
│       │   └── tools/
│       │       ├── run-task.ts    # run_task tool
│       │       ├── check-task.ts  # check_task tool
│       │       ├── list-sessions.ts
│       │       └── cancel-task.ts
│       └── tsconfig.json
└── apps/
    └── chatgpt/                  # The existing ChatGPT MCP app
        ├── package.json
        ├── src/
        │   ├── index.ts          # Current src/index.ts (HTTP MCP server)
        │   └── widget.html       # Current widget
        ├── .env
        └── tsconfig.json
```

---

## Package Details

### `@clawconnect/core`

Extract from current `gateway.ts` and `adapter.ts`. The core should be a pure library with no CLI or server concerns.

**Public API:**

```ts
// Gateway
export class OpenClawGateway {
  constructor(url: string, token: string)
  connect(): Promise<void>
  close(): void
  chat(sessionKey: string, message: string, timeoutMs: number, onEvent?: (e: GatewayEvent) => void): Promise<string>
}

// Session manager
export class SessionManager {
  submitTask(gateway: OpenClawGateway, input: TaskInput): Job
  getJob(jobId: string): Job | undefined
  resolveJob(jobId?: string, sessionKey?: string): Job | undefined
  waitForJob(jobId: string | undefined, knownLogCount?: number, sessionKey?: string): Promise<Job | undefined>
  buildSnapshot(job: Job): JobSnapshot
  listSessions(): ContinuationState[]
}

// Artifact extraction
export function processEvent(artifacts: Artifacts, event: GatewayEvent): void
export function extractPatternsFromSummary(artifacts: Artifacts, summary: string): void

// Error classification
export function classifyError(message: string): ErrorInfo

// Types
export type { Job, JobSnapshot, JobStatus, Artifacts, ErrorInfo, ErrorCategory, GatewayEvent, ContinuationState, LogEntry, TaskInput }
```

**Key design decisions:**
- Gateway manages its own WebSocket connection + reconnect (already does this)
- SessionManager is stateful but does NOT own the gateway — it receives it as a dependency
- Device identity loading (`~/.openclaw/clawd-ui-device.json`) stays in gateway
- No environment variable reading in core — callers pass config explicitly

### `@clawconnect/cli`

The CLI is the primary interface for Claude Code and Codex users.

**Commands:**

```bash
# Run a task (fire-and-forget by default, --wait blocks until completion)
clawconnect run "fix the auth bug in src/middleware.ts" --wait
clawconnect run "add unit tests for the User model" --context "$(cat src/models/user.ts)" --wait --timeout 300000

# Continue a previous session
clawconnect run "now add error handling too" --session <session-key> --wait

# Check status of a running job
clawconnect status <job-id>

# Stream logs
clawconnect logs <job-id> --follow

# List active sessions
clawconnect sessions list

# All commands support --json for machine-readable output
clawconnect run "fix the bug" --wait --json
```

**Key design decisions for CLI:**

1. **`--wait` mode is the default for AI assistants**: When Claude Code runs `clawconnect run "..." --wait` in background bash, it blocks until the task completes, then the full output (summary, artifacts, files changed) is returned. Claude Code's `run_in_background` handles the notification.

2. **`--json` flag for structured output**: AI assistants parse JSON better than pretty terminal output. Default is human-friendly with colors/spinners; `--json` emits newline-delimited JSON events.

3. **Exit codes matter**: 
   - `0` = task completed successfully
   - `1` = task completed with errors
   - `2` = timeout
   - `3` = connection/auth failure
   
   This lets AI assistants branch on `$?` without parsing output.

4. **Progress to stderr, result to stdout**: While waiting, progress logs go to stderr (visible in terminal but doesn't pollute captured output). Final result goes to stdout. This means `result=$(clawconnect run "..." --wait)` captures just the summary.

5. **Config via env vars or `~/.clawconnect/config.json`**:
   ```
   OPENCLAW_URL=wss://...
   OPENCLAW_PASSWORD=...
   OPENCLAW_AGENT_ID=main
   ```

**Example Claude Code interaction:**

```
User: "Fix the flaky test in src/auth.test.ts"

Claude Code thinking: I'll delegate this to OpenClaw since it requires running the test suite repeatedly.

Claude Code runs (in background):
  clawconnect run "The test in src/auth.test.ts is flaky - it fails intermittently on the token refresh assertion. Investigate why and fix it." --wait --json

[Background notification: command completed]

Claude Code reads output:
  {"status":"completed","summary":"Fixed the flaky test...","artifacts":{"filesChanged":["src/auth.test.ts","src/auth.ts"],"branchName":"fix/flaky-auth-test"}}

Claude Code responds: "OpenClaw fixed the flaky test. It changed two files..."
```

### `@clawconnect/mcp`

Stdio-based MCP server for Cursor and Claude Code's MCP integration.

**Tools exposed:**

| Tool | Description |
|------|-------------|
| `run_task` | Submit a task to OpenClaw. Returns jobId + sessionKey. |
| `check_task` | Poll task status. Supports long-polling with `knownLogCount`. |
| `list_sessions` | List active sessions and their last status. |
| `cancel_task` | Cancel a running task. |

**Key design decisions:**
- Stdio transport (not HTTP) — this is how Claude Code and Cursor consume MCP servers
- Use `@modelcontextprotocol/sdk` Server class properly (not raw JSON-RPC like the ChatGPT app)
- Tool descriptions are optimized for AI consumption — tell the AI when to use each tool and what the output means
- Consider supporting MCP Tasks primitive (experimental) for proper async — but fall back to poll pattern since Tasks isn't widely supported yet

**Config in Claude Code's `settings.json`:**
```json
{
  "mcpServers": {
    "clawconnect": {
      "command": "clawconnect-mcp",
      "env": {
        "OPENCLAW_URL": "wss://...",
        "OPENCLAW_PASSWORD": "..."
      }
    }
  }
}
```

### `apps/chatgpt`

Move current code here with minimal changes:
- `src/index.ts` → `apps/chatgpt/src/index.ts` (update imports to use `@clawconnect/core`)
- `src/widget.html` → `apps/chatgpt/src/widget.html`
- Keep the HTTP MCP transport (ChatGPT requires it)
- Keep the widget resource serving

---

## Implementation Plan

### Phase 0: Rename Repo
1. Rename GitHub repo `lambda-curry/chatgpt-openclaw` → `lambda-curry/clawconnect` (keep private)
   ```bash
   gh repo rename clawconnect
   ```
2. Update local directory name and git remote:
   ```bash
   cd .. && mv chatgpt-openclaw clawconnect && cd clawconnect
   # gh repo rename updates the remote automatically, but verify:
   git remote -v
   ```
3. Update `package.json` name field → `"clawconnect"` (root workspace)

### Phase 1: Monorepo Setup
1. Initialize VitePlus monorepo (`vp create` or manual setup)
2. Set up workspace structure with `packages/` and `apps/`
3. Move existing code to `apps/chatgpt/`:
   - `src/index.ts` → `apps/chatgpt/src/index.ts`
   - `src/widget.html` → `apps/chatgpt/src/widget.html`
   - `src/openclaw/adapter.ts` → `apps/chatgpt/src/openclaw/adapter.ts`
   - `src/openclaw/gateway.ts` → `apps/chatgpt/src/openclaw/gateway.ts`
   - `.env` → `apps/chatgpt/.env`
4. Give `apps/chatgpt/` its own `package.json`:
   ```json
   {
     "name": "@clawconnect/chatgpt",
     "private": true,
     "type": "module",
     "scripts": {
       "dev": "tsx watch src/index.ts",
       "build": "tsc && cp src/widget.html dist/widget.html",
       "start": "node dist/index.js",
       "restart": "lsof -ti:7331 | xargs kill -9 2>/dev/null; npm run build && node dist/index.js"
     }
   }
   ```
5. Wire up root-level convenience scripts so you can still run from the repo root:
   ```json
   {
     "scripts": {
       "dev:chatgpt": "vp run dev --filter @clawconnect/chatgpt",
       "build": "vp run build",
       "dev:cli": "vp run dev --filter @clawconnect/cli",
       "dev:mcp": "vp run dev --filter @clawconnect/mcp"
     }
   }
   ```
   (If VitePlus workspace filtering differs, adjust — the point is root-level shortcuts that reach into apps/packages.)
6. Verify the ChatGPT app still runs end-to-end from its new location before proceeding

### Phase 2: Extract Core
1. Create `packages/core/`
2. Extract gateway.ts → `core/src/gateway.ts` (minimal changes — remove env var reads, accept config)
3. Split adapter.ts into:
   - `core/src/session.ts` — SessionManager class (job store, polling, snapshots)
   - `core/src/artifacts.ts` — artifact extraction + event processing
   - `core/src/errors.ts` — error classification
   - `core/src/types.ts` — all shared types
4. Update `apps/chatgpt` to import from `@clawconnect/core`
5. Verify ChatGPT app still works end-to-end

### Phase 3: Build CLI
1. Create `packages/cli/`
2. Implement `run` command first (most important)
3. Add `--wait`, `--json`, `--session`, `--timeout` flags
4. Implement stderr progress / stdout result pattern
5. Add `status`, `logs`, `sessions` commands
6. Test with Claude Code's `run_in_background`

### Phase 4: Build MCP Server
1. Create `packages/mcp/`
2. Implement stdio MCP server using `@modelcontextprotocol/sdk` Server class
3. Add `run_task`, `check_task`, `list_sessions`, `cancel_task` tools
4. Test with Claude Code MCP config and Cursor

### Phase 5: Polish
1. Add a root-level `CLAUDE.md` explaining the monorepo to AI assistants
2. Add `clawconnect` to npm (or just use local linking for now)
3. Document setup for each client (Claude Code CLI, Claude Code MCP, Cursor, Codex)

---

## Open Questions

1. **Should the CLI persist jobs across process restarts?** The current adapter is in-memory. For CLI, a SQLite or JSON file store in `~/.clawconnect/jobs.json` would let you check status of past runs. Worth it?

2. **Should the MCP server share a gateway connection with the CLI?** Or are they independent processes? Independent is simpler but means two WebSocket connections.

3. **Should we support `clawconnect mcp serve` as a subcommand of the main CLI** (like OpenClaw does with `openclaw mcp serve`)? This would mean one npm package instead of two bins.

4. **VitePlus maturity**: VitePlus is new. If `vp create` doesn't have a good monorepo template for pure Node.js packages (no frontend), we may need to set up the workspace manually and just use `vp` for build/test/lint.

---

## Dependencies

### Core
- `ws` — WebSocket client
- `zod` — Schema validation (already used)

### CLI
- `@clawconnect/core`
- `citty` or `commander` — CLI framework (citty is lighter, ESM-native)
- `consola` — Pretty console output with spinners

### MCP
- `@clawconnect/core`
- `@modelcontextprotocol/sdk` — MCP server SDK

### ChatGPT App
- `@clawconnect/core`
- `hono` + `@hono/node-server` — HTTP server
- `@modelcontextprotocol/sdk` — MCP types
- `@modelcontextprotocol/ext-apps` — ChatGPT app extensions
