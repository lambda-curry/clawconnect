# chatgpt-openclaw

A small MCP app that lets ChatGPT hand work off to OpenClaw, then watch the run through a polling widget.

## Development

```bash
npm install
npm run dev
```

Then open <http://localhost:7331>.

## Tool lifecycle

The app intentionally keeps the server-side flow simple:

1. `run_openclaw_task` submits work to OpenClaw and returns quickly.
2. The tool response includes a `jobId` plus the `sessionKey` that owns the OpenClaw conversation.
3. ChatGPT mounts the widget from the same tool response.
4. The widget polls `check_openclaw_task` until the run finishes, errors, or reaches a user-waiting state.

This keeps `run_openclaw_task` cheap and retry-friendly while preserving live progress in the widget.

## Widget lifecycle

The widget is responsible for presentation only:

- It starts from the `run_openclaw_task` tool output.
- It calls `check_openclaw_task` with `knownLogCount` so the server can return early when new log lines arrive.
- It renders three layers of state:
  - live activity log
  - compact outcome/details panel
  - context-aware follow-up actions
- On terminal states it asks ChatGPT for a follow-up summary via the host's `sendFollowUpMessage` surface so the chat thread gets a natural continuation.
  - If the widget is remounted from cached run state, it will also re-emit a summary once if a completion handoff wasn't previously sent.
  - True push/notification delivery from this surface is not supported; if the widget is fully unmounted, host re-awakening requires a refreshed mount to replay state.

The server now also returns a small `widgetStatus` object and normalized `details` payload so the widget does not need to reverse-engineer state from raw artifacts alone.

The widget also persists the active run snapshot locally (`jobId`, `sessionKey`, `startedAt`, current widget status, details, logs, and final summary/error payload) so a refresh can recover cleanly. On reload it prefers the latest tool output when present, otherwise it restores the last saved run, reattaches polling for in-flight jobs, and restores terminal views without unnecessary re-polling. Status checks now include both `jobId` and `sessionKey`, which lets the server reattach more reliably when a refreshed client has stale local job state.

## `sessionKey` continuation

`sessionKey` is the continuity handle for the underlying OpenClaw conversation.

- Omit it to start a fresh conversation.
- Pass a previous `sessionKey` back into `run_openclaw_task` to continue the same thread.
- The adapter stores the most recent continuation state per session so the widget and follow-up prompts can surface recommended next steps.

This means you can do multi-step work like:

1. ask OpenClaw to make changes
2. review the outcome
3. continue with the same `sessionKey` to create a PR, answer a question, or refine the result

The widget keeps that resume path explicit in its follow-up actions: resuming the previous session is presented separately from starting a fresh task so users do not accidentally fork the wrong thread of work.

## How `run_openclaw_task` and `check_openclaw_task` are expected to work

### `run_openclaw_task`

Expected behavior:

- accept a task plus optional context/workspace/sessionKey
- enqueue/send the task to OpenClaw
- return immediately with identifying state (`jobId`, `sessionKey`)
- include lightweight UI metadata needed by the widget to start cleanly

It should **not** block waiting for the full run to finish.

### `check_openclaw_task`

Expected behavior:

- accept a `jobId` (and optionally a `sessionKey` for refresh recovery / stale-client reattachment)
- wait briefly for progress or completion (long-poll style)
- return normalized state for the widget:
  - raw run status (`running`, `completed`, `error`)
  - widget-facing status (`running`, `waiting`, `completed`, `error`)
  - normalized details (files changed, branch, commit, PR URL, human-decision flag, recommended next step)
  - logs and final summary/error text when available

This endpoint is the single polling surface for the widget.

## Notes

- No GitHub Actions or extra infrastructure required.
- The adapter keeps artifact extraction intentionally lightweight and heuristic-based.
- The widget uses translucent panels + border accents that adapt to host light/dark theme so it blends in with the ChatGPT surface while preserving contrast.
- The UI favors clear state semantics over elaborate visuals.
