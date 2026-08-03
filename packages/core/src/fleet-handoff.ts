import type { FleetDirective, FleetLiveStatus } from "./types.ts";

const LIVE_STATUSES: ReadonlySet<FleetLiveStatus> = new Set(["starting", "running", "idle", "needs_input", "failed"]);

function asLiveStatus(v: unknown): FleetLiveStatus | undefined {
  return typeof v === "string" && LIVE_STATUSES.has(v as FleetLiveStatus) ? (v as FleetLiveStatus) : undefined;
}

/**
 * Delimited block Clawdy embeds in TaskInput.context to drive an explicit
 * Fleet-attachment transition (attach/continue/replace/detach/inspect) — see
 * docs/architecture/2026-08-02-managed-fleet-attachment-plan.md §4. This is
 * deliberately not a new public MCP tool: the directive rides the existing
 * free-text context field and is stripped out before the message reaches the
 * agent, so the agent's prompt never sees raw directive JSON.
 */
const DIRECTIVE_RE = /\[\[clawconnect:fleet\]\]([\s\S]*?)\[\[\/clawconnect:fleet\]\]/;

/**
 * `handle` (and, transitively, `providerSessionId`) end up in filesystem
 * lookups in fleet-adapter.ts (`~/.claude-fleet/<handle>/meta.json`). Reject
 * anything that isn't a plain path segment here, at the parse boundary, so a
 * malformed or hostile directive can never reach the adapter in the first
 * place — the adapter re-validates independently as defense in depth.
 */
const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ParsedFleetDirective = {
  directive: FleetDirective;
  /** `text` with the directive block removed and surrounding whitespace trimmed. */
  strippedText: string;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Validates and narrows a parsed JSON value into a FleetDirective. Returns
 * undefined for anything malformed — a bad directive is silently ignored
 * (the task still submits normally) rather than failing the whole run_task
 * call, matching this repo's existing "best-effort, never throws" posture
 * for auxiliary state (see job-store.ts/fleet-attachment-store.ts).
 */
function validateDirective(value: unknown): FleetDirective | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  if (v.op === "attach" || v.op === "replace") {
    const handle = asString(v.handle);
    const host = asString(v.host);
    if (!handle || !SAFE_HANDLE_RE.test(handle)) return undefined;
    if (!host) return undefined;
    const reason = asString(v.reason);
    if (v.op === "replace" && !reason) return undefined;
    const providerSessionId = asString(v.providerSessionId);
    if (providerSessionId && !SAFE_HANDLE_RE.test(providerSessionId)) return undefined;
    return {
      op: v.op,
      handle,
      host,
      providerSessionId,
      worktree: asString(v.worktree),
      remoteUrl: asString(v.remoteUrl),
      ...(reason ? { reason } : {}),
      status: asLiveStatus(v.status),
    };
  }
  if (v.op === "continue") return { op: "continue", status: asLiveStatus(v.status) };
  if (v.op === "detach") {
    const reason = asString(v.reason);
    if (!reason) return undefined;
    return { op: "detach", reason };
  }
  if (v.op === "inspect") return { op: "inspect", status: asLiveStatus(v.status) };
  return undefined;
}

/**
 * Finds and parses the FIRST directive block in `text` (a second block is
 * ignored — one transition per submitTask call). Returns undefined when no
 * block is present, the JSON doesn't parse, or the directive fails
 * validation; in every undefined case the caller should treat `text` as
 * carrying no directive and use it unmodified.
 */
export function parseFleetDirective(text: string | undefined): ParsedFleetDirective | undefined {
  if (!text) return undefined;
  const match = DIRECTIVE_RE.exec(text);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }

  const directive = validateDirective(parsed);
  if (!directive) return undefined;

  const strippedText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { directive, strippedText };
}
