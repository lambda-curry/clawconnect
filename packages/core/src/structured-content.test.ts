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
    nextAction: { tool: "check_task", args: { taskId: "job-1", sessionKey: "session-1" } },
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
      agent: "test-agent",
      nextAction: { tool: "check_task", args: { taskId: "job-1", sessionKey: "session-1" } },
    };
    const structured = buildRunTaskStructuredContent(result);

    expect(structured).toEqual({
      jobId: "job-1",
      taskId: "job-1",
      sessionKey: "session-1",
      status: "running",
      agent: "test-agent",
      nextAction: { tool: "check_task", args: { taskId: "job-1", sessionKey: "session-1" } },
    });
    // RunTaskResult has no prompt/task/context field to begin with — this
    // assertion documents that guarantee rather than testing a redaction step.
    expect(Object.keys(structured).sort()).toEqual(["agent", "jobId", "nextAction", "sessionKey", "status", "taskId"]);
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

  it("never includes the prompt — that's a distinct read path (getTaskPrompt), not a detail preset value covered by this builder", () => {
    const result = fixtureFoundResult({});
    for (const detail of ["core", "summary", "updates", "artifacts", "diagnostics", "full", "fullWithDiagnostics"] as const) {
      const payload = buildGetTaskStructuredContent(result, detail);
      expect(payload).not.toHaveProperty("prompt");
    }
  });
});
