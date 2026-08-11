# Working in this repo

Last validated: 2026-08-08

## This repository is public

No private host, company, deployment, or agent name belongs in docs, source,
comments, examples, env vars, or test fixtures. `test/public-surface.test.ts`
enforces this and runs with the ordinary suite — read it before adding a name
you are unsure about.

Two things are deliberately allowed and are not leaks:

- `claude-fleet` — the real exported id of the legacy local adapter that ships
  here (`packages/core/src/fleet-adapter.ts`). Banning the string would hide
  the code rather than clean it up.
- The `lambda-curry` GitHub org in repository URLs — that is this project's
  actual public home.

## Docs: dated means historical

`docs/architecture/2026-*.md` and `docs/decisions/` are **historical build
records**. They describe the tree as it was, carry their own non-normative
banner, and are exempt from the name check. When a rename invalidates one,
**annotate it with a then/now map — never rewrite the body.** Tidying a record
makes it a worse record.

Undated docs are current and normative, and are fully checked:

- `docs/architecture/runtime-boundary.md` — what ClawConnect owns versus an
  embedding host
- `docs/architecture/runtime-registration.md` — how a host or operator
  registers a runtime, and where attachment state survives a restart
- `docs/guides/runtime-integration.md` — implementing the callbacks

## One tool surface, projected into transports

`packages/core/src/capability.ts` is the **only** place a tool is declared. A
capability is its description, schemas, annotations, authorization policy, and
handler together; `packages/mcp` (stdio) and `apps/chatgpt` (HTTP) project that
array and add nothing but transport concerns and model-facing text.

Do not declare a tool in a transport. The surface was previously written out
three times and the copies had already drifted — same argument documented
differently per transport, `outputSchema` on one only, identity handling on
one only, and the per-agent authorization check implemented three times.
`test/surface-parity.test.ts` compares what the two transports actually serve
and fails on any divergence, so adding a tool in one place alone will not pass.

Conventions the surface enforces, all covered by that test:

- Every read-only tool's description **opens with one `READ ONLY:` sentence**,
  and carries `readOnlyHint: true`. Both, deliberately: the spec calls
  `readOnlyHint` a hint clients need not trust, and a ChatGPT safety layer has
  been observed blocking a read **before the request ever reached the server**
  when a tool multiplexed reads and writes under one description. Keep the
  prefix to one sentence — the win is structural (a tool whose name,
  description, and schema tell one consistent story), not verbose prose.
- **`run_task` gets no danger framing.** The rule is one-directional: read
  tools disclaim mutation, and the mutating tool stays plainly factual. It
  briefly announced itself as "the only tool here that starts anything; every
  other tool in this connection is read-only", and ChatGPT began hard-blocking
  it pre-execution — no confirmation prompt, no job created, tool still listed.
  `run_task` queues work; it is not destructive (`destructiveHint: false`) and
  must not describe itself as though it were, least of all beside ten siblings
  that emphatically disclaim mutation. Reverting to the long-serving wording
  is the fix. `test/surface-parity.test.ts` guards it.
- Every tool declares an `outputSchema`: **strict on the chaining contract,
  permissive on everything else.** Fields a caller reads to decide its next
  call (`taskId`, `sessionKey`, `status`, `isTerminal`, `logCursor`,
  search hits' `file`) get declared types; `additionalProperties` stays open
  and `required` names only what EVERY branch returns. The SDK validates
  `structuredContent` against this server-side, so requiring a field the
  not-found branch omits turns an ordinary "not found" into a schema
  violation — `check_task` can answer without a `jobId`, and `get_task`'s
  `prompt` preset returns no `status` at all.
- `run_task` is the only capability that mutates anything.

## Deploying a tool-surface change

**ChatGPT freezes the approved tool snapshot.** Editing a declaration and
restarting the server is NOT enough: the connector keeps serving the catalog
approved at setup, so a renamed tool answers "Tool not found" while the server
is perfectly healthy. The owner must hit **Refresh** on the app's action
configuration to pull the new declarations, and **newly added actions arrive
disabled by default** and must be enabled explicitly.

Do not rely on `notifications/tools/list_changed` to do this. It is a real
protocol capability, but there is no evidence ChatGPT updates an approved app's
frozen snapshot from it, and none for Claude either.

So after changing any declaration: restart the service, then refresh/re-approve
the connector on each client, then confirm with `get_connection_info` —
its `toolsetVersion` is hashed from the declarations, so a client whose cached
catalog disagrees with the server's value is holding a stale snapshot rather
than talking to a broken server.

Both protocol eras are served by the SDK from one factory
(`createMcpHandler`, whose `legacy` option defaults to `'stateless'`). There is
no hand-rolled JSON-RPC router and no hand-maintained list of supported
protocol revisions — version negotiation belongs to the SDK. `get_connection_info`
reports the era from `McpRequestContext.era` and **omits** the revision when the
transport was never told one; never substitute a constant there.

## Tasks: our model is canonical, the extension is a future adapter

`run_task`/`check_task` hand-rolls what the `io.modelcontextprotocol/tasks`
extension standardises, and the vocabularies already nearly line up — its
`working`/`input_required`/`completed`/`failed`/`cancelled` against our
running/needs-human/completed/error, with `input_required` matching our
blocked-delegation case almost exactly.

Do not adopt it as the transport yet. It is absent from the published client
support matrix, and neither ChatGPT nor Claude negotiates it; MCP Inspector is
the one implementation to test against. Keep our job model canonical and keep
it shaped so that `tools/call → CreateTaskResult → tasks/get → tasks/update →
tasks/cancel` can later be a thin adapter over it — which mainly means not
baking today's `check_task` wire shape into the job model itself. The
capability layer is where that adapter goes.

## The runtime seam is optional

ClawConnect never starts, chooses, or enumerates an agent session. There is no
spawn and no list callback, and that is structural, not a policy — do not add
one. A default install registers **no** runtime: every MCP tool behaves
identically without one, and an attachment for an unregistered runtime reads
back as a normalized `unknown_runtime` result rather than an error.

A host either embeds the library and passes `agentSessionRuntimes`, or runs a
shipped binary and names ES modules via
`CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES`. If you change either path, update
the guide in the same change — a documented integration that the shipped binary
cannot perform is the exact bug that mechanism exists to fix.

## Verify

```bash
pnpm install
pnpm run ready                    # build + typecheck, all packages
./node_modules/.bin/vp test       # full suite
./node_modules/.bin/vp lint       # 7 pre-existing TS2322 in apps/chatgpt/src/widget/state.test.ts are baseline
                                  # (collectFollowUpWakes' Map/Set literals; count last checked 2026-08-10)
```

Assert behavior, not text. An earlier version of the hygiene test grepped the
entrypoints for a class name; a refactor renamed the symbol and the check
silently passed for the wrong reason.
