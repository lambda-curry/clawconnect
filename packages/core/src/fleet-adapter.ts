import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FleetAttachmentRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * `resultAt` is the transcript entry's OWN timestamp — when the child
 * actually produced this text — never wall-clock read time. session.ts uses
 * it as the freshness/correlation bound for recovery: a handoff whose
 * resultAt predates the recovering job's own startedAt cannot possibly be
 * that job's answer, no matter how it ended up readable here.
 */
export type FleetHandoff = { text: string; resultAt: number };

/**
 * Inspects exactly one already-known attachment — never enumerates or scans
 * Fleet sessions. session.ts only ever calls this with a record it already
 * has from SessionFleetState.currentAttachmentId, so there is no code path
 * from here back to a global Fleet listing.
 */
export interface FleetAdapter {
  /** Liveness only, via `tmux has-session -t <handle>`. */
  isLive(attachment: FleetAttachmentRecord): Promise<boolean>;
  /** A durable terminal result for the attachment, or null when none is available/trustworthy yet. */
  readTerminalHandoff(attachment: FleetAttachmentRecord): Promise<FleetHandoff | null>;
}

/**
 * Same safe-path-segment check as fleet-handoff.ts's directive validation —
 * re-applied here as defense in depth so this adapter is safe to call with
 * ANY FleetAttachmentRecord, not just ones that passed through the parser
 * (e.g. one reloaded from the attachment store).
 */
const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface FleetSessionMeta {
  transcriptPath?: string;
}

/**
 * Real, local-machine implementation: tmux for liveness, and the on-disk
 * `~/.claude-fleet/<handle>/meta.json` -> transcriptPath convention (the
 * same one this repo's own Claude Fleet sessions use) for a terminal
 * handoff.
 *
 * `attachment.host` is not used to gate anything here — this only ever
 * checks the LOCAL machine's tmux and filesystem. A remote-host attachment
 * simply won't have a local tmux session or local meta.json, so isLive and
 * readTerminalHandoff degrade to false/null on their own, and the caller's
 * recovery path falls through to its pre-existing completed_no_summary
 * behavior — exactly as if no attachment were known. Remote-host Fleet
 * liveness/recovery is an explicit out-of-scope boundary for this slice
 * (see docs/architecture/2026-08-02-managed-fleet-attachment-plan.md).
 */
export class LocalTmuxFleetAdapter implements FleetAdapter {
  constructor(private readonly fleetHomeDir: string = join(homedir(), ".claude-fleet")) {}

  async isLive(attachment: FleetAttachmentRecord): Promise<boolean> {
    if (!SAFE_HANDLE_RE.test(attachment.handle)) return false;
    try {
      await execFileAsync("tmux", ["has-session", "-t", attachment.handle]);
      return true;
    } catch {
      // Covers both "session doesn't exist" (tmux exits non-zero) and "tmux
      // isn't installed/reachable" — either way, liveness is unknown/false,
      // never a thrown error the caller has to handle.
      return false;
    }
  }

  async readTerminalHandoff(attachment: FleetAttachmentRecord): Promise<FleetHandoff | null> {
    if (!SAFE_HANDLE_RE.test(attachment.handle)) return null;
    // Trusted only once the tmux session has actually ended — a live
    // session's transcript can still change under us, so reading it while
    // still live risks surfacing a mid-run snapshot as if it were final.
    if (await this.isLive(attachment)) return null;

    const metaPath = join(this.fleetHomeDir, attachment.handle, "meta.json");
    if (!existsSync(metaPath)) return null;
    let meta: FleetSessionMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      return null;
    }
    const transcriptPath = meta.transcriptPath;
    if (typeof transcriptPath !== "string" || !transcriptPath) return null;

    // meta.json is local, trusted infrastructure state today, but its
    // CONTENT is still read off disk and used to pick a file to read —
    // treated as untrusted input here so a stale, corrupted, or (in a
    // future change) attacker-influenced meta.json can never turn this
    // adapter into an arbitrary-file-read primitive. Rejects both an
    // absolute-path escape (e.g. "/etc/passwd") and relative traversal
    // (e.g. "../../../etc/passwd") regardless of how transcriptPath was
    // spelled.
    const containedPath = resolveContainedPath(this.fleetHomeDir, transcriptPath);
    if (!containedPath || !existsSync(containedPath)) return null;

    const found = readLastAssistantEntry(containedPath);
    if (!found) return null;
    return { text: found.text, resultAt: found.resultAt };
  }
}

/**
 * Resolves `candidatePath` against `baseDir` and confirms the result stays
 * WITHIN `baseDir` — a hard boundary, not a best-effort filter. Returns null
 * for anything outside `baseDir`, including `baseDir`'s own parent/siblings.
 * `path.resolve` treats a later absolute segment as overriding earlier ones,
 * so this rejects an absolute escape and a relative traversal with the same
 * check.
 */
function resolveContainedPath(baseDir: string, candidatePath: string): string | null {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(baseDir, candidatePath);
  if (resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + sep)) {
    return resolvedCandidate;
  }
  return null;
}

/**
 * Scans a Claude Code transcript JSONL file (`{type, timestamp, message:
 * {role, content}}` per line, newest entry last) backward for the most
 * recent assistant text block THAT ALSO carries a parseable `timestamp`.
 * An entry with text but no usable timestamp is skipped, not substituted
 * with a fabricated one — session.ts's freshness check requires a REAL
 * result timestamp, so "we found text but can't date it" must read as "no
 * trustworthy handoff yet," not as an untimestamped success. Best-effort:
 * any read/parse failure yields null, treated by the caller as "no
 * trustworthy handoff yet" rather than an error.
 */
function readLastAssistantEntry(transcriptPath: string): { text: string; resultAt: number } | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractAssistantText(entry);
    if (!text) continue;
    const resultAt = extractResultTimestamp(entry);
    if (resultAt === undefined) continue;
    return { text, resultAt };
  }
  return null;
}

function extractAssistantText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as Record<string, unknown>;
  if (e.type !== "assistant") return "";
  const message = e.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

/** Parses the entry's own `timestamp` (ISO string, the real Claude Code transcript convention) into epoch ms. */
function extractResultTimestamp(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const ts = (entry as Record<string, unknown>).timestamp;
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}
