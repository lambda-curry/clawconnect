/**
 * A worked example of an agent-session runtime module.
 *
 * ClawConnect ships no runtime. A host that wants one names an ES module in
 * `CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES`; the module exports
 * `registerAgentSessionRuntimes(registry)` and calls `registry.register(...)`
 * once per runtime it can answer for. That is the entire contract — this file
 * imports nothing from ClawConnect, because a runtime module needs nothing
 * from it but the registry object it is handed.
 *
 *   CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES=/abs/path/to/runtime.mjs
 *
 * What this particular one does: drives sessions that run as local `tmux`
 * panes, with a Claude Code transcript on disk under
 * `~/.claude-fleet/<handle>/meta.json` -> `transcriptPath`. It used to live
 * inside `packages/core` and be constructed by default, which made core know
 * about exactly one runtime while its own design notes said it knew about
 * none. Nothing about it changed except where it lives and how it is reached.
 *
 * Plain JavaScript on purpose: an operator points the env var at this file and
 * it loads, with no build step between the example and the thing being
 * exemplified.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUNTIME_ID = "claude-fleet";
const PROVIDER = "anthropic-claude-code";

/**
 * Same safe-path-segment check ClawConnect's own directive parser applies —
 * re-applied here as defense in depth, so this module is safe to call with any
 * session id at all rather than only ones that came through that parser.
 */
const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The registrar ClawConnect looks for. `default` works identically.
 *
 * @param {{ register: (runtime: unknown) => void }} registry
 * @param {{ fleetHomeDir?: string }} [opts]
 */
export function registerAgentSessionRuntimes(registry, opts = {}) {
  const fleetHomeDir = opts.fleetHomeDir ?? join(homedir(), ".claude-fleet");
  registry.register({
    id: RUNTIME_ID,
    provider: PROVIDER,
    inspect: (ref, callOpts) => inspect(fleetHomeDir, ref, callOpts?.signal),
    // No `continue`/`detach`: a tmux pane cannot be handed a follow-up turn or
    // be ended meaningfully from here. Omitting them is not a gap — ClawConnect
    // turns a request for an absent callback into a precise
    // `unsupported_operation` answer, which is more useful to a caller than a
    // silent no-op would be.
  });
}

export default registerAgentSessionRuntimes;

/**
 * The one callback. It reports the strongest thing it can actually prove, and
 * nothing more:
 *
 *   - pane still alive  -> `{ alive: true }` and NO state. A bare liveness bit
 *     cannot tell "working" from "waiting on a human", and claiming either
 *     would let this probe clobber a status the host reported explicitly.
 *   - pane gone, and the transcript's last assistant entry carries its own
 *     timestamp -> a completed turn with that text. This is the stronger claim,
 *     and the gate for it lives here rather than in ClawConnect: the pane must
 *     have ENDED (a live pane's transcript can still change under the read, so
 *     a mid-run snapshot would otherwise surface as final), and the entry must
 *     date itself.
 *   - anything else -> `{ alive: false }`, i.e. "nothing trustworthy yet".
 *
 * ClawConnect applies its own checks on top of whatever comes back — the turn
 * must be a completed one, the result must be datable, and it must post-date
 * the job it would answer — but it cannot supply this gate, because the
 * evidence for it is here.
 *
 * Never throws: every failure is "no news", which is a legitimate answer.
 *
 * @param {string} fleetHomeDir
 * @param {{ sessionId: string }} ref
 * @param {AbortSignal} [signal]
 */
async function inspect(fleetHomeDir, ref, signal) {
  const handle = ref?.sessionId;
  if (typeof handle !== "string" || !SAFE_HANDLE_RE.test(handle)) return { alive: false };
  if (signal?.aborted) return { alive: false };

  if (await isLive(handle, signal)) return { alive: true };
  if (signal?.aborted) return { alive: false };

  const handoff = await readTerminalHandoff(fleetHomeDir, handle, signal);
  if (!handoff) return { alive: false };
  return {
    state: "completed",
    alive: false,
    finalResponse: handoff.text,
    // The transcript entry's OWN timestamp — when the session actually
    // produced this text — never wall-clock read time. ClawConnect uses it as
    // the freshness bound that decides whether this answer can belong to the
    // job asking, so substituting `Date.now()` here would defeat that check.
    lastEventAt: handoff.resultAt,
  };
}

/** Liveness only, via `tmux has-session`. The signal kills the subprocess; without it an abandoned read leaves a child with nobody waiting on it. */
async function isLive(handle, signal) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", handle], { signal });
    return true;
  } catch {
    // Covers "no such session", "tmux isn't installed", and an abort — all of
    // which mean liveness is false or unknown, never an error to handle.
    return false;
  }
}

async function readTerminalHandoff(fleetHomeDir, handle, signal) {
  let meta;
  try {
    meta = JSON.parse(await readFile(join(fleetHomeDir, handle, "meta.json"), { encoding: "utf8", signal }));
  } catch {
    // Missing, unreadable, unparseable, or aborted — all "no trustworthy
    // handoff yet", which is why the existence check IS the read.
    return null;
  }
  const transcriptPath = meta?.transcriptPath;
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  if (signal?.aborted) return null;

  // meta.json is local, trusted infrastructure state today, but its CONTENT is
  // still read off disk and used to pick a file to read — treated as untrusted
  // here so a stale, corrupted, or attacker-influenced meta.json can never turn
  // this module into an arbitrary-file-read primitive. `resolve` treats a later
  // absolute segment as overriding earlier ones, so one check rejects both an
  // absolute escape ("/etc/passwd") and a relative traversal ("../../..").
  const base = resolve(fleetHomeDir);
  const contained = resolve(fleetHomeDir, transcriptPath);
  if (contained !== base && !contained.startsWith(base + sep)) return null;

  return readLastAssistantEntry(contained, signal);
}

/**
 * Scans a Claude Code transcript JSONL file (`{type, timestamp, message:
 * {role, content}}` per line, newest last) backward for the most recent
 * assistant text block THAT ALSO carries a parseable `timestamp`. An entry
 * with text but no usable timestamp is skipped rather than given a fabricated
 * one: "we found text but cannot date it" has to read as no trustworthy
 * handoff, not as an untimestamped success.
 *
 * Read asynchronously — this is the largest file on the path, and a
 * synchronous read would stall the whole event loop with no way for the
 * deadline above to cut it short.
 */
async function readLastAssistantEntry(transcriptPath, signal) {
  let raw;
  try {
    raw = await readFile(transcriptPath, { encoding: "utf8", signal });
  } catch {
    return null;
  }
  if (signal?.aborted) return null;
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = assistantText(entry);
    if (!text) continue;
    const resultAt = Date.parse(entry?.timestamp ?? "");
    if (!Number.isFinite(resultAt)) continue;
    return { text, resultAt };
  }
  return null;
}

function assistantText(entry) {
  if (!entry || typeof entry !== "object" || entry.type !== "assistant") return "";
  const content = entry.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}
