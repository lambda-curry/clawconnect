# Managed, session-scoped attachment — implementation plan

> **Non-normative historical record.** This is the build plan for one slice of
> work, written before the seam was generalized, and it is preserved for
> provenance only. It names the specific host and runtime that motivated the
> work; **none of them is required, assumed, or referenced by ClawConnect
> itself.** For the current, normative ownership split and contracts, read
> [runtime-boundary.md](runtime-boundary.md) — it supersedes this document
> wherever the two disagree. This document is not part of the public
> integration path; see [the integration guide](../guides/runtime-integration.md).
>
> **Names below are the ones this slice shipped with and have since changed.**
> The body is left as written — annotating a record beats rewriting one — so
> use this map rather than searching for files that no longer exist:
>
> | Then | Now |
> |---|---|
> | `fleet-handoff.ts` | `session-handoff.ts` |
> | `fleet-attachment-store.ts` | `attachment-store.ts` |
> | `fleet-attachment.test.ts` | `agent-session-attachment.test.ts` |
> | `FleetAttachmentRecord` | `AgentSessionAttachment` |
> | `SessionFleetState` | `SessionAttachmentState` |
> | `FleetDirective` | `AgentSessionDirective` |
> | `FleetLiveStatus` | `AttachmentLiveStatus` |
> | `FleetAttachmentStore` / `JsonFileFleetAttachmentStore` | `AttachmentStore` / `JsonFileAttachmentStore` |
> | `parseFleetDirective` | `parseAgentSessionDirective` |
> | `fleetAttachment` (wire field) | `agentSession` |
> | `[[clawconnect:fleet]]` | `[[clawconnect:agent-session]]` |
> | `fleetStoreDir` / `CLAWCONNECT_FLEET_STORE_DIR` | `attachmentStoreDir` / `CLAWCONNECT_ATTACHMENT_STORE_DIR` |
> | `<agentId>.fleet.json` | `<agentId>.attachments.json` |
>
> `resultSource: "fleet-transcript"` did **not** change. It now means the
> legacy claude-fleet transcript path *only*; a result recovered from a
> host-registered runtime is `resultSource: "agent-session"`.
>
> `FleetAdapter`, `LocalTmuxFleetAdapter`, and `fleet-adapter.ts` kept their
> names: they genuinely describe the legacy claude-fleet adapter.

## Ownership boundary as recorded on 2026-08-03

- **The owning host owns** runtime choice, spawn/continue/watch, input and
  approval handling, retries/fallbacks, result collection, and
  worktree/session cleanup. Runtime CLI, transport, provider, and supervision
  vocabulary stay in host-managed docs and adapters.
- **ClawConnect owns** the normalized attachment record, one-current-session
  authority, replacement lineage, parent/child and delegated-turn guards,
  freshness/CAS protection, detach/replace state, and optional callbacks for a
  single already-known attachment.
- A host that owns a runtime may inject `AgentSessionRuntimeCallbacks` into
  `createApp`/`createMcpServer`. The callbacks are keyed by the normalized
  `(runtime, sessionId)` reference and return normalized observations. The
  registry has no spawn or list/enumerate operation and ClawConnect does not
  select a provider or inspect a runtime's state on its own.
- The built-in `LocalTmuxFleetAdapter` remains only as a backward-compatible
  legacy recovery path for existing `claude-fleet` artifacts. It is not a
  runtime selector and not a bridge to any particular runtime. New runtime
  wiring belongs to the owning host through the generic callback registry.

Any richer supervision fields a host's own runtime publishes (turn-in-flight
projections, phase reconciliation, retry state) are consumed by that host from
its runtime's contract. ClawConnect receives only normalized
observations/events; it must not reproduce any runtime's CLI syntax, pairing,
project, transport, authentication, approval, retry, or worktree policy.

Baseline verified: `origin/main` = `2c74d11` (already includes the landed stalled-run reconciliation feature). This work builds on top of it; greenfield — no existing Fleet/attachment code anywhere in the repo (confirmed by repo-wide grep).

## Ground truth about the existing architecture (why the seams below are where they are)

