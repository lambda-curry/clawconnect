# /claw — Chat with an OpenClaw instance

Send a task to an OpenClaw agent (e.g. clawdy) via the clawconnect MCP server and handle the response.

**Usage:** `/claw <task description>`

## Arguments

`$ARGUMENTS` is the task to send. If empty, ask the user what they want to send.

## MCP Tools

This skill uses the `clawconnect` MCP server which provides three tools:
- `run_task` — Submit a task, returns jobId + sessionKey immediately
- `check_task` — Poll for progress (blocks up to 50s per call)
- `list_sessions` — List active sessions

## Workflow

### 1. Gather context

Before sending the task, gather useful context to include:
- Current git branch and recent commits: `git log --oneline -5`
- If the task references specific files, read them and include key excerpts
- If relevant, include a brief `git diff --stat` of recent changes

Keep context concise — don't dump entire files. Summarize what clawdy needs to know.

### 2. Submit the task

Call `run_task` with the task description and gathered context:

```
run_task({
  task: "<task description>",
  context: "<gathered context>"
})
```

If continuing a previous session, include the `sessionKey`:
```
run_task({
  task: "<follow-up task>",
  sessionKey: "<key from previous result>"
})
```

This returns immediately with a `jobId` and `sessionKey`.

### 3. Poll for completion

Call `check_task` in a loop until the status is no longer `"running"`:

```
check_task({
  jobId: "<jobId from run_task>",
  mode: "wait"
})
```

The `mode: "wait"` setting blocks for up to 50 seconds per call, only returning when the task completes or the poll window expires. This minimizes round-trips — a typical 3-minute task needs only ~4 check calls.

If status is still `"running"`, call `check_task` again. Keep going until you get a terminal status.

### 4. Handle the result

When `check_task` returns a terminal status, the response includes:

- `status`: "completed", "completed_no_summary", or "error"
- `summary`: clawdy's response text
- `artifacts.filesChanged`: list of files modified
- `artifacts.branchName`: branch clawdy worked on
- `artifacts.commitSha`: commit hash
- `artifacts.prUrl`: PR URL if one was created
- `artifacts.needsHumanDecision`: true if clawdy is waiting for input
- `continuationState.sessionKey`: save this for session continuation
- `continuationState.recommendedNextStep`: suggested follow-up
- `errorInfo.category` and `errorInfo.suggestedRecovery`: on errors

Present the results clearly:
- Lead with the summary
- List artifacts (files, branch, PR) if any
- If `needsHumanDecision` is true, highlight that clawdy needs input
- If there's a branch, offer to pull and review changes
- Always mention the session can be continued (you track the session key)

### 5. Session continuation

When the user wants to follow up ("tell clawdy to also...", "ask clawdy about..."), reuse the `sessionKey` from the previous result. This continues the same conversation thread in OpenClaw.

## Notes

- If the MCP server isn't connected, tell the user to check that their OpenClaw instance is running and the clawconnect MCP server is configured in settings.json.
- The `mode: "wait"` is important — without it, check_task returns on every log event which wastes tool calls.
- You can use `list_sessions` to see all active sessions if the user wants to reconnect to a previous thread.
