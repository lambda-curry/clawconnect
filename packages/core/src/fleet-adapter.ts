import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentSessionRuntime } from "./agent-session.ts";
import type { FleetAttachmentRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The runtime id this adapter answers for, and the default for a directive that names none. */
export const CLAUDE_FLEET_RUNTIME_ID = "claude-fleet";

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
  /**
   * Liveness only, via `tmux has-session -t <handle>`.
   *
   * `signal` is the recovery deadline session.ts is already holding. Optional
   * so an injected adapter that does not need it — a test double, an
   * embedder's own implementation — stays valid unchanged; an implementation
   * that DOES local work is expected to honor it, because everything on this
   * path runs while a job is held out of a terminal status.
   */
  isLive(attachment: FleetAttachmentRecord, signal?: AbortSignal): Promise<boolean>;
  /** A durable terminal result for the attachment, or null when none is available/trustworthy yet. */
  readTerminalHandoff(attachment: FleetAttachmentRecord, signal?: AbortSignal): Promise<FleetHandoff | null>;
}

/**
 * Presents an injected FleetAdapter through the neutral runtime seam, so
 * claude-fleet dispatches by exactly the same path a host-registered runtime
 * does instead of being special-cased at every call site.
 *
 * Only `inspect` is offered, and it deliberately reports NO state — a bare
 * tmux liveness bit cannot distinguish "working" from "waiting on a human",
 * and claiming one would let it clobber a status the host reported explicitly.
 * It answers the one question it can (`alive`), and the write-back's
 * liveness-only rule decides what, if anything, that is allowed to promote.
 *
 * No `continue`/`detach` callbacks: a tmux adapter cannot deliver a turn or
 * end a session, and derived capabilities turn that into a precise
 * `unsupported_operation` for a caller who asks — rather than a silent no-op.
 *
 * Terminal-transcript recovery is NOT routed through here. It has its own
 * trust gate (the tmux session must have ENDED, and the transcript entry
 * carries its own timestamp), which is a stronger claim than `inspect` makes
 * and is consulted only from session.ts's recovery tier — see
 * FleetAdapter.readTerminalHandoff.
 */
export function fleetAdapterRuntime(
  adapter: FleetAdapter,
  record: FleetAttachmentRecord,
  provider = "anthropic-claude-code",
): AgentSessionRuntime {
  return {
    id: CLAUDE_FLEET_RUNTIME_ID,
    provider,
    capabilities: { inspect: true, continue: false, detach: false },
    callbacks: {
      id: CLAUDE_FLEET_RUNTIME_ID,
      provider,
      // Bound to the one record it was built for rather than reconstructing an
      // attachment from the neutral ref: FleetAdapter's contract is stated in
      // terms of a real FleetAttachmentRecord, and every dispatch addresses
      // exactly one already-known attachment anyway.
      inspect: async (_ref, opts) => ({ alive: await adapter.isLive(record, opts.signal) }),
    },
  };
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

  async isLive(attachment: FleetAttachmentRecord, signal?: AbortSignal): Promise<boolean> {
    if (!SAFE_HANDLE_RE.test(attachment.handle)) return false;
    if (signal?.aborted) return false;
    try {
      // The signal kills the subprocess. Without it an abandoned recovery left
      // a tmux child running with nobody waiting on it.
      await execFileAsync("tmux", ["has-session", "-t", attachment.handle], { signal });
      return true;
    } catch {
      // Covers "session doesn't exist" (tmux exits non-zero), "tmux isn't
      // installed/reachable", and an abort — either way, liveness is
      // unknown/false, never a thrown error the caller has to handle.
      return false;
    }
  }

  async readTerminalHandoff(attachment: FleetAttachmentRecord, signal?: AbortSignal): Promise<FleetHandoff | null> {
    if (!SAFE_HANDLE_RE.test(attachment.handle)) return null;
    if (signal?.aborted) return null;
    // Trusted only once the tmux session has actually ended — a live
    // session's transcript can still change under us, so reading it while
    // still live risks surfacing a mid-run snapshot as if it were final.
    if (await this.isLive(attachment, signal)) return null;
    if (signal?.aborted) return null;

    const metaPath = join(this.fleetHomeDir, attachment.handle, "meta.json");
    let meta: FleetSessionMeta;
    try {
      meta = JSON.parse(await readFile(metaPath, { encoding: "utf8", signal }));
    } catch {
      // Missing, unreadable, unparseable, or aborted — all "no trustworthy
      // handoff yet", which is why the existence check is the read itself.
      return null;
    }
    const transcriptPath = meta.transcriptPath;
    if (typeof transcriptPath !== "string" || !transcriptPath) return null;
    if (signal?.aborted) return null;

    // meta.json is local, trusted infrastructure state today, but its
    // CONTENT is still read off disk and used to pick a file to read —
    // treated as untrusted input here so a stale, corrupted, or (in a
    // future change) attacker-influenced meta.json can never turn this
    // adapter into an arbitrary-file-read primitive. Rejects both an
    // absolute-path escape (e.g. "/etc/passwd") and relative traversal
    // (e.g. "../../../etc/passwd") regardless of how transcriptPath was
    // spelled.
    const containedPath = resolveContainedPath(this.fleetHomeDir, transcriptPath);
    if (!containedPath) return null;

    const found = await readLastAssistantEntry(containedPath, signal);
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
 * any read/parse failure — and any abort — yields null, treated by the caller
 * as "no trustworthy handoff yet" rather than an error.
 *
 * Read asynchronously: a transcript is the largest file on this path and the
 * synchronous read it replaces stalled the whole event loop for the duration,
 * with no way for the deadline above to cut it short.
 */
async function readLastAssistantEntry(
  transcriptPath: string,
  signal?: AbortSignal,
): Promise<{ text: string; resultAt: number } | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, { encoding: "utf8", signal });
  } catch {
    return null;
  }
  if (signal?.aborted) return null;
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
