import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
 * store holds retained current and historical attachments. SessionManager
 * applies count/age retention before saving and after loading, so stale lineage
 * cannot accumulate across restarts.
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
  private backupReady = false;

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
    if (!this.preserveBeforeOverwrite()) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(states));
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(
        `[attachment-store] failed to save ${this.filePath}: ${(err as Error).message}`,
      );
    }
  }

  /** Keep the original bytes once, including legacy timestamps and malformed rows. */
  private preserveBeforeOverwrite(): boolean {
    if (this.backupReady || !existsSync(this.filePath)) return true;
    const target = `${this.filePath}.pre-retention`;
    try {
      try {
        copyFileSync(this.filePath, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(target).isFile())
          throw error;
      }
      this.backupReady = true;
      return true;
    } catch (error) {
      this.blocked = true;
      const message = `could not preserve ${this.filePath} before retention (${(error as Error).message}); refusing to overwrite it`;
      console.error(`[attachment-store] ${message}`);
      this.onDegraded?.({ kind: "attachment", filePath: this.filePath, message, at: Date.now() });
      return false;
    }
  }
}
