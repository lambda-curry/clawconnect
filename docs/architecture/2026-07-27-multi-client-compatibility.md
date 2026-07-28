# Multi-client-safe task contract: compatibility architecture

**Status:** Implementation in progress against `docs/decisions/2026-07-27-task-contract.md`
**Date:** 2026-07-27

This doc is the gameplan for implementing the accepted task contract without
breaking any of the three existing consumers: Claude Code / Cursor / Windsurf
(stdio MCP via `packages/mcp`), ChatGPT (HTTP MCP via `apps/chatgpt`), and the
`clawconnect` CLI (talks to `packages/core` directly, no MCP framing at all).
It defines the boundaries the implementation must respect, the concrete gaps
found in the current checkout, and the test matrix that proves the contract
holds.

## 1. Layer boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│ packages/core                                                       │
│  types.ts        — Job/JobSnapshot/TaskSummary/... (client-neutral) │
│  session.ts       — SessionManager: job lifecycle, wait semantics   │
│  tools.ts         — runTask/checkTask/getTask/listTasks/getSession  │
│                      (pure functions over GatewayPool; no MCP,      │
│                      no HTTP, no ChatGPT knowledge)                 │
│  structured-content.ts — pure builders: Job* -> structuredContent   │
│  telemetry.ts     — structured event emission, no prompt content    │
└─────────────────────────────────────────────────────────────────────┘
              │                                   │
              ▼                                   ▼
┌───────────────────────────────┐   ┌─────────────────────────────────┐
│ packages/mcp (stdio)           │   │ apps/chatgpt (HTTP)             │
│ McpServer + zod schemas        │   │ hand-rolled JSON-RPC over Hono  │
│ default formatters: text +     │   │ tool schemas (JSON Schema) +    │
│ structuredContent (shared      │   │ structuredContent (same shared  │
│ builders) — CLIENT-NEUTRAL     │   │ builders) + _meta["openai/*"]   │
│                                 │   │ + ui:// resource — CHATGPT-ONLY │
└───────────────────────────────┘   └─────────────────────────────────┘
```

**Rule:** anything that changes behavior for a generic MCP client (Claude
Code, Cursor, a bare `tools/call` over stdio) lives in `packages/core` or
`packages/mcp`'s default formatters. Anything that only makes sense to
ChatGPT's Apps SDK (`_meta["openai/toolInvocation/*"]`, the `ui://` widget
resource, `resources/list` / `resources/read`) lives only in
`apps/chatgpt/src/index.ts`. `structuredContent` is the one payload shape
that must be **identical** across both transports — it's plain MCP, not a
ChatGPT extension — so it's built once in `packages/core/src/structured-content.ts`
and imported by both.

Why this matters concretely: `apps/chatgpt/src/index.ts` does **not** use
`createMcpServer` from `packages/mcp` — it's a separate hand-rolled
`tools/list` / `tools/call` JSON-RPC handler (needed because ChatGPT
connections carry per-request agent scoping via query params, which doesn't
fit the SDK's per-connection transport model cleanly). That means the two
tool surfaces are maintained by hand in two places today. Rather than take on
the risk of unifying the transports in this slice, this doc keeps them
structurally separate but forces their **output shapes** through the same
pure functions, so drift is caught by tests instead of by inspection.

## 2. Gaps found in the current checkout vs. the accepted contract

Read against `docs/decisions/2026-07-27-task-contract.md`:

| # | Contract decision | Current state | Gap |
|---|---|---|---|
| 1–2 | Unversioned `run_task`/`check_task`/`get_task`/`list_tasks` | Already implemented, no `_v2` names | None |
| 3 | `run_task` returns `jobId`/`taskId`, `sessionKey`, status, continuation metadata, exact next action | Returns ids/status/agent; MCP default formatter's `message` field is the human-readable next action but not machine-addressable | Add a structured `nextAction` field (`{tool, args}`) to the client-neutral structuredContent |
| 4 | `check_task` owns waiting; default 45s target, override allowed; ordinary progress doesn't end the wait, terminal/actionable states do | `POLL_WAIT_MS` hardcoded to 50 000 ms, no override param | Add `waitMs` param through `checkTask` → `SessionManager.waitForJob`, default 45 000 ms |
| 5 | Timeout is non-terminal; return `continuePolling: true`; never duplicate a task on timeout | Non-terminal branch has no explicit `continuePolling` field. Duplicate-submit is already guarded (`session busy` rejection in `submitTask`) | Add `continuePolling` to `CheckTaskResult`/response payloads |
| 6 | `get_task` is an **immediate** snapshot (diagnostics/manual reads/UI) | `get_task` in both `packages/mcp/server.ts` and `apps/chatgpt/src/index.ts` calls `checkTask(...)`, which runs the same blocking `waitForJob` loop as `check_task` — it can block up to the wait window | Real bug: add a non-waiting `getTask()` in `tools.ts` that never calls `waitForJob`; wire `get_task` tool to it in both transports; drop `get_task`'s `mode` param (waiting is `check_task`'s job only) |
| 7 | Rich snapshots (elapsed time, phase, latest update, poll count, timeline); telemetry (tool, job/task id, poll number, wait duration, status, request duration, duplicate-job, terminal retrieval) | Elapsed time computed ad hoc in one formatter; no poll count; no telemetry subsystem at all | Add `pollCount` to `Job`; add `packages/core/src/telemetry.ts`; wire into `runTask`/`checkTask`/`getTask`/`listTasks` |
| 8 | Annotations (`readOnlyHint`, etc.) classify intent only, not guarantees | True today, undocumented | Document inline where annotations are declared |
| 9–10 | UI optional, server authoritative, must work with UI absent; non-UI fallback required | `apps/chatgpt/src/widget.html` (1045 lines, currently disabled) polls `check_task` directly in a client-side loop with a 65s client timeout "to exceed server's 50s long-poll" — this is the exact poll-heavy pattern implicated in the ChatGPT-stall report cited as a source in the contract doc | Do not re-enable as-is. Rebuild as a read-only widget driven by `list_tasks`/`get_task` immediate reads on a client interval; never opens a long-held `check_task` call |
| — | "prompt retrieval authorization" (task objective 3) | `Job` never stores the original submitted task/context text at all — there is currently no way to retrieve what was asked, only the agent's reply | Store `{task, context, senderName}` on `Job` (never included in telemetry or default snapshots); expose only via `get_task` `detail: "prompt"`, gated by the same per-agent scope check that already hides out-of-scope jobs in `apps/chatgpt` |

