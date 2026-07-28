# ClawConnect task contract

**Status:** Accepted direction; implementation remains transitional  
**Date:** 2026-07-27

This is the portable, non-UI contract. A UI may progressively enhance it, but
must not own correctness, task persistence, or recovery.

## Decisions

1. Public tool names stay unversioned. Git commits record experiments and
   changes; do not create `_v2` names for contract experiments.
2. The core surface is `run_task`, `check_task`, `get_task`, and `list_tasks`.
   `list_tasks` is the aggregate view of active work.
3. `run_task` returns promptly with `jobId`/`taskId`, `sessionKey`, status,
   continuation metadata, and an exact next action.
4. `check_task` owns server-side waiting. The default wait target is 45 seconds
   and callers may override it. Ordinary progress does not end a wait early;
   terminal or actionable states do (`completed`, `completed_no_summary`,
   `error`, `blocked`, `needs_human`).
5. A wait timeout is non-terminal. Return `continuePolling: true` and direct the
   caller to invoke `check_task` again immediately with the same identifiers.
   Never create a duplicate task because polling timed out.
6. `get_task` is an immediate snapshot for diagnostics, manual reads, and UI.
   Task identity is split deliberately: `taskId` identifies one execution;
   `sessionKey` identifies conversational continuity. Multiple tasks and
   sessions may coexist.
7. Rich snapshots should expose elapsed time, phase, latest meaningful update,
   poll count, and a compact timeline/summary when available. Add request-level
   telemetry for tool name, job/task ID, poll number, wait duration, returned
   status, request duration, duplicate-job detection, and terminal retrieval.
8. MCP safety/idempotency annotations classify intent only; they are not
   behavioral guarantees.
9. Current evidence is that ChatGPT can repeatedly poll long runs successfully,
   while the Activity UI can make a healthy 10+ minute run appear stuck. The
   portable contract must therefore remain usable with UI absent.
10. UI exploration is reopened as optional progressive enhancement. The server
    remains authoritative, and UI behavior must have a non-UI fallback.

## Transitional implementation note

The current checkout still exposes compatibility behavior, including the
existing long-poll defaults and implementation-specific status shapes. The
record above is the target decision boundary for the next experiment; it is not
a claim that production has already been migrated. The next evidence-producing
step is a pinned draft-app comparison of the existing wait path, a bounded
hybrid wait, and immediate snapshots with request/task telemetry and duplicate
detection.

## Sources

- [ClawConnect repository](https://github.com/lambda-curry/clawconnect)
- Local ChatGPT stall report: `/Users/minip3/clawd/tasks/2026-07-27-clawconnect-chatgpt-stall/report.md`
- [Arbor discussion](https://arborthreads.com/threads/thr_9dfe1478-deeb-4925-a10b-5de393e8113d)