- There is **no** `resultSource`/`terminalReason`/`phase` field anywhere today. The landed reconciliation feature is entirely implicit: `JobStatus = "running"|"completed"|"completed_no_summary"|"error"` (`types.ts:49`) plus private `SessionManager` state (`provisionalOutcomes`, `recheckSettled`, `upstreamRunIds`, `reconcilers`).
- `runId` (OpenClaw's handle for a run) arrives asynchronously via `onRunId` in `gateway.chat()` (`gateway.ts:768-1010`, called at `991`), is stashed in `SessionManager.upstreamRunIds` (`session.ts:173`, set at `375-381`), and is **not persisted** today — restart loses it.
- `Job` (`types.ts:81-110`) is the full in-memory record; `PersistedJob` (`job-store.ts:15-22`) is a deliberately minimal restart pointer (`jobId, sessionKey, startedAt, lastEventAt, pollCount, prompt` — no status, no logs). `JsonFileJobStore` overwrites the whole file with exactly the `status==="running"` set on every save (`session.ts:262-275`).
- `ContinuationState` (`types.ts:176-184`, the session-scoped record already returned by `list_sessions`/`get_session`) is **not persisted** and is fully reconstructed (not merged) at 8 call sites in `session.ts` (348, 412, 441, 468, 765, 843, 858, 1012). Adding a field there means threading it through all 8 or risking silent drops on whichever path a given job takes to terminal.
- **One-writer tripwire**: `completion-reconciliation.test.ts` regex-asserts nothing outside `SessionManager.setOutcome` (`session.ts:904-915`) assigns `.status/.summary/.error/.errorInfo`. New terminal-outcome fields should route through `setOutcome` by the same discipline even though the regex doesn't name them.
- Public tool surface has **four** mirrored edit sites for new *input* schema (types.ts, structured-content.ts, `packages/mcp/src/server.ts` zod, `apps/chatgpt/src/app.ts` JSON Schema). The mission explicitly waives a new public tool, so this slice adds **zero** new input schema — only additive *output* fields, which only need `structured-content.ts` + the two response-assembly sites.

## Design decisions

1. **Attachment state lives in its own map, not in `ContinuationState`.** `private fleetAttachments = new Map<string, SessionFleetState>()` keyed by `sessionKey`, mutated *only* by explicit `attachFleet`/`continueFleet`/`replaceFleet`/`detachFleet`/`inspectFleet` methods. Zero blast radius on the 8 existing `ContinuationState` rewrite sites; naturally session-scoped (survives across jobs on the same session) rather than job-scoped.
2. **Restart survival via a new, parallel, small JSON store** — `fleet-attachment-store.ts`, same shape/atomicity as `job-store.ts` (`JsonFileFleetAttachmentStore`, write-then-rename, best-effort). Wired into `GatewayPool` the same way `jobStoreDir` is (`gateway-pool.ts:24-27`), one file per agent. Rehydrated in the `SessionManager` constructor, symmetric to `rehydrateFromStore`. Unlike the job store (which only ever holds `running` jobs), this store holds every session that has ever had an attachment, including `superseded`/`detached` lineage — bounded because it's one record per *session*, not per event.
3. **Lineage**: each attachment transition mints a new `FleetAttachmentRecord` with its own `id` (not the same as `handle`). `SessionFleetState = { sessionKey, currentAttachmentId?, attachments: Record<attachmentId, FleetAttachmentRecord> }`. Replace sets the new record's `replacesAttachmentId`, flips the old record's `status` to `"superseded"`, and both stay in `attachments` — nothing is deleted.
4. **Transitions arrive as a structured directive parsed out of `TaskInput.context`**, not a new public tool (mission: "no public tool is required"). New pure module `fleet-handoff.ts`: `parseFleetDirective(text): { directive: FleetDirective; strippedText: string } | undefined`, matching a delimited block `[[clawconnect:fleet]]{...json...}[[/clawconnect:fleet]]`. `submitTask` parses `input.context` first, applies the directive to `fleetAttachments` (attach/continue/replace/detach/inspect), and passes the *stripped* context into `buildSubmitMessage` so the agent's prompt never sees the raw directive. This is the "structured handoff parsing" half of the vertical slice.
5. **Emission**: `fleetAttachment` (current record only, not full lineage) is added to `JobSnapshot` (built in `buildSnapshot`, `session.ts:1031`) unconditionally — same treatment as `recovery`, not gated behind a detail preset, since the owning host needs to see it on every turn to decide continue/replace/detach. `check_task`'s `buildCheckTaskStructuredContent` spreads the whole snapshot already, so it needs no change. `get_task`'s `buildGetTaskStructuredContent` gets one added line. `get_session`'s hand-built result in `tools.ts` gets one added field.
6. **`parentRunId` persistence** (requirement 1): add `parentRunId?: string` to `Job` and `PersistedJob`. Set it in the existing `onRunId` callback (`session.ts:375-381`) alongside `upstreamRunIds`, and persist immediately by calling the existing `persistActiveJobs()` right there — piggybacks on the already-tested atomic-write path instead of adding a new one.
7. **`resultSource`/`terminalReason`** (requirement 7): add `resultSource?: "parent" | "fleet-transcript"` and `terminalReason?: string` to `Job`, written only inside `setOutcome` (extended with optional params), defaulting to `undefined` (read as `"parent"`) for every existing terminal path — old records / old code paths are unaffected. Surfaced in `JobSnapshot`.
8. **Recovery order** (requirement 5/6): the existing three-tier fallback in `session.ts` already *is* "parent live final → exact parent transcript via sessionKey" (`recoverLateFinalText`, `maybeRecoverTerminalJob`, both keyed by `sessionKey` and now cross-checkable against the persisted `parentRunId`). This slice adds the **third** tier only: at the exact two points where those two functions currently give up and call `setOutcome(job, "completed_no_summary", ...)` (`session.ts:856` and the `!recovered` fallthrough at `986` in `maybeRecoverTerminalJob`), first consult `fleetAttachments.get(job.sessionKey)`'s *current* record (if any) via the new `FleetAdapter`. Only a known, single, already-attached handle is ever consulted — never a scan. If the adapter reports a trusted terminal handoff, `setOutcome(job, "completed", handoff.text, undefined, { resultSource: "fleet-transcript", terminalReason: "fleet-transcript-recovery" })` and mark the job provisional (reuse `provisionalOutcomes`, exactly like `finalizeReconciled` does) so the **existing** late-live-final-replaces-provisional path (`session.ts:388-424`) automatically satisfies "late parent final replaces provisional Fleet result" for free — no new replacement logic needed. If the adapter reports `needs_input` or anything non-terminal, no synthesis happens — the job still falls through to `completed_no_summary`, but the attachment's own `status` (visible via `fleetAttachment` on the snapshot) shows `needs_input`, which is what keeps it actionable.
9. **No child-driven parent termination**: this is enforced by construction, not a runtime check — the Fleet-adapter consultation is placed *only* inside the two pre-existing give-up branches (which already only run once the parent job's own live+transcript avenues are exhausted, i.e. `job.status !== "running"` is about to become permanent). There is no listener, timer, or webhook anywhere that watches Fleet state and pushes a status change into a still-`running` job.
10. **`FleetAdapter` is an injected interface**, mirroring how `JobStore` is injected — this is the actual "Fleet adapter" layer boundary named in the mission:
    ```ts
    export interface FleetAdapter {
      isLive(attachment: FleetAttachmentRecord): Promise<boolean>;       // tmux-only, local host
      readTerminalHandoff(attachment: FleetAttachmentRecord): Promise<{ text: string; observedAt: number } | null>;
    }
    ```
    Production implementation (`LocalTmuxFleetAdapter`): `isLive` shells `tmux has-session -t <handle>` (local host only — remote `host` values are an explicit out-of-scope boundary for this slice: the adapter returns liveness `false`/handoff `null` and the recovery path falls through to today's `completed_no_summary`, same as if no attachment existed). `readTerminalHandoff` treats a handoff as trusted only when `isLive` is false (the tmux session has ended) **and** a non-empty transcript tail is readable at the attachment's `~/.claude-fleet/<handle>/meta.json` → `transcriptPath` (the real on-disk convention this repo's own Claude Fleet sessions use). Tests use a `FakeFleetAdapter` matching the existing `fakeGateway` pattern.
11. **Capped output** (requirement 7): `FleetAttachmentRecord.lastResult` is `{ summary?: string (capped, ~2000 chars), outputRef?: string, observedAt: number }` — `outputRef` carries the durable pointer (`sessionKey`/transcript path) so full detail is always re-derivable, never duplicated unbounded inline.
12. **Backward compatibility** (requirement 7/old records readable): every new field is optional and additive on both `Job`/`PersistedJob` (parentRunId) and the brand-new attachment store (nothing pre-existing references it). `JsonFileFleetAttachmentStore.load()` degrades to `[]` on missing/corrupt file, same as `JsonFileJobStore`.
13. **No heuristic scanning** (requirement 4): every read of Fleet state is `fleetAttachments.get(sessionKey)` (O(1), one session) or the adapter called with one specific known record. No iteration over `.claude-fleet/*`, no tmux `list-sessions`, anywhere in this slice.

## Files touched (smallest coherent vertical slice)

| File | Change |
|---|---|
| `packages/core/src/types.ts` | `FleetAttachmentRecord`, `SessionFleetState`, `FleetDirective` types; `parentRunId?`, `resultSource?`, `terminalReason?` on `Job`; `fleetAttachment?` on `JobSnapshot`; `fleetAttachment?` on `SessionInspectResult` |
| `packages/core/src/job-store.ts` | `parentRunId?` on `PersistedJob` |
| `packages/core/src/fleet-attachment-store.ts` (new) | `FleetAttachmentStore` interface + `JsonFileFleetAttachmentStore`, mirrors `job-store.ts` |
| `packages/core/src/fleet-adapter.ts` (new) | `FleetAdapter` interface + `LocalTmuxFleetAdapter` |
| `packages/core/src/fleet-handoff.ts` (new) | `parseFleetDirective` (parse + strip), pure/testable |
| `packages/core/src/session.ts` | attachment map + lifecycle methods; parse directive in `submitTask`; persist `parentRunId` in `onRunId`; extend `setOutcome`; wire Fleet-adapter fallback into the two give-up branches; include `fleetAttachment` in `buildSnapshot` |
| `packages/core/src/gateway-pool.ts` | optional `fleetStoreDir` + `FleetAdapter` plumbed to `SessionManager` |
| `packages/core/src/structured-content.ts` | `fleetAttachment` added to `buildGetTaskStructuredContent`'s unconditional fields |
| `packages/core/src/tools.ts` | `fleetAttachment` added to `getSession`'s hand-built result |
| `packages/core/src/*.test.ts` | new test files: `fleet-handoff.test.ts`, `fleet-attachment-store.test.ts`, `fleet-adapter.test.ts`, `fleet-attachment.test.ts` (SessionManager-level lifecycle + recovery-order tests, same fakeGateway/vi.useFakeTimers conventions as `completion-reconciliation.test.ts`) |

Explicitly **not** touched: `apps/chatgpt/src/app.ts` JSON Schema, `packages/mcp/src/server.ts` zod input schemas, `ContinuationState`, any workflow/orchestration code. `packages/cli` is unaffected (it doesn't wire a job store today either).

## Test plan (maps to the 14 required tests)

All in `packages/core/src/fleet-attachment.test.ts` unless noted, using the existing `fakeGateway`/`FakeJobStore`/`vi.useFakeTimers` conventions:

1. attachment survives connector restart — new `FakeFleetAttachmentStore`, round-trip through a second `SessionManager` instance.
2. later turns expose and continue same attachment — submit with `attach` directive, then a second `submitTask` with no directive (or `continue`) on the same `sessionKey`, assert `buildSnapshot(...).fleetAttachment` unchanged.
3. explicit replacement preserves superseded lineage — `replace` directive, assert old record present with `status:"superseded"`, new record's `replacesAttachmentId` points at it.
4. explicit detach persists reason — assert `status:"detached"` + reason field, persisted via the fake store.
5. empty parent final + completed attached child recovers child result — `FakeFleetAdapter` returns a trusted handoff; assert `status:"completed"`, `resultSource:"fleet-transcript"`.
6. active child remains running — adapter reports `isLive:true` / no handoff; assert job stays `completed_no_summary` (unchanged behavior) and attachment status stays live-ish, not synthesized as done.
7. child completion does not prematurely finish active parent — submit a job, leave it `running` (chat() never settles), assert Fleet-adapter path is never consulted while `job.status === "running"`.
8. needs_input surfaced — attachment status `needs_input` visible on the snapshot; job does not get force-completed.
9. late parent final replaces provisional Fleet result — after a fleet-transcript recovery, the underlying `chat()` promise later resolves with real text; assert it overwrites (reuses the existing provisional-replacement test shape from `completion-reconciliation.test.ts`).
10. repeated recovery idempotent — call the recovery path twice with the same adapter response; assert no duplicate lineage entries / no double-persist beyond the expected single write.
11. output capped with durable transcript reference — assert `lastResult.summary` truncated at the cap and `outputRef` present.
12. old records readable — a `SessionFleetState`-less / `PersistedJob`-without-`parentRunId` fixture loads without error, same as today's `persistedRunning` fixture.
13. no attachment triggers no global Fleet scan — spy on the `FleetAdapter`; assert it's never called for a session with no `SessionFleetState` entry.
14. parent runId persistence and exact transcript correlation — assert `parentRunId` is written to the fake store's saved snapshot immediately after the fake gateway's `onRunId` fires, before `chat()` resolves.

Plus `fleet-handoff.test.ts` (parse/strip correctness, malformed directive handling) and `fleet-adapter.test.ts` (tmux liveness + transcript-tail read, using a temp dir fixture instead of mocking `child_process` wholesale where practical).

## Verification commands

- Focused: `pnpm --filter @clawconnect/core test -- fleet` (new files) then the full core suite to confirm no regression, especially the one-writer tripwire and session-persistence suites.
- Full suite: `pnpm test` (or repo's documented full-suite command — confirm exact script name in `package.json` before running).
- Build/typecheck: `pnpm run ready` (per `ARCHITECTURE.md`) and/or `pnpm -w typecheck` if present.
- `git diff --check` for whitespace/conflict-marker hygiene.

## Deliberately out of scope

- Remote-host Fleet liveness (only local tmux is implemented; remote `host` attachments degrade gracefully to today's behavior).
- Any new public MCP tool or input-schema change.
- ChatGPT-specific behavior in core.
- A general workflow/orchestration engine.
- Rewriting `gateway.ts`'s existing transcript-read internals — `parentRunId` is persisted and available for stricter correlation, but this slice does not change `pollTranscriptForFinalText`'s signature.
