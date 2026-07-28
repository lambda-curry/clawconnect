# ChatGPT UI: design reconciliation

**Status:** Gate cleared — building against this note
**Date:** 2026-07-27
**Supersedes the pause in** `docs/architecture/2026-07-27-multi-client-compatibility.md` §8

This is the required design note before any UI edit (per the build gate). It
reconciles the `cf-clawconnect-mcp-ui-explorer` session (report commit
`fe3f9df`, prototype commits `4596c97`, `79e3d59`, `038683d`, `70647a5`) with
the UX constraints given for this build, states what's reused vs. rejected
vs. changed, and lists the platform unknowns this implementation carries
forward un-resolved (that branch's test results are evidence from a separate
branch, not proof for this one — nothing here is claimed verified against
live ChatGPT).

## 1. What's reused from the explorer session, and why

The explorer's session did real primary-source research (SEP-1865, OpenAI's
`developers.openai.com/plugins/` docs, and the shipped
`@modelcontextprotocol/ext-apps@1.5.0` bytes) rather than working from
assumption. I re-verified the load-bearing facts directly against the copy
of `@modelcontextprotocol/ext-apps@1.5.0` in *this* worktree's
`node_modules` before reusing them — not trusting the report's paraphrase:

- `RESOURCE_URI_META_KEY = "ui/resourceUri"`, `RESOURCE_MIME_TYPE =
  "text/html;profile=mcp-app"`, `EXTENSION_ID = "io.modelcontextprotocol/ui"`
  — confirmed present verbatim in `dist/src/app.d.ts` / `dist/src/server/
  index.d.ts` of the installed package.
- The modern tool-metadata shape is `_meta.ui.resourceUri` (+ `_meta.ui.
  visibility`), with `_meta["ui/resourceUri"]` as the deprecated flat alias
  hosts must also check — confirmed in `registerAppTool`'s JSDoc and type
  signature.
- The package ships no pre-bundled browser file (`exports` map only lists
  ESM entry points meant for a bundler) — so a self-contained widget HTML
  resource cannot `import` it directly without a bundle step. This is my own
  finding from inspecting `package.json`, not something the explorer's
  report claimed either way.

**Reused, as *facts*, not code:**
- MCP Apps requires `protocolVersion >= 2025-06-18`; the current HTTP
  transport hardcodes `2024-11-05` regardless of what the client requests —
  a real bug independent of any UI, since it means the connector could never
  offer *any* extension capability to *any* host.
- The four confirmed-absent platform capabilities (no server→app push, no
  execution after teardown, no unprompted conversation message, no durable
  cross-conversation state) — these are the reason completion must stay
  assistant/model-owned via `check_task(mode:"wait")`, never the card.
- The core failure mode of the disabled `widget.html`: it carried completion
  responsibility via a client-side long-poll (`POLL_CALL_TIMEOUT_MS =
  65000`) against `check_task`, which is exactly the mechanism this
  worktree's earlier commits (`c7534fb` onward) already moved the *portable*
  contract away from. Re-enabling that file as-is would reintroduce the
  problem this whole build exists to fix.
- The attention-shaped cadence numbers (2.5s active / 5s quiet / 12s slow /
  stop at terminal) as a reasonable starting point — these are a product
  judgment call about UX feel, not a platform fact, and are not verified
  against a live host in either branch. Reused as a default, not a claim.

**Reused, adapted, not copied:** the general shape of "pure state module +
thin HTML shell + build-time inliner" for shipping one self-contained
resource, because the constraint that forces it (no bundler for the served
HTML, CSP blocks anything not brought inline) is real and applies here
identically. The actual state module in this build has a different data
model entirely (see §3) — aggregate/session-first instead of one-card-per-
task — so it is a fresh implementation, not an adapted copy of
`widget/state.js` from that branch.

## 2. What's rejected, and why

- **The explorer's one-card-per-`run_task`, single-task-focused data model.**
  The UX constraints for *this* build are explicitly a command center that
  *can* collapse to a single focused task, not a design that starts from
  "one task is the whole widget." Rebuilding from the new constraints outward
  is less risky than trying to retrofit a multi-session aggregate view onto
  a single-task state machine.
- **The explorer's 12-state UX taxonomy** (`dispatching`/`working`/
  `thinking`/`slow`/`recovering`/`needs_you`/`offline`/`detached`/`done`/
  `done_quiet`/`failed`/`blocked`). This build's status model is instead the
  four human groups given in the constraints (Active / Needs attention /
  Completed / Failed) as a *display* grouping over the *exact* underlying
  `TaskStatus` — narrower, and explicitly required to preserve exact status
  rather than collapse it into a bespoke state name.
