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
./node_modules/.bin/vp lint       # 6 pre-existing TS2345 in packages/mcp/src/server.ts are baseline
```

Assert behavior, not text. An earlier version of the hygiene test grepped the
entrypoints for a class name; a refactor renamed the symbol and the check
silently passed for the wrong reason.
