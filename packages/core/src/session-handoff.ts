import { coerceAgentSessionState, coerceMetadata, isValidRuntimeId } from "./agent-session.ts";
import type { AgentSessionDirective, AttachmentLiveStatus } from "./types.ts";

/**
 * A state a directive/marker may assert. The neutral vocabulary minus the two
 * values that describe a READ rather than a session — a producer telling us
 * "unavailable" is telling us about its own reachability, which is not
 * something ClawConnect stores as the session's status. See AttachmentLiveStatus.
 */
function asLiveStatus(v: unknown): AttachmentLiveStatus | undefined {
  const state = coerceAgentSessionState(v);
  return state && state !== "unavailable" && state !== "unknown" ? state : undefined;
}

/**
 * Delimited block the owning host embeds in TaskInput.context to drive an explicit
 * attachment transition (attach/continue/replace/detach/inspect) — see
 * docs/architecture/2026-08-02-managed-fleet-attachment-plan.md §4. This is
 * deliberately not a new public MCP tool: the directive rides the existing
 * free-text context field and is stripped out before the message reaches the
 * agent, so the agent's prompt never sees raw directive JSON.
 */
const DIRECTIVE_RE = /\[\[clawconnect:agent-session\]\]([\s\S]*?)\[\[\/clawconnect:agent-session\]\]/;

/**
 * The runtime-neutral marker every managed-session runtime already prints
 * alongside its own human output (`<agent-session>{…}</agent-session>`). A
 * delegation announces itself in that one line, so attaching a new runtime
 * needs no new directive dialect and no ClawConnect change: the host passes the
 * marker through in `context` and it becomes an `attach`.
 *
 * Non-greedy and anchored on the closing tag so a marker embedded in a larger
 * blob of agent output is extracted exactly, not up to the last brace in the
 * message.
 */
const MARKER_RE = /<agent-session>\s*(\{[\s\S]*?\})\s*<\/agent-session>/;

/**
 * `handle` (and, transitively, `providerSessionId`) are handed to a host's
 * runtime module, which may well turn them into a filesystem path (the
 * local-tmux example does). Reject anything that isn't a plain path segment
 * here, at the parse boundary, so a malformed or hostile directive never
 * reaches a runtime in the first place — a module is expected to re-validate
 * independently as defense in depth, and the shipped example does. The same
 * check applies to a marker's `sessionId`, which is the same value under the
 * neutral name.
 */
const SAFE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ParsedAgentSessionDirective = {
  directive: AgentSessionDirective;
  /** `text` with the directive/marker block removed and surrounding whitespace trimmed. */
  strippedText: string;
};

/**
 * What the submit boundary gets back.
 *
 * `directive` is absent when a block was PRESENT but did not survive
 * validation. That case still carries `strippedText`, and the distinction is
 * the whole point: a malformed directive must be ignored as a directive AND
 * still removed from the text. Previously it was only ignored, so the raw
 * block — delimiters, operator metadata and all — was forwarded into the
 * agent's prompt as prose. See parseSessionHandoff.
 */
