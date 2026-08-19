import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadJsonArrayFile, type StoreDegradationSink } from "./store-health.ts";
import type { JobPrompt } from "./types.ts";

/**
 * The minimal state needed for an in-flight job to survive a process
 * restart — no logs, no artifacts, nothing terminal. Deliberately small:
 * only ever holds jobs that are currently running, so the persisted set is
 * bounded by "how much work is in flight right now", not by history. On
 * reload, SessionManager re-derives the actual outcome from the OpenClaw
 * transcript via the same recovery path an empty live chat.final already
 * uses — this file is a pointer back to that session, not a cache of its
 * content.
 */
export type PersistedJob = {
  jobId: string;
  sessionKey: string;
  startedAt: number;
  lastEventAt: number;
  pollCount: number;
  prompt: JobPrompt;
  /** OpenClaw's runId for this job, once chat.send's onRunId has fired. Absent on records written before this field existed — old files still load fine. */
  parentRunId?: string;
  /** Durable OpenClaw transcript sequence confirmed before the connector stopped. */
  lastSeenSequence?: number;
  /** Where this job's opaque run_task payload was materialised, if it had one. See payload-store.ts. */
  payloadPath?: string;
};

export interface JobStore {
  load(): PersistedJob[];
  save(jobs: PersistedJob[]): void;
}

/**
 * File-backed JobStore. SessionManager overwrites the whole file on every
 * save with exactly the jobs currently status==="running" — nothing
 * terminal is ever written, so the file can't grow into a log.
 *
 * Best-effort in one direction only. A WRITE failure is logged and swallowed:
 * job persistence is a nice-to-have for restart recovery, not load-bearing
 * for run_task/check_task correctness. A READ failure is not swallowed into
 * `[]` — see store-health.ts for why that combination destroys its own
 * evidence.
 */
export class JsonFileJobStore implements JobStore {
  /** Set when load() could not preserve an unreadable file. While true, save() refuses to overwrite it. */
  private blocked = false;

  constructor(
    private readonly filePath: string,
    private readonly onDegraded?: StoreDegradationSink,
  ) {}

  load(): PersistedJob[] {
    const { entries, blocked } = loadJsonArrayFile(this.filePath, "job", this.onDegraded);
    this.blocked = blocked;
    return entries as PersistedJob[];
  }

  save(jobs: PersistedJob[]): void {
    if (this.blocked) {
      console.error(
        `[job-store] refusing to overwrite ${this.filePath}: it could not be read and could not be preserved`,
      );
      return;
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Write-then-rename so a reader never observes a half-written file —
      // renameSync is atomic on the same filesystem, and the tmp file always
      // lives alongside the target so it can't cross a filesystem boundary.
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(jobs));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[job-store] failed to save ${this.filePath}: ${(err as Error).message}`);
    }
  }
}
