import type { Job, LogEntry } from "./types.ts";

export type JobLogLimits = {
  running: { maxEntries: number; maxBytes: number };
  finished: { maxEntries: number; maxBytes: number };
};

function envLimit(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

export function readJobLogLimits(): JobLogLimits {
  return {
    running: {
      maxEntries: envLimit("CLAWCONNECT_RUNNING_LOG_MAX_ENTRIES", 2_000, 2),
      maxBytes: envLimit("CLAWCONNECT_RUNNING_LOG_MAX_BYTES", 2 * 1024 * 1024, 256),
    },
    finished: {
      maxEntries: envLimit("CLAWCONNECT_FINISHED_LOG_MAX_ENTRIES", 200, 2),
      maxBytes: envLimit("CLAWCONNECT_FINISHED_LOG_MAX_BYTES", 256 * 1024, 256),
    },
  };
}

type LogState = Pick<Job, "logs" | "status" | "logEventCount" | "logBytes">;

export function logHead(job: Pick<Job, "logs" | "logEventCount">): number {
  return job.logEventCount ?? job.logs.at(-1)?.seq ?? job.logs.length;
}

export function logEntryBytes(entry: LogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function arrayOverhead(count: number): number {
  return count > 0 ? count + 1 : 2;
}

function truncationMarker(seq: number, ts: number): LogEntry {
  return {
    seq,
    ts,
    type: "truncation",
    text: `[Earlier log entries truncated: ${seq} events omitted.]`,
  };
}

/** Tightens a terminal job immediately, retaining the newest events and one gap marker. */
export function trimJobLogs(job: LogState, limits: JobLogLimits): void {
  const budget = job.status === "running" ? limits.running : limits.finished;
  job.logEventCount = logHead(job);
  let bytes =
    job.logBytes === undefined
      ? job.logs.reduce((total, entry) => total + logEntryBytes(entry), 0)
      : job.logBytes - arrayOverhead(job.logs.length);
  let omitted = 0;
  if (job.logs[0]?.type === "truncation") {
    const previous = job.logs.shift()!;
    omitted = previous.seq ?? 0;
    bytes -= logEntryBytes(previous);
  }

  const last = job.logs.at(-1);
  // A single event must fit too. Binary search counts UTF-8 JSON bytes, including escaping.
  if (last) {
    const markerBytes = logEntryBytes(truncationMarker(job.logEventCount, last.ts));
    const maxEntryBytes = budget.maxBytes - markerBytes - arrayOverhead(2);
    if (logEntryBytes(last) > maxEntryBytes) {
      const original = last.text;
      const oldBytes = logEntryBytes(last);
      const suffix = "…[log text truncated]";
      let low = 0;
      let high = original.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        last.text = `${original.slice(0, mid)}${suffix}`;
        if (logEntryBytes(last) <= maxEntryBytes) low = mid;
        else high = mid - 1;
      }
      last.text = `${original.slice(0, low)}${suffix}`;
      bytes += logEntryBytes(last) - oldBytes;
    }
  }

  while (job.logs.length > 1) {
    const marker = truncationMarker(omitted || (job.logs[0].seq ?? 1), job.logs[0].ts);
    const markerBytes = omitted > 0 ? logEntryBytes(marker) : 0;
    const count = job.logs.length + (omitted > 0 ? 1 : 0);
    if (count <= budget.maxEntries && bytes + markerBytes + arrayOverhead(count) <= budget.maxBytes)
      break;
    const dropped = job.logs.shift()!;
    omitted = dropped.seq ?? omitted + 1;
    bytes -= logEntryBytes(dropped);
  }
  if (omitted > 0) {
    const marker = truncationMarker(omitted, job.logs[0]?.ts ?? Date.now());
    job.logs.unshift(marker);
    bytes += logEntryBytes(marker);
  }
  job.logBytes = bytes + arrayOverhead(job.logs.length);
}

export function appendJobLog(
  job: LogState,
  entry: Omit<LogEntry, "seq">,
  limits: JobLogLimits,
): void {
  const seq = logHead(job) + 1;
  job.logBytes ??=
    job.logs.reduce((total, log) => total + logEntryBytes(log), 0) + arrayOverhead(job.logs.length);
  const next = { ...entry, seq };
  job.logBytes += logEntryBytes(next) + (job.logs.length > 0 ? 1 : 0);
  job.logs.push(next);
  job.logEventCount = seq;
  trimJobLogs(job, limits);
}
