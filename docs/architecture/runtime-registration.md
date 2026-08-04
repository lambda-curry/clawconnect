# Registering an agent-session runtime, and where attachment state lives

Normative companion to [runtime-boundary.md](runtime-boundary.md), which covers
the ownership split and the attachment/observation contracts, and to
[the integration guide](../guides/runtime-integration.md), which walks a host
through implementing the callbacks. The historical
`2026-08-02-managed-fleet-attachment-plan.md` covers the attachment model (one current attachment per conversation, lineage,
delegated turns, recovery tier 3). This one covers the two wiring questions a
deployment has to answer: **how does a host teach this build about a runtime**,
and **where does attachment state survive a restart**.

ClawConnect stays generic. Nothing here — and nothing in `packages/core` —
knows a runtime's CLI, transport, pairing, project model, or credentials. Every
mention of a concrete runtime below is an example of what a *host* supplies.

## The seam

`AgentSessionRuntimeRegistry.register({ id, provider, inspect, continue?, detach? })`
(`packages/core/src/agent-session.ts`). Three functions, each addressing ONE
already-known session; capabilities are derived from which ones were supplied.
There is no list/enumerate callback and no spawn, so there is no surface
through which ClawConnect could sweep a runtime's sessions.

Every callback runs under a deadline (`AGENT_SESSION_CALL_TIMEOUT_MS`, 60s;
per-call override via `opts.timeoutMs`) and receives an `AbortSignal` that is
aborted when the deadline passes. A callback that never answers becomes an
ordinary `unavailable` status with code `<op>_timeout` — never a wedged turn,
because terminal recovery awaits these calls.

## Reaching the seam from a shipped binary

The factories (`createApp`, `createMcpServer`) have always accepted a registry.
That is enough for an embedder, and it was NOT enough for production: the
binaries this repo ships (`apps/chatgpt/src/index.ts`,
`packages/mcp/src/bin.ts`) are what actually run, and nothing could hand them
one. The gap is closed with the smallest mechanism that keeps the boundary
intact — the operator names ES modules to load, the same way they already name
`~/.clawconnect/agents.json`:

```
CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES=/opt/acme/runtime-bridge/register.mjs
```

Each module exports `registerAgentSessionRuntimes(registry)` (or a default
function of the same shape) and registers whatever it can answer for:

```js
export function registerAgentSessionRuntimes(registry) {
  registry.register({
    id: "example-runtime",
    provider: "example-provider",
    inspect: (ref, opts) => /* the host's own transport */,
    continue: (ref, request, opts) => /* … */,
  });
}
```

`loadAgentSessionRuntimes()` (`packages/core/src/runtime-modules.ts`) resolves
comma- or newline-separated specifiers — bare package names, absolute paths, or
paths relative to the process cwd — imports each one, and never throws: a
module that is missing, fails to import, exports no registrar, or throws while
registering is logged and skipped, because every task that does not involve a
delegation still works. Unset or registering nothing, `claude-fleet` stays the
only reachable runtime and any other attachment reads back as a precise
`unknown_runtime` result.

**The outer adapter stays outside.** A host's own runtime bridge is one such
module: it owns that runtime's CLI/API, pairing, project selection, and
credentials, and hands ClawConnect three functions. Specifiers come from the deployment's own
environment — operator configuration, at the same trust level as the agent
registry, never anything a caller or an agent can influence.

## Where attachment state lives, per deployment path

Attachment lineage is durable state the model depends on: which conversation is
delegated to which session, and its replacement history. The runtime session
routinely outlives the ClawConnect process that attached to it.

| Path | Runtime registry | Attachment store |
|---|---|---|
| `apps/chatgpt` (`createApp`) | `CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES` via `index.ts` | on by default — `<jobStoreDir>/<agentId>.attachments.json` |
| `packages/mcp` bin (`createMcpServer`) | same env var via `bin.ts` | `CLAWCONNECT_ATTACHMENT_STORE_DIR`, default `~/.clawconnect/attachments` |
| `createApp` / `createMcpServer` as a library | caller passes `agentSessionRuntimes` | caller passes a directory; unset = in-memory |
| `packages/cli` | none | none |

`createMcpServer` deliberately does not default a store directory: it is also
what tests and embedders construct, and a default would make construction write
files. The shipped bin passes one — that is the deployed path this exists for.
Job persistence stays off there, unchanged: an in-flight job belongs to a live
stdio connection that a restart ends anyway, while an attachment does not.

The CLI is unchanged and wires neither half. It is a one-shot process that
makes no managed-session claim — it never registers a runtime, never injects a
FleetAdapter, and never surfaces an attachment — so there is nothing for it to
persist between invocations.

## Restart invariant

`SessionManager.observationSeq` resumes above the highest `observationToken`
found in any reloaded record, current or superseded. The token is durable and
its counter is not, so a process that restarted at zero would mint tokens the
compare-and-set in `applyAgentSessionStatus` is bound to refuse — every
observation, and every recovery that depends on one landing, would silently do
nothing. Covered by the post-restart observation and recovery tests in
`fleet-attachment.test.ts`.
