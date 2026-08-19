# Example: a local-tmux agent-session runtime

A runnable answer to "what does a runtime module actually look like?"

ClawConnect ships **no** runtime. It offers a place to attach a session and its
metadata, and a callback seam a host registers into — see
[`docs/architecture/runtime-boundary.md`](../../docs/architecture/runtime-boundary.md)
and [`docs/guides/runtime-integration.md`](../../docs/guides/runtime-integration.md).
This directory is one such host module, kept as an example rather than as
shipped code.

## Run it

```bash
CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES=/abs/path/to/examples/local-tmux-runtime/runtime.mjs \
  clawconnect-mcp
```

The connector logs `[agent-session] registered runtime(s): claude-fleet` on
startup. Nothing else about the connector changes; every MCP tool behaves
identically with or without it.

## What it drives

Sessions that run as local `tmux` panes with a Claude Code transcript on disk,
found through `~/.claude-fleet/<handle>/meta.json` → `transcriptPath`. It
answers one callback, `inspect`, and reports only what it can prove:

| Observed | Reported | Why |
| --- | --- | --- |
| pane alive | `{ alive: true }`, no `state` | A liveness bit cannot tell "working" from "waiting on a human". Claiming either would let the probe overwrite a status the host stated explicitly. |
| pane gone + dated transcript entry | `{ state: "completed", finalResponse, lastEventAt }` | The pane having ENDED is what makes the transcript safe to read as final; the entry dates itself, so the answer can be correlated to the job asking. |
| anything else | `{ alive: false }` | "No news" is a legitimate answer, and every failure here collapses to it — nothing throws. |

`continue` and `detach` are deliberately absent: a tmux pane cannot be handed a
follow-up turn or be ended meaningfully from here. ClawConnect turns a request
for an absent callback into a precise `unsupported_operation` answer, which
tells a caller more than a silent no-op would.

## The part worth copying

The trust gate lives **here**, not in ClawConnect. How sure a runtime must be
before it claims a completed turn depends on evidence only that runtime can
see, so ClawConnect does not try to second-guess it — it applies its own
checks on top (the turn must be a completed one, the result must be datable,
and it must post-date the job it would answer) and otherwise takes the
module's word.

Plain JavaScript with no build step and no import from `@clawconnect/core`, on
purpose. A runtime module needs nothing from ClawConnect but the registry
object it is handed.
