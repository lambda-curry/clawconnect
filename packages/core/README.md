# @clawconnect/core

Shared library behind every ClawConnect transport: the OpenClaw gateway,
session and job lifecycle, artifact extraction, and the MCP tool handlers.
`packages/mcp`, `packages/cli`, and `apps/chatgpt` are thin layers on top of
it — nothing else in the monorepo speaks WebSocket to OpenClaw.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the file-by-file map.

## Managed runtime attachment is optional

This package also exports a **generic seam** for attaching a task to an agent
session that some other system already started. It is an extension point, not
a dependency:

- Nothing is registered by default. `createMcpServer` and `createApp` register
  no runtime, and every MCP tool behaves identically with none present.
- ClawConnect never starts, chooses, or enumerates a session. There is no
  spawn and no list callback — every operation addresses **one already-known
  session**.
- An embedding host supplies `inspect` / `continue` / `detach` callbacks and
  keeps its runtime's CLI, transport, authentication, and lifecycle policy
  entirely on its own side of the boundary.
- No specific runtime, vendor, provider, or CLI is assumed anywhere in these
  types.

Read [docs/architecture/runtime-boundary.md](../../docs/architecture/runtime-boundary.md)
for the normative ownership split, the normalized attachment and observation
contracts, and the explicit non-goals; and
[docs/guides/runtime-integration.md](../../docs/guides/runtime-integration.md)
for a worked host integration.

Relevant exports:

| Export | Purpose |
|---|---|
| `AgentSessionRuntimeRegistry` | Where a host registers one runtime's callbacks |
| `loadAgentSessionRuntimes`, `RUNTIME_MODULES_ENV` | Operator-named ES modules, for deployments that run a shipped binary |
| `AgentSessionRuntimeCallbacks` | The `inspect`/`continue`/`detach` shape a host implements |
| `AgentSessionObservation` | The loose reply a runtime may return |
| `AgentSessionStatus` / `AgentSessionState` | The normalized result and its closed state vocabulary |
| `normalizeAgentSessionObservation`, `dispatchAgentSession` | Normalization and single-session dispatch |
| `AgentSessionAttachment` | The durable, normalized attachment record |
| `LocalTmuxFleetAdapter` | Legacy local-only recovery path for pre-existing `claude-fleet` attachments — not a runtime selector |