export type SessionHandoff = {
  directive?: AgentSessionDirective;
  strippedText: string;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Validates and narrows a parsed JSON value into a AgentSessionDirective. Returns
 * undefined for anything malformed — a bad directive is silently ignored
 * (the task still submits normally) rather than failing the whole run_task
 * call, matching this repo's existing "best-effort, never throws" posture
 * for auxiliary state (see job-store.ts/attachment-store.ts).
 */
function validateDirective(value: unknown): AgentSessionDirective | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  if (v.op === "attach" || v.op === "replace") {
    // `sessionId` is the neutral name for the same value; `handle` stays
    // accepted so every directive written against the original shape keeps
    // working unchanged.
    const handle = asString(v.handle) ?? asString(v.sessionId);
    const host = asString(v.host);
    if (!handle || !SAFE_HANDLE_RE.test(handle)) return undefined;
    // Required on this explicit directive form, unchanged: a caller spelling
    // out an attach by hand knows which machine it meant. The neutral marker
    // path is what may legitimately omit it (see parseAgentSessionMarker).
    if (!host) return undefined;
    // Required, and rejected rather than defaulted when absent: ClawConnect
    // ships no runtime, so there is nothing to fall back to. It defaulted to
    // "claude-fleet" until 2026-08-18, which is how a hardcoded runtime id
    // survived in a layer whose whole claim is that it knows about none. The
    // neutral marker has always required it — this makes the two agree.
    const runtime = asString(v.runtime);
    if (!runtime || !isValidRuntimeId(runtime)) return undefined;
    const reason = asString(v.reason);
    if (v.op === "replace" && !reason) return undefined;
    const providerSessionId = asString(v.providerSessionId);
    if (providerSessionId && !SAFE_HANDLE_RE.test(providerSessionId)) return undefined;
    const metadata = coerceMetadata(v.metadata);
    return {
      op: v.op,
      runtime,
      provider: asString(v.provider),
      handle,
      host,
      providerSessionId,
      worktree: asString(v.worktree),
      remoteUrl: asString(v.remoteUrl),
      ...(metadata ? { metadata } : {}),
      ...(reason ? { reason } : {}),
      status: asLiveStatus(v.status),
    };
  }
  if (v.op === "continue") {
    const prompt = asString(v.prompt);
    return { op: "continue", status: asLiveStatus(v.status), ...(prompt ? { prompt } : {}) };
  }
  if (v.op === "detach") {
    const reason = asString(v.reason);
    if (!reason) return undefined;
    return { op: "detach", reason, ...(v.stopRuntime === true ? { stopRuntime: true } : {}) };
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
export function parseAgentSessionDirective(text: string | undefined): ParsedAgentSessionDirective | undefined {
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

  return { directive, strippedText: stripMatch(text, match) };
}

/**
 * Turns the FIRST neutral `<agent-session>` marker in `text` into an `attach`
 * directive, so a runtime that already prints the marker attaches with no
 * ClawConnect-side parsing of its own.
 *
 * An attach is the only thing a marker can mean: it is a statement of "this
 * session exists and here is its current state", never a lifecycle command.
 * session.ts's attach path already folds a marker naming the session that is
 * ALREADY current into a refresh rather than a new lineage record, which is
 * what makes it safe for a host to include the same marker on every turn.
 *
 * `host` is optional here, unlike the explicit directive: a service runtime's
 * session lives on a server, and the marker's own contract makes the field
 * optional. `state` rides in as the initial status; anything outside the
 * neutral vocabulary is dropped rather than stored.
 */
export function parseAgentSessionMarker(text: string | undefined): ParsedAgentSessionDirective | undefined {
  if (!text) return undefined;
  const match = MARKER_RE.exec(text);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const v = parsed as Record<string, unknown>;

  const handle = asString(v.sessionId) ?? asString(v.handle);
  if (!handle || !SAFE_HANDLE_RE.test(handle)) return undefined;
  const runtime = asString(v.runtime);
  if (!runtime || !isValidRuntimeId(runtime)) return undefined;
  const providerSessionId = asString(v.providerSessionId) ?? asString(v.claudeSessionId);
  if (providerSessionId && !SAFE_HANDLE_RE.test(providerSessionId)) return undefined;
  const metadata = coerceMetadata(v.metadata);

  return {
    directive: {
      op: "attach",
      runtime,
      provider: asString(v.provider),
      handle,
      providerSessionId,
      host: asString(v.host),
      remoteUrl: asString(v.remoteUrl) ?? asString(v.remoteControlUrl),
      // The one field a marker carries that the neutral shape has no home for:
      // it is runtime-specific, so it rides through metadata like everything
      // else a runtime wants a reader to see.
      ...(metadata?.worktreePath ? { worktree: metadata.worktreePath } : {}),
      ...(metadata ? { metadata } : {}),
      status: asLiveStatus(v.state),
    },
    strippedText: stripMatch(text, match),
  };
}

function stripMatch(text: string, match: RegExpExecArray): string {
  return (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
}

/**
 * The single parse boundary submitTask uses: an explicit
 * `[[clawconnect:agent-session]]` directive wins when present (it can express every
 * transition, not just attach), and a bare neutral marker is the fallback.
 *
 * A block that is present but MALFORMED — unparseable JSON, an unknown op, a
 * missing runtime — is still stripped, and returns without a `directive`.
 * "It did not validate" is not a reason to forward operator metadata into the
 * agent's prompt: submitTask's contract is that buildSubmitMessage never sees
 * a raw directive block, and until this existed that held only on the happy
 * path. A malformed block was silently ignored by the parser and then
 * delivered verbatim to the agent, which is the same class of defect as any
 * other content reaching an instruction stream it was never addressed to.
 *
 * Returns undefined only when there is no block at all — the ordinary case,
 * where the text is used unmodified.
 */
export function parseSessionHandoff(text: string | undefined): SessionHandoff | undefined {
  const parsed = parseAgentSessionDirective(text) ?? parseAgentSessionMarker(text);
  if (parsed) return parsed;
  if (!text) return undefined;
  const match = DIRECTIVE_RE.exec(text) ?? MARKER_RE.exec(text);
  return match ? { strippedText: stripMatch(text, match) } : undefined;
}
