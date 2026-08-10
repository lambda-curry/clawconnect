import { describe, expect, it } from "vitest";
import {
  buildRunTaskStructuredContent,
  buildCheckTaskStructuredContent,
  buildGetTaskStructuredContent,
} from "./structured-content.ts";
import type { CheckTaskResult, JobSnapshot, RunTaskResult } from "./types.ts";

/**
 * Both packages/mcp/src/server.ts and apps/chatgpt/src/index.ts call these
 * exact builders for structuredContent, so testing the builders here proves
 * cross-transport shape identity by construction — there is no separate
 * "compare transport A vs transport B" test to keep in sync.
 */

function fixtureSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    jobId: "job-1",
    sessionKey: "session-1",
    status: "running",
    execution: "running",
    upstream: "connected",
    transcript: "live",
    cancellation: "none",
    startedAt: 1000,
    lastEventAt: 1500,
    lastPollAt: 2000,
    logs: [{ ts: 1200, type: "tool", text: "ran a command", seq: 1 }],
    logCursor: 1,
    logEventCount: 1,
    artifacts: { filesChanged: [], commandsRun: [], needsHumanDecision: false },
    agent: "test-agent",
    pollCount: 3,
    continuePolling: true,
    retryAfterMs: 0,
    nextAction: { tool: "check_task", args: { jobId: "job-1", sessionKey: "session-1" } },
    ...overrides,
  };
}

function fixtureFoundResult(snapshotOverrides: Partial<JobSnapshot> = {}): Extract<CheckTaskResult, { found: true }> {
  const snapshot = fixtureSnapshot(snapshotOverrides);
  const isTerminal = snapshot.status !== "running";
  return { found: true, snapshot, isTerminal, isError: snapshot.status === "error", continuePolling: !isTerminal };
}

describe("buildRunTaskStructuredContent", () => {
  it("is client-neutral: identifiers, status, agent, nextAction — no prompt content, ever", () => {
    const result: RunTaskResult = {
      jobId: "job-1",
      taskId: "job-1",
      sessionKey: "session-1",
      status: "running",
      execution: "running",
      upstream: "reconnecting",
      transcript: "detached",
      cancellation: "none",
      agent: "test-agent",
      nextAction: { tool: "check_task", args: { jobId: "job-1", sessionKey: "session-1" } },
    };
    const structured = buildRunTaskStructuredContent(result);

    expect(structured).toEqual({
      jobId: "job-1",
      taskId: "job-1",
      sessionKey: "session-1",
      status: "running",
      execution: "running",
      upstream: "reconnecting",
      transcript: "detached",
      cancellation: "none",
      agent: "test-agent",
      nextAction: { tool: "check_task", args: { jobId: "job-1", sessionKey: "session-1" } },
    });
    // RunTaskResult has no prompt/task/context field to begin with — this
    // assertion documents that guarantee rather than testing a redaction step.
    expect(Object.keys(structured).sort()).toEqual([
      "agent",
      "cancellation",
      "execution",
      "jobId",
      "nextAction",
      "sessionKey",
      "status",
      "taskId",
      "transcript",
      "upstream",
    ]);
  });
});

describe("buildCheckTaskStructuredContent", () => {
  it("carries the full snapshot plus isTerminal/isError, regardless of terminal state", () => {
    const running = fixtureFoundResult({ status: "running" });
    const structuredRunning = buildCheckTaskStructuredContent(running);
    expect(structuredRunning.status).toBe("running");
    expect(structuredRunning.isTerminal).toBe(false);
    expect(structuredRunning.continuePolling).toBe(true);
    expect(structuredRunning.pollCount).toBe(3);

    const terminal = fixtureFoundResult({ status: "completed", summary: "done", continuePolling: false, nextAction: null });
    const structuredTerminal = buildCheckTaskStructuredContent(terminal);
    expect(structuredTerminal.status).toBe("completed");
    expect(structuredTerminal.isTerminal).toBe(true);
    expect(structuredTerminal.continuePolling).toBe(false);
    expect(structuredTerminal.nextAction).toBeNull();
    expect(structuredTerminal.summary).toBe("done");
  });
});

