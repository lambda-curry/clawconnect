import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionFleetState } from "./types.ts";

export interface FleetAttachmentStore {
  load(): SessionFleetState[];
  save(states: SessionFleetState[]): void;
}

/**
 * File-backed FleetAttachmentStore, same shape and atomicity as
 * job-store.ts's JsonFileJobStore. Unlike the job store — which only ever
 * holds currently-running jobs and prunes on every terminal transition — this
 * store holds every session that has ever had an attachment, including
 * superseded/detached lineage: it's bounded by "how many sessions have used
 * Fleet, times a handful of attachments each", not by event volume, so
 * keeping full history here doesn't risk unbounded growth the way logs would.
 * Best-effort: a read/write failure is logged and swallowed, never thrown —
 * same rationale as the job store (restart recovery is a nice-to-have, not
 * load-bearing for the attach/continue/replace/detach transitions themselves,
 * which always succeed in memory first).
 */
export class JsonFileFleetAttachmentStore implements FleetAttachmentStore {
  constructor(private readonly filePath: string) {}

  load(): SessionFleetState[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error(`[fleet-attachment-store] failed to load ${this.filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  save(states: SessionFleetState[]): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(states));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[fleet-attachment-store] failed to save ${this.filePath}: ${(err as Error).message}`);
    }
  }
}
