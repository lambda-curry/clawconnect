# ClawConnect

MCP server and CLI for connecting AI coding agents to [OpenClaw](https://github.com/lambda-curry/openclaw) instances. Submit tasks, poll for progress, and continue conversations — all through the MCP protocol.

> **Use at your own risk.** This software is provided as-is under the [MIT License](LICENSE). ClawConnect connects to your OpenClaw instance using credentials you provide — **you are responsible for securing your `OPENCLAW_PASSWORD` and `OPENCLAW_URL`**. Treat these like any other secret: never commit them to version control, restrict network access to your OpenClaw instance, and rotate credentials regularly. The authors are not liable for any damages, data loss, or security incidents arising from the use of this software.

## Packages

| Package | Description |
|---------|-------------|
| [`packages/core`](packages/core/README.md) | Shared gateway, session management, tool handlers, and the optional host-supplied runtime seam |
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

- **`run_task`** — Submit a task to your OpenClaw agent. Returns `jobId`/`taskId`, `sessionKey`, status, and a structured `nextAction` (`{tool: "check_task", args: {jobId, sessionKey}}`) telling the caller exactly what to call next. `nextAction.args` uses `check_task`'s own parameter names, so it can be forwarded verbatim — that's why the identifier there is `jobId`, not the `taskId` alias carried at the top level.
- **`check_task`** — The only tool that waits. Blocks server-side for up to `waitMs` (default **45000ms**, override per call, clamped to `[1000, 120000]` — out-of-range values clamp rather than error) and returns early on a terminal status (`completed` / `completed_no_summary` / `error`). A timeout return is **not** an error and **not** terminal: `continuePolling` is `true`, `nextAction` says to call `check_task` again with the same `jobId`, and `retryAfterMs` suggests a delay before that next call (`0` normally — a wait-mode call already blocked for its full window, so calling again immediately is fine; `10000` during late-recovery, since the transcript is only re-read on that cadence server-side) — never submit a new `run_task` because a poll timed out (the session-busy guard would refuse it as a duplicate anyway). `mode: "poll"` (also bounded by `waitMs`) returns as soon as any new log activity appears, for live-progress use cases distinct from "give me the final result". `completed_no_summary` and `error` are terminal and should be reported as such; a single follow-up poll ~30s later can occasionally upgrade a long tool-heavy run whose final text landed after the connector marked it terminal, but that is the exception, not the loop.
- **`get_task`** — An **immediate, non-waiting** snapshot for diagnostics, manual reads, or UI refresh — including `status: "running"` if that's the current truth. Never blocks, unlike `check_task`. `detail` controls which fields come back (`core`/`summary`/`updates`/`artifacts`/`diagnostics`/`full`/`fullWithDiagnostics`), plus `detail: "prompt"` to retrieve the original submitted `{task, context, senderName}` — not included at any other detail level, so it never appears in a normal response by accident. This is also the read path for a task's **complete** summary and artifacts.
- **`list_tasks`** — Aggregate, immediate view of tasks across agents (one row per session); `view: "active"` filters to non-terminal ones. Each row's `summary` is a bounded preview (500 chars, `summaryTruncated: true` when cut) — a listing carries every agent's answer at once, so the full text lives behind `get_task`.
- **`get_session`** — Debug-level inspection of one session: `snapshot` (default), `events` (bounded slice), `tail` (forward pagination — oldest-first from `after`, page again with `after: nextAfter` until fewer than `limit` events return), or `tasks` (every task ever run under this session, newest first, in `list_tasks`' row shape). `after`/`nextAfter` are get_session's own event offsets and are **not** interchangeable with `check_task`/`get_task`'s `logCursor`.
- **`list_sessions`** — Every session this connector knows about, **including finished ones** — a completed session's `sessionKey` is exactly what you pass back to `run_task` to continue that thread. The list lives in process memory: a restart clears it, and only in-flight jobs are persisted — a reloaded job re-registers its session once it finishes.
- **`list_agents`** / **`search_memory`** / **`get_memory`** / **`list_collections`** — agent listing and QMD memory search, independent of the task lifecycle above.

**Log cursors.** `check_task`/`get_task` return `logCursor`, an **opaque** resume token. Pass it back **unchanged** as the next call's `knownLogCount` (named for wire compatibility; the value it carries is `logCursor`). Never derive it from how many entries came back — `logs`/`updates` is a bounded projection, so its length has no fixed relationship to the cursor, and `logEventCount` is the server-side total, not a cursor either. `logCursor` also rides the model-facing text while a task is running, not just `structuredContent`.

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

> "Use the run_task tool to ask my agent to say hello"

ChatGPT will call `run_task`, then poll with `check_task` until the task completes. If the widget is enabled, you'll see live progress inline.

#### Notes

- `check_task` is annotated as read-only/idempotent, which may reduce approval prompts during polling
- The widget is a read-only "task center": session-first rows (one per `sessionKey`), collapsing to a focused single-task view when only one session has active work, expandable into per-session task history. It polls `get_task`/`list_tasks`/`get_session` directly (never `check_task`) on an attention-shaped cadence that stops entirely once everything in scope is terminal — the assistant's own `check_task(mode:"wait")` loop is unaffected by and independent of whether the widget is mounted, enabled, or even loads successfully. See `docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md` for the full design.
- Task titles are generated from non-sensitive fields (summary/artifacts/status) by default; the original submitted prompt is never shown unless you explicitly use the "Show original request" action (`get_task detail:"prompt"`, same authorization boundary as the API)
- If the widget causes issues, set `ENABLE_CHATGPT_UI_WIDGET=false` and restart — `run_task`/`check_task` correctness never depends on it
- In-flight jobs survive a connector restart: each agent's currently-`running` jobs (jobId/sessionKey/prompt only — no logs, nothing terminal) are written to `apps/chatgpt/.job-store/<agentId>.json` and reloaded on boot, then reattached via the same transcript-recovery path an empty live `chat.final` already uses. A job that was already terminal before the restart is never written, so the file can't grow into a log; delete the directory any time to reset to pre-persistence behavior (a restart during that job just re-derives from scratch instead of reattaching)
- **Not verified against live ChatGPT rendering** — this is a local, test-ready prototype (unit-tested state logic + HTTP-integration-tested server wiring), not a deployed/live-tested one. See the Local Testing coverage table below

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

1. Ask your agent to delegate work: *"Ask my OpenClaw agent to fix the login bug"*
2. The agent calls `run_task` with the task description
3. It polls `check_task(mode: "wait")` until the task completes
4. It presents the results: summary, files changed, PRs created, etc.
5. Follow up: *"Tell it to add tests for that fix"* — continues the same session

### Session Continuation

Every task returns a `sessionKey`. Passing it back to `run_task` continues the same conversation thread in OpenClaw, preserving context from previous tasks.

### Managed runtime attachment (optional)

ClawConnect can also attach a task to an agent session that **some other system already started** — an optional extension for hosts that embed ClawConnect inside their own orchestration.

This is off unless you wire it up. Runtime integrations are **optional, host-supplied extensions**: a default install registers no runtime, every MCP tool behaves identically without one, and no specific runtime, vendor, provider, or CLI is assumed anywhere. ClawConnect never starts, chooses, or enumerates sessions — every operation addresses one already-known session, and there is no spawn or list callback to abuse.

- [docs/architecture/runtime-boundary.md](docs/architecture/runtime-boundary.md) — normative ownership split, the normalized attachment and observation contracts, and the explicit non-goals
- [docs/guides/runtime-integration.md](docs/guides/runtime-integration.md) — implementing `inspect`/`continue`/`detach` against one already-known session

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

As of this contract implementation: **9 test files, 105 tests, all passing.** Coverage by client surface:

| Surface | What's verified | Where |
|---|---|---|
| Generic MCP (Claude Code, Cursor, Codex, any bare MCP client) | `tools/list`/`tools/call` over the real stdio `McpServer` via the SDK's `InMemoryTransport` — unversioned tool names, no ChatGPT-only `_meta` leakage, `check_task` has `waitMs`, `get_task` has neither `waitMs` nor `mode` (it never waits) | `packages/mcp/src/server.test.ts` |
| Claude / Claude Code | Unrecognized extra properties in tool arguments and a request-level `_meta` block (progress tokens, `io.modelcontextprotocol/related-task`) don't reject the call | `packages/mcp/src/server.test.ts` |
| ChatGPT — protocol/meta layer | MCP Apps constants/builders (`protocolVersion` negotiation, extensions capability, `_meta.ui`/legacy-alias shapes) verified against the installed `@modelcontextprotocol/ext-apps@1.5.0` package, not assumed; every builder returns nothing at all when the widget is disabled | `apps/chatgpt/src/ui-meta.test.ts` |
| ChatGPT — HTTP transport | Real ephemeral `http.Server` + real `fetch()` against `createApp()`'s request listener (no live OpenClaw gateway — agents point at an unroutable loopback port). Unmounted core independence (`run_task`→`get_task` succeeds identically whether the widget is disabled, enabled, or enabled-with-a-broken-resource-file); missing-metadata fallback (disabled ⇒ empty `resources/list`, no `extensions` capability, no `ui`/`openai/outputTemplate`/`openai/widgetAccessible` on any tool); enabled-with-a-real-resource (`resources/read` serves it, only `run_task` carries a `resourceUri`, `get_task`/`list_tasks`/`get_session` are app-callable without one, `check_task` carries no `_meta` at all) | `apps/chatgpt/src/app.test.ts` |
| ChatGPT — widget decision logic | The full UX model as pure functions: status grouping (exact status preserved), generated titles (never from the stored prompt), aggregate-command-center-collapsing-to-focused-task, session-first rows with expandable task history, Active/Recent views, context-aware detail sections, attention-shaped poll cadence, dedup ("never a second read in flight") and bound ("stop once everything is terminal") guards, out-of-order-read safety, and the documented conversation-scope fallback | `apps/chatgpt/src/widget/state.test.ts` |
| ChatGPT — widget rendering seam | `shell.html` is a template whose single `<script>` gets `state.js`/`protocol.js` textually inlined at build time, and nothing else in the toolchain link-checks across that seam (`tsc` doesn't read `.html`; the unit tests import `state.js` directly). Asserts every bare function call in `shell.html` resolves to something defined in the shell, exported by an inlined module, or a real platform global — plus a negative control proving the check can fail. This exists because commit `30a5669` shipped five call sites with no definitions, which made `render()` throw on its first call and the widget paint an empty div while never issuing a tool call | `apps/chatgpt/src/widget/references.test.ts` |
| ChatGPT — widget markup safety | Agent-authored summaries/prompts render as minimal markdown into `innerHTML`, so: the whole source is HTML-escaped before any transform, only the tag set `shell.html` styles is emitted, and links are restricted to `http`/`https`/`mailto`. Covered per block path (fenced code, list, blockquote, heading, table cell) plus an `<img onerror>` and a `javascript:` href, both of which must come out as inert text | `apps/chatgpt/src/widget/state.test.ts` |
| Wait semantics | Fake-clock coverage: 45s default, explicit `waitMs` override, invalid values (negative/NaN/huge) clamp instead of erroring, terminal status returns immediately regardless of `waitMs`, a timeout is non-terminal with no duplicate job created on re-poll, `pollCount` increments per call, `retryAfterMs` is `0` on an ordinary timeout and `10000` during late-recovery | `packages/core/src/session-wait.test.ts` |
| Concurrency, sessions, prompt authorization | Concurrent `taskId`/`sessionKey` pairs across agents never cross-resolve; a second `run_task` on a still-running session is refused, not silently overwritten; `get_session` snapshot/events/tail/tasks modes; `get_task detail: "prompt"` round-trip and its absence from every other detail level | `packages/core/src/tools.test.ts` |
| Job-store persistence (restart recovery) | `JsonFileJobStore` load/save round-trip, missing file, corrupt JSON, non-array JSON, and atomic write-then-rename (no `.tmp` left behind) all covered without a real `SessionManager` | `packages/core/src/job-store.test.ts` |
| Restart recovery (`SessionManager`) | A running job persists immediately on submission and drops out of the next save the moment it goes terminal (completed or error); a reloaded job is resolvable/pollable before its recovery attempt even resolves, reattaches via the same transcript-recovery path an empty live `chat.final` uses, and is visible through `getLatestJobForSession`/`getJobHistory` exactly like a freshly-submitted job; with no store configured, behavior is unchanged (no crash, nothing written) | `packages/core/src/session-persistence.test.ts` |
| Late recovery vs. upstream liveness | The real gateway transcript poll (only its single `chat.history` read stubbed) driving the real `SessionManager`: a turn whose live stream ended is never published `completed_no_summary` while openclaw still reports its run executing — it keeps watching, keeps holding the session's busy guard, keeps its liveness evidence fresh, and publishes the answer exactly once when it lands; a genuinely quiet run still settles as before; the absolute hard cap ends a still-executing run as a *diagnosable* failure naming the upstream run id, not as a quiet finish. Also: a failed tool command never ends the turn, and a reloaded (post-restart) job follows the same rules | `packages/core/src/recovery-liveness.test.ts` |

None of the above touch a live OpenClaw gateway or a live ChatGPT connection — `GatewayPool` connects lazily, so tests that never resolve an agent (unknown job/session ids) do no network I/O at all, tests that do submit a task either mock `OpenClawGateway` at the constructor level or point at an unroutable loopback port, and nothing here was verified by actually rendering inside ChatGPT (a hard constraint on this build — see `docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md` §6).

The widget is, however, smoke-tested by **rendering the built `dist/widget.html` in a real browser** against a stubbed `window.openai` (fixtures shaped exactly like `TaskSummary`/`JobSnapshot`, including deliberately long and terminal-state data). That is what catches the class of bug the unit tests structurally cannot: a shell↔module reference that doesn't resolve, a CSS rule that loses the cascade, raw markdown syntax leaking into a title. It is *not* a substitute for live ChatGPT, which remains out of scope — a browser harness stubs the host, so anything host-specific (whether ChatGPT proxies app-initiated tool calls at all, whether `ui.visibility` is honored) is still unverified. See §6 of the design note for the full unknowns list.

**Known build-tool quirks (vite-plus, not this project's code):**
- ~~`vp pack` rewrites the `bin` field in `packages/cli/package.json` and `packages/mcp/package.json`~~ — **fixed.** `vp pack`'s bin auto-detection derives the command name from the package name without its scope (`@clawconnect/mcp` → `mcp`) and rewrote `package.json` on *every* build, not just `--force`. Both packages now name the binary explicitly via `exports.bin` in their `vite.config.ts`, so `clawconnect`/`clawconnect-mcp` survive a `vp cache clean && vp run -r build --force`. If you add another package with a CLI entry, set `exports.bin` there too rather than relying on auto-detect.
- After deleting a package's `dist/` directory, `vp run -r build --force` can replay a cached "success" for a step without actually regenerating output, so a later step in the same package (e.g. `apps/chatgpt`'s widget-copy/build step) fails against a directory that was never recreated. `./node_modules/.bin/vp cache clean` resolves it.

## Architecture

```
AI Agent (Claude Code / Cursor / Codex)
    |
    |-- MCP (stdio) --> packages/mcp --> packages/core --> OpenClaw Gateway (WebSocket)
    |                                                            |
    |                                                      OpenClaw Agent
    |                                                      (your configured agents)
    |
ChatGPT
    |
    |-- MCP (HTTP) --> apps/chatgpt --> packages/core --> OpenClaw Gateway (WebSocket)
```

`packages/core` handles all communication with OpenClaw — the MCP server and ChatGPT app are thin layers that adapt the transport and response format. See `docs/architecture/2026-07-27-multi-client-compatibility.md` (historical implementation record) for the layer boundaries between client-neutral core/`structuredContent` and ChatGPT-only `_meta`/resource metadata.

### Documentation map

| Document | Status |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current — package structure and data flow |
| [docs/architecture/runtime-boundary.md](docs/architecture/runtime-boundary.md) | Normative — what ClawConnect owns vs. an embedding host, for optional managed-runtime attachment |
| [docs/architecture/runtime-registration.md](docs/architecture/runtime-registration.md) | Normative — how a host or operator registers a runtime, and where attachment state survives a restart |
| [docs/guides/runtime-integration.md](docs/guides/runtime-integration.md) | Guide — implementing `inspect`/`continue`/`detach` for one already-known session |
| [docs/decisions/2026-07-27-task-contract.md](docs/decisions/2026-07-27-task-contract.md) | Accepted decision record |
| [docs/architecture/2026-07-27-multi-client-compatibility.md](docs/architecture/2026-07-27-multi-client-compatibility.md) | Historical implementation record |
| [docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md](docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md) | Historical design note |
| [docs/architecture/2026-08-02-managed-fleet-attachment-plan.md](docs/architecture/2026-08-02-managed-fleet-attachment-plan.md) | Historical, non-normative build record — superseded by the runtime boundary doc |