describe("buildGetTaskStructuredContent", () => {
  it("respects the detail preset and matches check_task's field naming (taskId/jobId both present)", () => {
    const result = fixtureFoundResult({ summary: "the answer", artifacts: { filesChanged: ["a.ts"], commandsRun: [], needsHumanDecision: false } });

    const core = buildGetTaskStructuredContent(result, "core");
    expect(core).not.toHaveProperty("summary");
    expect(core).not.toHaveProperty("updates");
    expect(core).not.toHaveProperty("artifacts");
    expect(core.taskId).toBe("job-1");
    expect(core.jobId).toBe("job-1");

    const summary = buildGetTaskStructuredContent(result, undefined); // default preset
    expect(summary.summary).toBe("the answer");
    expect(summary).not.toHaveProperty("updates");

    const full = buildGetTaskStructuredContent(result, "full");
    expect(full.summary).toBe("the answer");
    expect(full.updates).toEqual(result.snapshot.logs);
    expect(full.artifacts).toEqual(result.snapshot.artifacts);
    expect(full).not.toHaveProperty("diagnostics");

    const diag = buildGetTaskStructuredContent(result, "diagnostics");
    expect(diag.diagnostics).toBeDefined();
  });

  const ALL_DETAILS = ["core", "summary", "updates", "artifacts", "diagnostics", "full", "fullWithDiagnostics"] as const;

  /**
   * A TaskSummary ROW carries `liveness` (see toTaskSummary) so a listing can
   * label a quiet run honestly without a per-row get_task. The drill-down has
   * to be able to CONFIRM what the row claimed: JobLiveness says absence means
   * "nothing has had cause to look yet", so a get_task that dropped the field
   * told the caller the opposite of the row they were drilling into.
   */
  it("lets the detail read confirm the freshness evidence a listing row already claimed", () => {
    const liveness = { checkedAt: 1900, upstream: "active" as const, producing: false };
    const result = fixtureFoundResult({ liveness, parentRunId: "run-abc123" });

    for (const detail of ALL_DETAILS) {
      const payload = buildGetTaskStructuredContent(result, detail);
      expect(payload.liveness, `liveness missing at detail=${detail}`).toEqual(liveness);
      expect(payload.parentRunId, `parentRunId missing at detail=${detail}`).toBe("run-abc123");
    }
  });

  it("adds no key for a job that has neither — absence stays absence on the wire", () => {
    const result = fixtureFoundResult({});
    for (const detail of ALL_DETAILS) {
      // Round-tripped, because that is what a client actually receives: an
      // explicit `undefined` value is dropped by JSON.stringify, so this proves
      // the field is genuinely absent rather than present-and-empty.
      const wire = JSON.parse(JSON.stringify(buildGetTaskStructuredContent(result, detail)));
      expect(wire).not.toHaveProperty("liveness");
      expect(wire).not.toHaveProperty("parentRunId");
    }
  });

  it("keeps the diagnosable failure diagnosable: the run id survives next to the error that names it", () => {
    // The late-recovery hard-cap outcome — an `error` whose whole point is that
    // a human can go look at the upstream run it names. A payload that carries
    // the complaint but not the id cannot be checked against anything.
    const result = fixtureFoundResult({
      status: "error",
      error: "Stopped watching after 90m: upstream run run-abc123 was last reported executing 4m ago",
      errorInfo: { category: "timeout", message: "…", suggestedRecovery: "Do not re-submit on this session…" },
      terminalReason: "late-recovery-upstream-still-active",
      parentRunId: "run-abc123",
      liveness: { checkedAt: 1900, upstream: "active", producing: false },
      nextAction: null,
    });

    const diag = buildGetTaskStructuredContent(result, "fullWithDiagnostics");
    expect(diag.parentRunId).toBe("run-abc123");
    // The error text itself is preset-gated under `diagnostics` (it is
    // unbounded); the run id is not, so the id is reachable even from a
    // caller who never asks for diagnostics — which is the point.
    const diagnostics = diag.diagnostics as { error?: string };
    expect(diagnostics.error).toContain(String(diag.parentRunId));
    // And the evidence behind the complaint travels with it, so a caller can
    // see the claim is dated rather than a present-tense confirmation.
    expect(diag.liveness).toEqual({ checkedAt: 1900, upstream: "active", producing: false });
  });

  it("never includes the prompt — that's a distinct read path (getTaskPrompt), not a detail preset value covered by this builder", () => {
    const result = fixtureFoundResult({});
    for (const detail of ["core", "summary", "updates", "artifacts", "diagnostics", "full", "fullWithDiagnostics"] as const) {
      const payload = buildGetTaskStructuredContent(result, detail);
      expect(payload).not.toHaveProperty("prompt");
    }
  });
});
