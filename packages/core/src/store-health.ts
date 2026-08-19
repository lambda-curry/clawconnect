import { existsSync, readFileSync, renameSync } from "node:fs";

/**
 * The difference between "the file is not there" and "the file could not be
 * read", for the two JSON-array-backed stores.
 *
 * Both used to answer a read failure with `[]` and a stderr line. That is a
 * lie in the second case, and a self-erasing one: SessionManager rehydrates
 * nothing, then the next `save()` overwrites the whole file with the
 * truncated set — so the evidence of what was lost is destroyed by the
 * recovery attempt itself, and the only trace is one line in a log nobody
 * reads.
 *
 * The rule here: a missing file still means empty (that is a fact). An
 * unreadable file is preserved under a timestamped name BEFORE anything can
 * overwrite it, and the degradation is reported to whoever wired the store
 * up. If even the preservation fails, the store refuses to save at all —
 * refusing to persist is recoverable, silently shredding the only copy of the
 * in-flight set is not.
 */
export type StoreKind = "job" | "attachment";

export type StoreDegradation = {
  kind: StoreKind;
  filePath: string;
  /**
   * Where the unreadable file was moved so a human can still read it.
   * Absent when preservation itself failed — which is exactly the case where
   * the store then refuses to write.
   */
  preservedAs?: string;
  message: string;
  at: number;
};

export type StoreDegradationSink = (degradation: StoreDegradation) => void;

export type StoreLoad = {
  /** Rows to use. Always empty on failure — a failed read never invents data. */
  entries: unknown[];
  /**
   * True when the previous contents could NOT be preserved, so an overwrite
   * would destroy them. The store must refuse to save while this holds.
   */
  blocked: boolean;
};

/** Filesystem-safe instant: `2026-08-18T12-34-56-789Z`. Colons are legal on POSIX and are not on Windows. */
function fileStamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/**
 * Reads a JSON array file, preserving it aside if it cannot be read as one.
 *
 * A file that parses but is not an array counts as unreadable too: it is
 * something other than this store's contents, and returning `[]` for it has
 * the same self-erasing consequence as returning `[]` for a syntax error.
 */
export function loadJsonArrayFile(
  filePath: string,
  kind: StoreKind,
  onDegraded?: StoreDegradationSink,
  now: () => number = Date.now,
): StoreLoad {
  if (!existsSync(filePath)) return { entries: [], blocked: false };

  let entries: unknown[];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("file does not contain a JSON array");
    entries = parsed;
  } catch (err) {
    return { entries: [], blocked: preserve(filePath, kind, (err as Error).message, onDegraded, now()) };
  }
  return { entries, blocked: false };
}

/** Renames the unreadable file aside and reports it. Returns true when the store must now refuse to save. */
function preserve(
  filePath: string,
  kind: StoreKind,
  reason: string,
  onDegraded: StoreDegradationSink | undefined,
  at: number,
): boolean {
  const target = `${filePath}.corrupt-${fileStamp(at)}`;
  let preservedAs: string | undefined;
  let message = `could not read ${filePath}: ${reason}`;
  try {
    renameSync(filePath, target);
    preservedAs = target;
    message += ` — preserved as ${target}; nothing was rehydrated from it`;
  } catch (renameErr) {
    message +=
      ` — AND it could not be preserved (${(renameErr as Error).message}); ` +
      `refusing to save over it until someone moves it aside`;
  }
  // stderr stays, because it is the only surface a crashed process has. The
  // sink is what makes this reachable from a running connector.
  console.error(`[${kind}-store] ${message}`);
  onDegraded?.({ kind, filePath, preservedAs, message, at });
  return preservedAs === undefined;
}
