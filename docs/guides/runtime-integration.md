# Integrating a host-supplied runtime

**Audience:** you embed ClawConnect (the stdio MCP server or the ChatGPT HTTP
app) inside a system that *already* starts and supervises agent sessions of
its own, and you want a ClawConnect task to be able to read, continue, or
release one of those sessions.

**Prerequisite:** you already know which session a task belongs to. This
integration addresses **one already-known session at a time**. There is no
discovery step, and adding one is not possible through this seam — see
[the runtime boundary](../architecture/runtime-boundary.md#non-goals).

Nothing here is required. Skip this entire document and ClawConnect works
normally; no tool, argument, or response field depends on a runtime existing.

## What you are responsible for

| You | ClawConnect |
|---|---|
| Starting the session | Recording the one you name |
| Knowing its id | Normalizing whatever you report about it |
| Transport, auth, project selection | Bounding every call and folding the answer into a durable record |
| Retries, approvals, cleanup | Keeping at most one current session per conversation, with lineage |

## 1. Register the runtime

Build one registry for your process and hand it to the server factory.

```ts
import { AgentSessionRuntimeRegistry } from "@clawconnect/core";

const runtimes = new AgentSessionRuntimeRegistry();

runtimes.register({
  id: "example-runtime",       // your own id; [A-Za-z0-9][A-Za-z0-9._-]{0,63}
  provider: "example-provider", // which agent/model runs inside the session
  async inspect(ref, opts) {
    /* … */
  },
});
```

```ts
// stdio MCP server
const { server } = createMcpServer({ registry, agentSessionRuntimes: runtimes });

// ChatGPT HTTP app
const { requestListener } = createApp(registry, { agentSessionRuntimes: runtimes });
```

The registry is shared across every OpenClaw agent in the process on purpose:
a runtime is a property of your deployment, not of an agent. It is an
instance, not a global — nothing is registered unless you register it.

Register only the callbacks you can actually honor. Capabilities are derived
from what you supply, so an absent callback becomes a precise
`unsupported_operation` for anyone who asks, rather than a silent no-op.

### …or from a shipped binary, without embedding

The code above only works if you construct the server yourself. If you run the
published `clawconnect-mcp` binary or the ChatGPT app as-is, name one or more ES
modules instead — the same trust level as `~/.clawconnect/agents.json`, and
operator configuration only, never anything a caller or an agent can influence:

```bash
CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES=/opt/acme/runtime-bridge/register.mjs
```

Each module exports `registerAgentSessionRuntimes(registry)` (or a default
function of the same shape) and registers whatever it can answer for:

```js
export function registerAgentSessionRuntimes(registry) {
  registry.register({
    id: "example-runtime",
    provider: "example-provider",
    inspect: (ref, opts) => /* your own transport */,
    continue: (ref, request, opts) => /* … */,
  });
}
```

Specifiers are comma- or newline-separated and may be bare package names,
absolute paths, or paths relative to the process cwd. Loading **never throws**:
a module that is missing, fails to import, exports no registrar, or throws while
registering is logged and skipped, because every task that does not involve a
delegation still has to work. Unset, nothing is registered at all.

Attachment lineage survives a restart wherever the deployment puts it —
`CLAWCONNECT_ATTACHMENT_STORE_DIR` for the stdio server (default
`~/.clawconnect/attachments`); the ChatGPT app persists alongside its job store.

See [runtime-registration.md](../architecture/runtime-registration.md) for the
full wiring reference.

## 2. Tell a task which session it is attached to

Include a marker in the `context` field of the `run_task` call. ClawConnect
parses it out and strips it before the message reaches the OpenClaw agent.

```json
{
  "task": "finish the migration",
  "context": "<agent-session>{\"runtime\":\"example-runtime\",\"sessionId\":\"sess-42\",\"state\":\"running\"}</agent-session>"
}
```

Send the same marker on every turn. A marker naming the session that is
already current is folded into a refresh, not a new attachment, so this is
idempotent by design.

Field reference is in
[the attachment contract](../architecture/runtime-boundary.md#attachment-contract).

## 3. `inspect` — the only required callback

`inspect` answers "what is this one session doing right now?".

```ts
async inspect(ref, opts) {
  // ref.sessionId is the id you supplied in the marker, in your namespace.
  const state = await client.read(ref.sessionId, opts.signal);

  // null/undefined means "no such session here". That normalizes to
  // unavailable + session_not_found — not to a failure of the session,
  // and not to a thrown error.
  if (!state) return null;

  return {
    state: "running",         // from the closed vocabulary
    alive: true,
    lastEventAt: state.updatedAt,   // epoch ms or an ISO string, either is fine
    latestResponse: state.lastMessage,
  };
}
```

Rules worth internalizing:

- **Report only what you observed.** If you cannot tell, omit the field.
  `alive: undefined` means "could not determine", which is different from
  `alive: false` ("gone").
- **Never report `unavailable` to describe the session.** That value describes
  a failed *read*. If your transport failed, throw or return an `error` — the
  seam turns either into a structured unavailable result for you.
- **`finalResponse` is honored only in a completed-turn state** (`completed`
  or `idle`). You may always supply it; it is dropped when the session has not
  actually finished a turn, which is what prevents a partial answer from being
  mistaken for a result.
- **Do not echo identity.** `runtime` and `sessionId` come from the request.
  An observation that renamed the session would silently replace the
  conversation's one attachment, so those fields are ignored if you send them.

Blocked states matter: report `needs_input` or `needs_permission` honestly.
A blocked session is never papered over with leftover transcript text — it
stays visible and actionable in the task snapshot.

## 4. `continue` — deliver a follow-up turn

Optional. Omit it and continuation reports as unsupported.

```ts
async continue(ref, request, opts) {
  if (!request.prompt) return null;
  const state = await client.send(ref.sessionId, request.prompt, opts.signal);
  return { state: "running", alive: true, latestResponse: state.lastMessage };
}
```

`continue` **dispatches** a turn — it must not block until the turn finishes.
The default deadline for any single callback is 60 seconds
(`AGENT_SESSION_CALL_TIMEOUT_MS`), and a host that
waits out a whole agent turn inside it will simply be cut off with a
`continue_timeout`. Report the state you can see immediately and let the next
`inspect` carry the result.

A caller drives this by embedding an explicit directive rather than a marker:

```json
{
  "context": "[[clawconnect:agent-session]]{\"op\":\"continue\",\"prompt\":\"also update the docs\"}[[/clawconnect:agent-session]]"
}
```

Omit `prompt` and `continue` means the historical thing: re-affirm that this
parent turn is delegated to the current attachment, without driving your
runtime at all.

## 5. `detach` — release the session

Optional. Detaching is **local and reversible by default**: it stops
ClawConnect tracking the session, and your `detach` callback is invoked only
when the caller explicitly opts into stopping the session in your runtime.

```json
{
  "context": "[[clawconnect:agent-session]]{\"op\":\"detach\",\"reason\":\"work finished\",\"stopRuntime\":true}[[/clawconnect:agent-session]]"
}
```

```ts
async detach(ref, request, opts) {
  const state = await client.stop(ref.sessionId, opts.signal);
  return { state: "completed", alive: false, termination: { reason: "cancelled" } };
}
```

Without `"stopRuntime": true` the detach is recorded locally, with its reason,
and your runtime is never called — ending someone else's agent session is not
recoverable, so it has to be asked for.

Detached and superseded records are kept, not deleted. Lineage stays readable.

## 6. Replacing an attachment

Pointing a conversation at a different session is explicit and requires a
reason:

```json
{
  "context": "[[clawconnect:agent-session]]{\"op\":\"replace\",\"runtime\":\"example-runtime\",\"sessionId\":\"sess-43\",\"host\":\"worker-1\",\"reason\":\"restarted after a crash\"}[[/clawconnect:agent-session]]"
}
```

The previous record is marked superseded and the new one records what it
replaced. A conversation still has exactly one current session.

## 7. Reading the result back

The current attachment rides along on task snapshots as `agentSession` — in
`check_task`, `get_task`, and `get_session` — so you can branch on it every
turn without a separate call. Expect:

- `state` from the closed vocabulary, plus `alive` when the runtime could say.
- `error` with a machine-branchable `code` when a *read* failed:
  `unknown_runtime`, `unsupported_operation`, `session_not_found`,
  `inspect_timeout`, `continue_failed`, and so on.
- `lastResult` only from a genuinely completed turn, with a capped summary and
  a durable `outputRef` so full text stays re-derivable rather than copied.
- `latestResponse` for what the session is saying *now* — deliberately
  separate, because it is exactly the thing that must never be read as the
  turn's answer.

A delegation never fails a ClawConnect task. If your runtime is unreachable,
unregistered, or hung, the task still completes on its own terms and the
attachment carries a precise reason.

## Failure modes and what they mean

| Code | Cause | Not what it means |
|---|---|---|
| `unknown_runtime` | This build has no runtime registered under that id | The session is gone |
| `unsupported_operation` | You registered no callback for that operation | The operation failed |
| `session_not_found` | Your `inspect` returned null | The session failed |
| `<op>_timeout` | Your callback did not answer within the deadline | The session is stuck |
| `<op>_failed` | Your callback threw | The session errored |

Every one of these is a statement about the *read*, never about the session,
which may be working away perfectly well on the other side of a wedged
transport.

## Testing your adapter

Register a fake runtime whose callbacks return canned observations, submit a
task carrying a marker for it, and assert on the attachment in the snapshot.
`packages/core/src/agent-session.test.ts` and
`packages/core/src/agent-session-attachment.test.ts` do exactly this and are a usable
template; neither touches a live gateway or a real runtime.

## Related

- [Runtime boundary](../architecture/runtime-boundary.md) — normative
  ownership split, contracts, and non-goals.
- [`@clawconnect/core` README](../../packages/core/README.md) — the exported
  types this guide references.
