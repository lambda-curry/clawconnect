import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendJobLog,
  logHead,
  readJobLogLimits,
  trimJobLogs,
  type JobLogLimits,
} from "./job-logs.ts";
import { projectLogWindow } from "./log-projection.ts";
import type { Job } from "./types.ts";

const limits: JobLogLimits = {
  running: { maxEntries: 8, maxBytes: 2_048 },
  finished: { maxEntries: 3, maxBytes: 512 },
};
function state(): Pick<Job, "logs" | "status" | "logEventCount" | "logBytes"> {
  return { logs: [], status: "running" };
}
function append(job: ReturnType<typeof state>, count: number, text = "event"): void {
  for (let i = 0; i < count; i++) appendJobLog(job, { ts: i, type: "lifecycle", text }, limits);
}

afterEach(() => vi.unstubAllEnvs());

describe("job log retention", () => {
  it("bounds running entries, retains newest and keeps original cursors monotonic", () => {
    const job = state();
    append(job, 100);
    expect(job.logs).toHaveLength(8);
    expect(job.logs[0]).toMatchObject({ type: "truncation", seq: 93 });
    expect(job.logs.at(-1)?.seq).toBe(100);
    expect(logHead(job)).toBe(100);
    expect(job.logs[0].text).toContain("93 events omitted");
    expect(job.logBytes).toBe(Buffer.byteLength(JSON.stringify(job.logs)));
    const first = projectLogWindow(job.logs, 10);
    expect(first.events[0].type).toBe("truncation");
    expect(first.totalCount).toBe(100);
    expect(first.cursor).toBe(100);
    expect(projectLogWindow(job.logs, first.cursor).events).toEqual([]);
    append(job, 1);
    expect(projectLogWindow(job.logs, 100).events.map((entry) => entry.seq)).toEqual([101]);
  });

  it("bounds serialized UTF-8 bytes including marker, metadata, and escaped text", () => {
    const job = state();
    append(job, 30, '😀\n"'.repeat(100));
    expect(Buffer.byteLength(JSON.stringify(job.logs))).toBeLessThanOrEqual(
      limits.running.maxBytes,
    );
    expect(job.logs[0].type).toBe("truncation");
    expect(job.logs.at(-1)?.seq).toBe(30);
  });

  it("fits a single oversized event and marks its text truncation", () => {
    const job = state();
    const tiny: JobLogLimits = {
      running: { maxEntries: 2, maxBytes: 256 },
      finished: limits.finished,
    };
    appendJobLog(job, { ts: 1, type: "tool-result", text: "😀\n".repeat(10_000) }, tiny);
    expect(Buffer.byteLength(JSON.stringify(job.logs))).toBeLessThanOrEqual(256);
    expect(job.logs.at(-1)?.text).toContain("[log text truncated]");
    expect(logHead(job)).toBe(1);
  });

  it("tightens finished budgets immediately without resetting the total event count", () => {
    const job = state();
    append(job, 20, "a".repeat(120));
    job.status = "completed";
    trimJobLogs(job, limits);
    expect(job.logs.length).toBeLessThanOrEqual(limits.finished.maxEntries);
    expect(Buffer.byteLength(JSON.stringify(job.logs))).toBeLessThanOrEqual(
      limits.finished.maxBytes,
    );
    expect(job.logs.at(-1)?.seq).toBe(20);
    expect(projectLogWindow(job.logs, undefined).totalCount).toBe(20);
    append(job, 1);
    expect(job.logs.at(-1)?.seq).toBe(21);
    expect(job.logs.length).toBeLessThanOrEqual(3);
  });

  it("reads safe environment overrides and rejects budgets too small to retain a marker and event", () => {
    vi.stubEnv("CLAWCONNECT_RUNNING_LOG_MAX_ENTRIES", "7");
    vi.stubEnv("CLAWCONNECT_FINISHED_LOG_MAX_BYTES", "1024");
    expect(readJobLogLimits().running.maxEntries).toBe(7);
    expect(readJobLogLimits().finished.maxBytes).toBe(1024);
    vi.stubEnv("CLAWCONNECT_RUNNING_LOG_MAX_ENTRIES", "1");
    vi.stubEnv("CLAWCONNECT_FINISHED_LOG_MAX_BYTES", "12");
    expect(readJobLogLimits().running.maxEntries).toBe(2_000);
    expect(readJobLogLimits().finished.maxBytes).toBe(256 * 1024);
  });
});