- **`get_task(mode:"snapshot")` as a `CheckMode` enum value.** This worktree
  already rejected that shape in the non-UI slice (`c7534fb`): `get_task`
  has no wait/mode parameter at all — it never waits, full stop. The
  explorer's card can be pointed at plain `get_task` (no mode) with zero
  further server change, because that's already what `get_task` is.
- **Copying `apps/chatgpt/src/ui-resource.ts` / `widget/state.js` /
  `widget/shell.html` files verbatim.** Different data model (§3), different
  test surface required (focused/aggregate/expansion/grouping/prompt-reader/
  fallback/dedup, per this build's execution steps) — a line-for-line port
  would be adapting someone else's answer to a different question.

## 3. UX model this build implements

**Read model — client-neutral tools only, no new RPC surface:**
- `list_tasks` — aggregate, immediate. Drives the command-center list.
- `get_task` — immediate, per-task detail. Drives the focused view.
- `get_task(detail:"prompt")` — the dedicated, authorized original-prompt
  reader. Never fetched implicitly; only on explicit user action.
- A new `get_session(mode:"tasks")` — see §4. Drives "expandable task
  history keyed taskId" under a session-first row.

**View collapse (aggregate ⇄ focused):** the card mounts from `run_task`'s
result, which names one `taskId`/`sessionKey`. On mount it also reads
`list_tasks` once. If that session is the only one with a non-terminal task
in scope (§ conversation scope below), the card renders **focused**: just
that task's detail, generated title, status, latest update, artifacts.
Otherwise it renders **aggregate**: session-first rows (keyed `sessionKey`),
each expandable into its task history (keyed `taskId`, via
`get_session(mode:"tasks")`), grouped Active / Needs attention / Completed /
Failed (default filter: Active, with a Recent view for the rest) — with the
mounted task's row expanded by default so the thing the user just asked for
is never buried.

**Conversation scope — documented safe fallback.** The explorer's own report
flags `_meta["openai/session"]` (an anonymized per-conversation id sent on
tool calls) as **unexplored** — not confirmed available, not confirmed
stable, not confirmed present on this host. This build does not assume it
exists. Default scope is therefore **this card instance's own known
sessions**: the mounted session plus whatever other sessions the same
mounted iframe has been told about via `widgetState` rehydration — never a
true cross-mount "everything in this conversation" claim, because that isn't
verifiable from here. An explicit **"All activity"** control switches to
`list_tasks(view:"all")` fully unscoped, across every agent/session this
connection can see — the honest fallback when a narrower scope isn't
derivable.

**Generated titles vs. the prompt reader.** The default title for a task
row is derived *only* from fields already present in a normal (non-`prompt`)
snapshot — `summary` (terminal), `artifacts` (PR/branch), or an
agent+status+elapsed label while running. It is never derived from the
stored prompt, so the default rendering path never needs to call
`detail:"prompt"` at all. A distinct, explicit "Show original request"
action is the only thing that calls it — matching the existing
`getTaskPrompt` authorization boundary (`db7f26e`) exactly: nothing new to
authorize, the boundary already exists, the UI just respects it by never
reaching for it implicitly.

**Read cadence — bounded and deduplicated.** One in-flight read at a time
per card instance (a `pollInFlight`-style guard); aggregate mode polls
`list_tasks` (one call covers every session, not one call per row —
naturally bounded, no per-row fan-out); focused mode polls `get_task` for
the one focused `taskId`; task-history expansion is fetched on expand, not
polled continuously, and cached per `sessionKey` for the mount's lifetime.
Cadence follows the reused attention-shaped intervals (§1) and stops
entirely once every task in scope is terminal.

**No completion responsibility in the card, anywhere.** No `ui/message`,
no follow-up-send, no cancel (no cancel tool exists), no mutation of any
kind — every action is either a read or a composed prompt handed back to
the assistant, which is the only thing that ever reports a result. Teardown
clears client-side timers only; the underlying task is server-owned and
keeps running regardless of whether anything is mounted.

## 4. The one core addition, and why it's minimal

**"Expandable task history keyed taskId" needs a capability that doesn't
exist yet.** `SessionManager` currently tracks only the *latest* job per
session (`latestJobBySession`) — there is no way to list every job that ever
ran under a `sessionKey`. This is a real, small, additive gap, not UI
plumbing: `get_session` gains a fourth mode, `"tasks"`, returning
`TaskSummary[]` for every job under that session (newest first), reusing
the exact `TaskSummary` shape `list_tasks` already returns. No new tool, no
UI-specific RPC method, no ChatGPT-only surface — a stdio/Claude Code client
can call `get_session(mode:"tasks")` today and get the same array. This is
the "optional UI metadata/resource; stdio/core clients must ignore it"
requirement applied literally: the *data* the UI needs is plain core
surface; only the `_meta`/`ui://` *presentation* wrapper around it is
ChatGPT-only.

## 5. Server-side changes (apps/chatgpt only)

- `initialize` echoes the client's requested `protocolVersion` when it's one
  this server supports (`2025-06-18` or `2024-11-05`), instead of
  hardcoding `2024-11-05` — the real bug from §1, fixed independent of
  whether the widget is enabled.
- `capabilities.extensions[EXTENSION_ID] = { mimeTypes: [RESOURCE_MIME_TYPE] }`
  advertised only when `ENABLE_CHATGPT_UI_WIDGET=true`; absent otherwise, so
  a host that doesn't ask for it sees nothing different from today.
- `resources/list`/`resources/read` restored, gated the same way.
- `_meta.ui.resourceUri` (+ the deprecated `_meta["ui/resourceUri"]` alias,
  per the SDK's own compatibility note) and `_meta.ui.visibility: ["model",
  "app"]` (+ legacy `openai/widgetAccessible: true`) on `run_task` only —
  `get_task`/`list_tasks`/`get_session` stay app-callable (the card needs to
  call them) but do **not** carry `resourceUri`, so the assistant's own
  polling of those tools never mints a duplicate card.
- The stdio `McpServer` (`packages/mcp/server.ts`) and the generic-MCP
  compatibility fixtures (`98c540b`) are untouched by any of this — the
  boundary they already enforce (no `openai/*` `_meta` on that transport)
  continues to hold structurally, and a test proves it stays holding.

## 6. Explicit unknowns carried forward (not resolved by this build)

Same category the explorer flagged, restated as *this build's* open
questions rather than borrowed conclusions:

1. Whether ChatGPT actually proxies app-initiated tool calls
   (`hostCapabilities.serverTools`) for a non-submitted/dev-mode connector,
   and whether `ui.visibility`/`openai/widgetAccessible` is honored. If not,
   the card's own fallback table (§7) already covers it: static render of
   the mount data, no polling attempted.
2. Whether `_meta["openai/session"]` is a real, stable, available signal —
   deliberately not assumed (§3).
3. Any host-side tool-call timeout ceiling — the card's own calls use a
   generous client-side timeout and treat a timeout as a transient failure,
   not a fatal one.
4. **Nothing in this build is verified against live ChatGPT rendering.**
   That remains out of scope per the hard invariant against live testing;
   verification here is limited to unit tests on the pure state module and
   integration tests against the real HTTP JSON-RPC handler.

## 7. Fallback table (mirrors the reasoning, restated for this data model)

| Situation | Card behavior | Correctness impact |
|---|---|---|
| Host doesn't proxy tools | Never starts polling; renders the static mount data with a "live updates unavailable" note | None — assistant's own loop is unaffected |
| No bridge at all | Static render of the tool result | None |
| Conversation/card torn down | Client timers cleared | None — task keeps running server-side on its `sessionKey` |
| `ENABLE_CHATGPT_UI_WIDGET` unset/false | No `_meta`, no `resources/*` advertised at all | None — this is the default; the whole `run_task`→`check_task` lifecycle is provably unaffected (tested at the HTTP layer) |
| `get_task`/`get_session` returns not-found (connector restarted) | Card shows a "reconnect" state, offers `list_tasks(view:"active")` as a way back in | None — read-only, no state to lose that the server didn't already lose |

## 8. Test plan for this slice

Per the execution steps: focused one-task view, aggregate multi-session
view, session expansion into task history, status grouping (exact status
preserved), context-aware detail rendering, the prompt-reader boundary,
missing-UI-metadata fallback, unmounted-core independence, and
bounded/deduplicated reads. Implemented as: pure-function tests against the
state module (no DOM needed — the module is plain data-in/data-out) plus
HTTP-integration tests against the real `apps/chatgpt` request handler
(requires extracting a testable factory from `index.ts`'s current
import-time side effects — see the app.ts split in the implementation
commit).
