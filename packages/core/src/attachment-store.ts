import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadJsonArrayFile, type StoreDegradationSink } from "./store-health.ts";
import type { SessionAttachmentState } from "./types.ts";

export interface AttachmentStore {
  load(): SessionAttachmentState[];
  save(states: SessionAttachmentState[]): void;
}

/**
 * File-backed AttachmentStore, same shape and atomicity as
 * job-store.ts's JsonFileJobStore. Unlike the job store — which only ever
 * holds currently-running jobs and prunes on every terminal transition — this
 * store holds every session that has ever had an attachment, including
 * superseded/detached lineage: it's bounded by "how many sessions have ever
 * attached, times a handful of attachments each", not by event volume, so
 * keeping full history here doesn't risk unbounded growth the way logs would.
 * Write failures are logged and swallowed — restart recovery is a
 * nice-to-have, not load-bearing for the attach/continue/replace/detach
 * transitions themselves, which always succeed in memory first. Read failures
 * are NOT swallowed into `[]`: this store holds lineage rather than only
 * active work, so a silent empty load discards more than the job store's
 * does. See store-health.ts.
 */
export class JsonFileAttachmentStore implements AttachmentStore {
  /** Set when load() could not preserve an unreadable file. While true, save() refuses to overwrite it. */
  private blocked = false;

  constructor(
    private readonly filePath: string,
    private readonly onDegraded?: StoreDegradationSink,
  ) {}

  load(): SessionAttachmentState[] {
    const { entries, blocked } = loadJsonArrayFile(this.filePath, "attachment", this.onDegraded);
    this.blocked = blocked;
    return entries as SessionAttachmentState[];
  }

  save(states: SessionAttachmentState[]): void {
    if (this.blocked) {
      console.error(
        `[attachment-store] refusing to overwrite ${this.filePath}: it could not be read and could not be preserved`,
      );
      return;
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(states));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[attachment-store] failed to save ${this.filePath}: ${(err as Error).message}`);
    }
  }
}
