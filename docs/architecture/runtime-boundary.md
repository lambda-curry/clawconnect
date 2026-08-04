# Runtime boundary

**Status:** Normative. This document defines where ClawConnect stops and an
embedding host begins for managed agent sessions.

ClawConnect connects MCP clients to an OpenClaw instance. It also has an
**optional** seam for attaching a task to a *managed agent session* that some
other system already started — a session in a runtime ClawConnect does not
own, does not choose, and cannot start.

Everything in this document about runtimes is opt-in. A default install
registers no runtime and behaves exactly as it did before the seam existed
(see [Standalone behavior](#standalone-behavior)).

## The two sides

### ClawConnect owns

- **The attachment record.** One normalized record per OpenClaw session,
  describing at most one *current* managed session.
- **One-current-session authority.** A conversation has zero or one current
  attachment. Attaching something else is an explicit `replace`.
- **Replacement lineage.** Superseded and detached records are kept, never
  deleted, chained through `replacesAttachmentId`.
- **Restart durability.** Attachments persist alongside the job store and are
  rehydrated on boot.
- **Correlation guards.** An attachment is bound to the parent turn that
  delegated to it (`delegatedTurnId`), so a stale attachment cannot answer a
  later, unrelated task.
- **Freshness protection.** Every read takes a monotonic `observationToken`
  before it calls out; a slow read that lands after a newer one is discarded
  rather than rolling the record backwards.
- **Normalization.** Whatever a runtime replies with becomes one closed
  vocabulary — see [Observation contract](#observation-contract).
- **Dispatch of exactly one operation to exactly one already-known session,**
  under a hard wall-clock deadline, returning a structured result instead of
  throwing.

### The embedding host owns

Everything about the runtime itself:

- **Runtime choice.** Which runtime, which provider, which model.
- **Lifecycle.** Starting, resuming, supervising, retrying, and cleaning up
  sessions and their working directories.
- **Transport and authentication.** CLI syntax, HTTP/RPC endpoints, pairing,
  credentials, project or workspace selection.
- **Input and approval handling.** Answering a session that is blocked on a
  human, granting permissions, deciding when to give up.
- **Discovery.** Knowing which session a task belongs to *before* telling
  ClawConnect about it. ClawConnect never searches for one.
- **Policy.** Retries, fallbacks, escalation, and result collection.

None of that vocabulary appears in ClawConnect's types, and none of it needs
to: the host keeps it entirely on its own side of the callback boundary.

## Attachment contract

A host announces an already-running session by embedding a marker in the
`context` field of a `run_task` call. The marker is parsed out and **stripped
before the message reaches the agent**, so the agent's prompt never sees it.

```
<agent-session>{"runtime":"<runtime-id>","sessionId":"<id-in-that-runtime>","state":"running"}</agent-session>
```

| Field | Required | Meaning |
|---|---|---|
| `runtime` | yes | Which system owns the session's lifecycle. Opaque id, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. |
| `sessionId` | yes | The session's id **in that runtime's own namespace**. Plain path segment only. |
| `provider` | no | Which agent/model runs *inside* the session. Distinct from the runtime. |
| `providerSessionId` | no | The provider's own session/thread id — a different namespace from `sessionId`. |
| `host` | no | Which machine's runtime state owns the session, when that is meaningful. |
| `remoteUrl` | no | Where a human opens the session. |
| `state` | no | Initial state, from the vocabulary below. |
| `metadata` | no | Runtime-specific extras. Strings only. |

A marker always means *attach*: "this session exists, here is its state". It
is never a lifecycle command. Re-sending the same marker on every turn is safe
and expected — a marker naming the session that is already current folds into
a refresh rather than minting new lineage.

Explicit transitions (`attach`, `continue`, `replace`, `detach`, `inspect`)
use a delimited directive block in the same `context` field. `replace` and
`detach` require a `reason`; `detach` stops tracking the session locally and
only stops it in its runtime when the caller explicitly says
`"stopRuntime": true`. A malformed directive is ignored — the task still
submits normally.

There is deliberately **no new public MCP tool** for any of this. The tool
surface (`run_task`, `check_task`, `get_task`, `list_tasks`, `get_session`,
`list_sessions`) is unchanged.

The current attachment is emitted on task snapshots so a host can read it back
on every turn without a second call.

## Observation contract

Whatever a runtime replies with is normalized into one shape before anything
else reads it. The rules, enforced once for every runtime:

- **Identity comes from the request, never the reply.** A runtime cannot
  rename the session a conversation is attached to.
- **The state vocabulary is closed.** Anything unrecognized reads `unknown`.

  | State | Meaning |
  |---|---|
  | `starting` / `running` | Working. |
  | `idle` / `completed` | The turn finished. Two values because runtimes publish different terminal-success names; both are treated as a completed turn. |
  | `needs_input` / `needs_permission` | Blocked on a human. Must stay actionable — never papered over with leftover text. |
  | `stale` | Alive, but silent long enough to be suspicious. |
  | `dead` | Ran, then went away without finishing a turn. |
  | `failed` | Never came up. |
  | `unavailable` | Could not be reached from here. **Not** evidence the session failed. |
  | `unknown` | Reached, but said nothing recognizable. |

- **A final answer exists only in a completed-turn state.** Partial text from
  a running or blocked session can never be mistaken for the turn's result.
- **Termination only for terminal states**, derived from the state when the
  runtime did not say.
- **Timestamps are epoch milliseconds**, whether the runtime sent epochs or
  ISO strings.
- **A failed read is not a failed session.** "We could not reach the runtime"
  is stored as an error with a branchable code (`unknown_runtime`,
  `unsupported_operation`, `session_not_found`, `<op>_timeout`,
  `<op>_failed`), never as the session's state.
- **Metadata is strings only**, so a record stays trivially serializable.

## Extension seam

A host teaches ClawConnect about a runtime by registering an id, a provider,
and up to three callbacks — each addressing **one** session:

| Callback | Required | Purpose |
|---|---|---|
| `inspect` | yes | Read one session's current state. |
| `continue` | no | Deliver a follow-up turn to one session. |
| `detach` | no | Stop one session in its runtime. |

**Capabilities are derived from which callbacks were supplied, never
declared.** A runtime that announces `continue` support and has no continue
callback is a lie a caller discovers at the worst possible moment; here, the
absence of a callback *is* the absence of the capability, and asking for it
returns a precise `unsupported_operation`.

Every callback runs under a wall-clock deadline (30s by default) applied at
the seam, not left to each adapter, and receives an `AbortSignal` merging the
caller's with that deadline. A host that hangs cannot wedge a task's recovery
path.

The registry is an instance injected into the server factory, not a global —
two hosts in one process cannot silently share a runtime table.

### `HostRuntimeAdapter` — implementation-neutral example

The shape below is complete and deliberately says nothing about how the host
reaches its runtime. Substitute a subprocess, an HTTP call, a socket, or an
in-memory table — ClawConnect cannot tell the difference and does not try.

```ts
import { AgentSessionRuntimeRegistry } from "@clawconnect/core";
import type {
  AgentSessionCallOptions,
  AgentSessionObservation,
  AgentSessionRef,
} from "@clawconnect/core";

/**
 * Whatever the host already uses to talk to its runtime. ClawConnect never
 * sees this type — it is the host's own transport, CLI, or client library.
 */
interface HostRuntimeClient {
  read(sessionId: string, signal?: AbortSignal): Promise<HostSessionState | null>;
  send(sessionId: string, prompt: string, signal?: AbortSignal): Promise<HostSessionState>;
  stop(sessionId: string, signal?: AbortSignal): Promise<HostSessionState>;
}

interface HostSessionState {
  status: string;
  running?: boolean;
  updatedAt?: number | string;
  lastMessage?: string;
  answer?: string;
}

/** Map the host's own status names onto the closed vocabulary. */
function toState(s: HostSessionState): AgentSessionObservation["state"] {
  switch (s.status) {
    case "queued":
    case "booting":
      return "starting";
    case "working":
      return "running";
    case "awaiting_input":
      return "needs_input";
    case "awaiting_approval":
      return "needs_permission";
    case "done":
      return "completed";
    case "crashed":
      return "dead";
    default:
      return "unknown"; // never invent a state the runtime did not report
  }
}

function observe(s: HostSessionState): AgentSessionObservation {
  const state = toState(s);
  return {
    state,
    alive: s.running,
    lastEventAt: s.updatedAt,
    latestResponse: s.lastMessage,
    // Honored only in a completed-turn state; safe to always supply.
    finalResponse: s.answer,
  };
}

export function registerHostRuntime(client: HostRuntimeClient): AgentSessionRuntimeRegistry {
  const runtimes = new AgentSessionRuntimeRegistry();

  runtimes.register({
    id: "example-runtime",
    provider: "example-provider",

    // Required. `null`/`undefined` means "this runtime has no such session" —
    // which normalizes to unavailable + session_not_found, not to a failure.
    async inspect(ref: AgentSessionRef, opts: AgentSessionCallOptions) {
      const state = await client.read(ref.sessionId, opts.signal);
      return state ? observe(state) : null;
    },

    // Optional. Omit it and `continue` reports as unsupported rather than
    // silently doing nothing. Dispatches a turn; it does not wait for it.
    async continue(ref, request, opts) {
      if (!request.prompt) return null;
      return observe(await client.send(ref.sessionId, request.prompt, opts.signal));
    },

    // Optional. Ending someone else's session is not recoverable, so this is
    // only ever reached through an explicit, opt-in detach.
    async detach(ref, request, opts) {
      return observe(await client.stop(ref.sessionId, opts.signal));
    },
  });

  return runtimes;
}
```

Wire the registry into whichever server the host embeds:

```ts
createMcpServer({ registry, agentSessionRuntimes: registerHostRuntime(client) });
createApp(registry, { agentSessionRuntimes: registerHostRuntime(client) });
```

An operator running a *published binary* instead names ES modules to load, via
`CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES` — same trust level as
`agents.json`, and never influenced by a caller or an agent. Without it nothing
is registered at all; see [runtime-registration.md](runtime-registration.md).

Neither entry point registers a runtime on its own. See
[the integration guide](../guides/runtime-integration.md) for the full
inspect/continue/detach walkthrough.

## Non-goals

ClawConnect will not:

- **Start a session.** There is no spawn operation, in the registry or
  anywhere else.
- **Enumerate sessions.** There is no list callback, so there is no code path
  through which ClawConnect could sweep a runtime's sessions. "No heuristic
  scanning" is structural, not a policy someone has to remember.
- **Choose a runtime or a provider.** It records the one it was told about.
- **Reproduce a runtime's CLI, transport, pairing, project model,
  authentication, approval flow, retry policy, or working-directory
  management.** All of that stays with the host.
- **Terminate a running parent task because a managed session changed.**
  There is no listener, timer, or webhook that pushes managed-session state
  into a still-running job.
- **Be a workflow or orchestration engine.**
- **Assume any particular runtime, product, vendor, or CLI exists.**

## Standalone behavior

With no runtime registered — the default for both the stdio MCP server and the
ChatGPT HTTP app — ClawConnect is exactly what it was before this seam:

- Every MCP tool behaves identically. No tool, argument, or response field is
  gated on a runtime being present.
- No callback is ever invoked, because none exists.
- If a task carries no attachment, the attachment code is never reached at
  all: reads are a keyed lookup on one session, not a scan.
- If a task *does* carry an attachment for a runtime this build has never
  heard of — for example a record written by a differently-configured
  deployment, or restored after the host's wiring was removed — it reads back
  as a normal `unavailable` observation with code `unknown_runtime`, carrying
  the last state anyone reported. It does not error, and it does not fail the
  task.

A delegation can never make a ClawConnect task fail. That is the point of
returning structured unavailability instead of throwing.

### Legacy local adapter

One built-in adapter predates this seam and remains for backward
compatibility: a local-only recovery path for existing `claude-fleet`
attachments, which reads tmux liveness and a terminal transcript. It is
**not** a runtime selector and not a general integration path:

- It is consulted only for an attachment whose `runtime` is exactly
  `claude-fleet`.
- A host that registers `claude-fleet` itself takes precedence over it.
- It offers `inspect` only — a tmux probe cannot deliver a turn or end a
  session, so `continue`/`detach` report as unsupported.
- It reports liveness and nothing else. It never claims a state, because a
  bare liveness bit cannot distinguish "working" from "waiting on a human".

New runtime wiring belongs in a host-supplied registry, not here.

## Keeping this boundary honest

`test/public-surface.test.ts` enforces the parts of this document that code
can contradict, and runs with the ordinary suite (`vp test`). It asserts that:

- public docs and shipped source name no private host, company, or agent;
- no document references an internal absolute path or thread/artifact id;
- neither entry point registers a runtime of its own.

Two deliberate exemptions. The legacy adapter's id `claude-fleet` is allowed
everywhere, because it is a real exported identifier in this repository and
banning the string would hide the code rather than clean it up. The dated
documents under `docs/architecture/` and `docs/decisions/` are historical
build records carrying their own non-normative banners; they are checked for
internal references but not for host names, since rewriting a record to look
tidier makes it a worse record.