## 3. `check_task` vs `get_task`: the split that matters most

This is the crux of the "multi-client-safe" part of the contract. Before this
change, `check_task` and `get_task` were the same function with two different
names — both routed through `waitForJob`, both could block. That's fine for a
single agentic client that wants to minimize round-trips, but it's wrong for:

- A UI polling for a progress refresh (should never open a 45s-held HTTP
  request just to repaint a status pill).
- A diagnostic/manual read ("what's task abc123 doing right now") — the
  caller wants *now*, not *in up to 45 seconds*.
- Any client mixing both usages against the same task concurrently — if
  `get_task` also waits, there's no way to get an instant read without going
  through `check_task`'s poll semantics.

After this change:

- **`check_task`**: the only tool that waits. Default wait target 45 000 ms
  (`DEFAULT_WAIT_MS`), caller-overridable via `waitMs`, clamped to
  `[MIN_WAIT_MS=1000, MAX_WAIT_MS=120000]` — out-of-range or non-finite
  values silently clamp to the nearest bound (never rejected — a caller
  passing `waitMs: 999999` gets 120s, not an error, matching "callers may
  override" without opening an unbounded hold). Returns early only on a
  terminal job status; ordinary log growth does not end the wait (that's
  `mode: "poll"`'s job, retained for the ChatGPT live-progress use case and
  the CLI's `--wait` log tailing, both of which are legitimate "return on any
  activity" consumers distinct from the agentic "give me the terminal
  result" default). On timeout, response includes `continuePolling: true`
  and the same `jobId`/`sessionKey` the caller already has — nothing new to
  fetch, no new task to create.
- **`get_task`**: never waits. Resolves the job from the pool synchronously
  (same resolution logic `checkTask` used to share) and returns whatever
  snapshot exists right now, including `status: "running"` if that's the
  truth. This is what `list_tasks`/`get_session` already did — `get_task` was
  the outlier and is now consistent with them.

`SessionManager.waitForJob` keeps its existing signature shape (positional,
back-compat with the CLI's direct `sessions.waitForJob(jobId, knownLogCount)`
call) with a new optional 5th parameter `waitMs` defaulting to 45 000 — so the
CLI's existing `--wait` loop keeps working unchanged, just with a marginally
shorter per-call ceiling (50s → 45s), which does not change its observable
behavior since it re-calls in a loop regardless.

## 4. Telemetry boundary

Per contract point 7 and the hard invariant "avoid sensitive prompt logging by
default": telemetry events carry **only** identifiers, counts, statuses, and
durations. They never carry `task`, `context`, `summary`, or log text. This is
enforced structurally, not just by convention — `TelemetryEvent` (the type)
has no field that could hold prompt content, so there is nothing to
accidentally forget to redact. Sink is `console.error` (stderr) by default,
matching the existing `logDebug` convention in `session.ts`/`gateway.ts` so it
doesn't corrupt the stdio JSON-RPC stream. A `setTelemetrySink` escape hatch
lets tests capture events without going through stderr.

## 5. Prompt retrieval authorization

`Job` gains a `prompt: { task: string; context?: string; senderName?: string }`
field, populated at `submitTask` time. It is:

- **Never** included in `JobSnapshot` by default, never in `check_task`'s
  response, never in telemetry.
- Retrievable only via `get_task` with `detail: "prompt"` (a new detail
  preset alongside the existing `core/summary/updates/artifacts/diagnostics/
  full/fullWithDiagnostics`).
- Subject to the same authorization boundary every other snapshot field
  already has: `apps/chatgpt`'s per-connection agent scope
  (`scope.allowedIds`) already causes `get_task`/`check_task`/`get_session`
  to return "not found" for jobs on agents outside the connection's scope
  before any snapshot field is serialized — `detail: "prompt"` rides that
  same gate, no new authorization mechanism needed. The stdio MCP server has
  no cross-tenant boundary to begin with (one process, one registry, one
  local user), so no additional gate applies there either.

## 6. UI widget rebuild

The existing `apps/chatgpt/src/widget.html` is kept as git history but
replaced, not patched — its core design (single global session/job state,
client-side long-poll against `check_task` with a 65s timeout to outlast the
server's 50s hold) is the mechanism the contract explicitly moves away from
(decision 9: "the Activity UI can make a healthy 10+ minute run appear
stuck"). The replacement:

- Lists active tasks via `list_tasks` (immediate read) on a client interval.
- Shows detail for a selected task via `get_task` (immediate read), also on
  an interval — never a long-held call.
- Is entirely read-only: no tool calls that mutate state, matching the hard
  invariant.
- Stays optional (`ENABLE_CHATGPT_UI_WIDGET`, default off) and its complete
  absence or failure to load must not affect `run_task`/`check_task`
  correctness for a non-UI client — verified by a test that drives the full
  task lifecycle through the HTTP JSON-RPC surface with the widget disabled.
- Cannot be verified by live ChatGPT rendering in this slice (hard invariant:
  no live ChatGPT testing). Verification here is limited to: the HTML/JS is
  syntactically valid, its fetch/interval logic is unit-testable in
  isolation (extracted into a plain `.ts` module where feasible), and the
  server-side `resources/list`/`resources/read` wiring returns the expected
  payloads over HTTP. Actual rendering inside ChatGPT's Apps SDK sandbox is
  an explicit leftover — see the report at the end of this build.

## 7. Test matrix

| Area | What's verified | Where |
|---|---|---|
| Generic MCP tolerance | `tools/list` + `tools/call` round-trip over the stdio `McpServer` for `run_task`/`check_task`/`get_task`/`list_tasks`; unknown extra input fields don't break parsing | `packages/mcp/src/server.test.ts` |
| Claude-style `_meta`/extra-field tolerance | A `tools/call` request carrying an unrecognized top-level field or `_meta` block is accepted and ignored, not rejected | `packages/mcp/src/server.test.ts` |
| ChatGPT UI metadata boundary | `_meta["openai/*"]` and the `ui://` resource only ever appear in `apps/chatgpt` responses/`resources/list`, never in the stdio server's tool defs; `structuredContent` shape is identical between the two transports for the same underlying snapshot | `apps/chatgpt/src/index.test.ts`, `packages/core/src/structured-content.test.ts` |
| Concurrent taskIds/sessionKeys | Two `run_task` calls on different sessions produce independent, concurrently-pollable jobs; a second `run_task` on the *same* running session is rejected with the busy error, not silently overwritten | `packages/core/src/tools.test.ts` |
| Session expansion + prompt authorization | `get_session` events/tail modes paginate correctly; `get_task detail:"prompt"` returns the stored prompt; default `get_task`/`check_task` never include it; out-of-scope agent access to `detail:"prompt"` is denied the same as any other field | `packages/core/src/tools.test.ts`, `apps/chatgpt/src/index.test.ts` |
| Wait semantics | Fake-clock tests: default 45s target; explicit `waitMs` override; invalid (negative/NaN/huge) `waitMs` clamps instead of erroring; terminal status ends the wait immediately regardless of `waitMs`; timeout returns `continuePolling: true` without creating a duplicate job | `packages/core/src/session.test.ts` |
| UI absent/failure | Full `run_task` → `check_task` → terminal lifecycle over the HTTP transport with `ENABLE_CHATGPT_UI_WIDGET` unset/false; `resources/list` returns no widget resource | `apps/chatgpt/src/index.test.ts` |

## 8. Explicit non-goals for this slice

- No rearchitecture of `apps/chatgpt`'s hand-rolled JSON-RPC into the MCP
  SDK's HTTP transport. Real risk (auth gate, CORS, per-connection scoping)
  for no contract-required benefit; the shared `structured-content.ts`
  module gets the compatibility benefit without the transport rewrite.
- No live ChatGPT rendering verification (hard invariant).
- No push/merge/deploy (hard invariant).
- Visual polish of the rebuilt widget is out of scope — it's a compatibility
  and correctness slice, not a design pass.
