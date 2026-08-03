import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FleetAttachmentRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

export type FleetHandoff = { text: string; observedAt: number };

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
    if (typeof transcriptPath !== "string" || !transcriptPath || !existsSync(transcriptPath)) return null;

    const text = readLastAssistantText(transcriptPath);
    if (!text) return null;
    return { text, observedAt: Date.now() };
  }
}

/**
 * Scans a Claude Code transcript JSONL file (`{type, message:{role,
 * content}}` per line, newest entry last) backward for the most recent
 * assistant text block. Best-effort: any read/parse failure yields "",
 * treated by the caller as "no trustworthy handoff yet" rather than an error.
 */
function readLastAssistantText(transcriptPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
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
    if (text) return text;
  }
  return "";
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
