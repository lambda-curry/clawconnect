/**
 * The provider-neutral half of the managed-attachment model: what a *runtime*
 * is, how a host teaches ClawConnect about one, and how whatever that runtime
 * answers becomes the single normalized shape the rest of the codebase reads.
 *
 * The durable side of the model — one current attachment per Clawdy
 * conversation, replacement lineage, restart persistence, parent/turn
 * correlation — already exists in session.ts + fleet-attachment-store.ts and is
 * NOT duplicated here. This module owns exactly two things:
 *
 *   1. `AgentSessionRuntimeRegistry` — a host registers one runtime id/provider
 *      plus per-session `inspect`/`continue`/`detach` callbacks. Capabilities
 *      are DERIVED from which callbacks were supplied, never declared, because
 *      a runtime that announces `continue: true` and has no continue callback
 *      is a lie a caller discovers at the worst possible moment.
 *   2. `normalizeAgentSessionObservation` — one place where a loose runtime
 *      reply becomes an `AgentSessionStatus` with a closed state vocabulary,
 *      epoch-ms timestamps, and a `finalResponse` that only exists for a turn
 *      that genuinely completed.
 *
 * Nothing here knows a runtime's CLI, transport, pairing, project model, or
 * authentication. A host that drives T3 (or anything else) keeps all of that on
 * its own side of the callback boundary; ClawConnect only ever learns "runtime
 * X can be asked about session Y, and here is how".
 *
 * There is deliberately NO list/enumerate callback and no spawn. Every
 * operation addresses exactly one already-known attachment, so there is no
 * surface through which ClawConnect could sweep a runtime's sessions — the
 * structural form of "no heuristic scanning" that the Fleet model already
 * holds for claude-fleet.
 */

/** Which system owns a managed session's lifecycle: "claude-fleet", "t3-fleet", … */
export type AgentSessionRuntimeId = string;

/** Which agent/model runs *inside* that session. Distinct from the runtime: T3 running Claude is not claude-fleet running Claude. */
export type AgentSessionProviderId = string;

/**
 * Lifecycle vocabulary, neutral across runtimes and closed — a runtime cannot
 * introduce a state no consumer knows how to branch on.
 *
 * Two runtimes disagree about which state means "the turn finished well":
 * claude-fleet's terminal success is `idle` (the tmux pane stopped working),
 * T3's is `completed`. Both are in the union and both are treated as a
 * completed turn (see COMPLETED_TURN_STATES) rather than forcing either
 * published vocabulary to move.
 *
 * The "nothing useful is happening" cases stay distinct because they demand
 * different responses:
 *   unavailable — no state reachable from here. The session may be perfectly
 *                 alive elsewhere; this is NOT evidence of failure.
 *   unknown     — reached, but the runtime said nothing recognizable.
 *   failed      — it never came up.
 *   dead        — it ran, then went away without finishing a turn.
 *   stale       — alive, but silent long enough to be suspicious.
 */
export type AgentSessionState =
  | "starting"
  | "running"
  | "idle"
  | "needs_input"
  | "needs_permission"
  | "completed"
  | "stale"
  | "dead"
  | "failed"
  | "unavailable"
  | "unknown";

const AGENT_SESSION_STATES: readonly string[] = [
  "starting",
  "running",
  "idle",
  "needs_input",
  "needs_permission",
  "completed",
  "stale",
  "dead",
  "failed",
  "unavailable",
  "unknown",
];

/**
 * The states in which a runtime's latest assistant text is the answer to a
 * turn rather than a partial thought — the ONLY states for which
 * `finalResponse` is ever populated. See AgentSessionState for why there are
 * two of them.
 */
export const COMPLETED_TURN_STATES: readonly AgentSessionState[] = ["completed", "idle"];

export function isCompletedTurnState(state: AgentSessionState): boolean {
  return COMPLETED_TURN_STATES.includes(state);
}

/** States a session has genuinely stopped in — the only ones that may carry `termination`. */
const TERMINAL_STATES: readonly AgentSessionState[] = ["completed", "idle", "dead", "failed"];

/**
 * States that mean the session is waiting on a human. A recovery path must
 * never paper over one of these with leftover transcript text: the attachment
 * has to stay actionable.
 */
const BLOCKED_STATES: readonly AgentSessionState[] = ["needs_input", "needs_permission"];

export function isBlockedAgentSessionState(state: string | undefined): boolean {
  return state !== undefined && BLOCKED_STATES.includes(state as AgentSessionState);
}

/**
 * A state name from outside — a marker's JSON, a host callback's return value.
 * Anything outside the vocabulary is rejected rather than passed through.
 */
export function coerceAgentSessionState(value: unknown): AgentSessionState | undefined {
  return typeof value === "string" && AGENT_SESSION_STATES.includes(value) ? (value as AgentSessionState) : undefined;
}

/** Why a session stopped, when it stopped for a reason worth distinguishing. */
export type AgentSessionTermination = {
  reason: "completed" | "cancelled" | "failed" | "died" | "unknown";
  /** Epoch ms, when the runtime can say. */
  at?: number;
  /** Process/container exit code, for runtimes that have one. */
  exitCode?: number;
  message?: string;
};

const TERMINATION_REASONS: readonly string[] = ["completed", "cancelled", "failed", "died", "unknown"];

/**
 * A failure of the READ, not of the session: the runtime could not be asked,
 * or answered with an error. Kept separate from the session's own `failed`
 * state so "we could not reach T3" never reads as "the T3 session failed".
 */
export type AgentSessionError = {
  /** Stable and machine-branchable: "unknown_runtime", "unsupported_operation", "session_not_found", "<op>_failed". */
  code: string;
  message: string;
};

/**
 * The neutral view of one attachment handed to a runtime callback. Built from
 * the durable record by session.ts, deliberately NOT the record itself: a host
 * never sees ClawConnect's Fleet-shaped internals (lineage ids, delegated turn
 * tokens, stored results), only what it needs to address the session.
 */
export type AgentSessionRef = {
  runtime: AgentSessionRuntimeId;
  provider?: AgentSessionProviderId;
  /** The session's id in its runtime's own namespace — the handle a caller passes back to address it. */
  sessionId: string;
  /** The provider's own session/thread id, a different namespace from sessionId. */
  providerSessionId?: string;
  /** Host whose runtime state owns this session, when the producer said so. */
  host?: string;
  /** Where a human opens this session (claude.ai/code URL, service console, …). */
  remoteUrl?: string;
  /** Runtime-specific extras that do not fit the neutral shape. Strings only. */
  metadata?: Record<string, string>;
  /** The last state anyone actually reported — context for a runtime that wants it, never authority. */
  lastKnownState?: AgentSessionState;
};

/**
 * What a runtime is allowed to hand back about ONE session — deliberately
 * loose, because the point of the callback seam is that a host can forward its
 * own CLI/API output without first learning ClawConnect's exact types.
 * Timestamps may be epoch ms or ISO strings; every field is optional.
 *
 * What it deliberately CANNOT carry is identity: no runtime, no sessionId, no
 * attachment id. An observation describes the session it was asked about, and
 * a reply that renamed the session would be a silent replacement of the
 * conversation's one attachment.
 */
export type AgentSessionObservation = {
  state?: string;
  alive?: boolean;
  startedAt?: number | string;
  lastEventAt?: number | string;
  /** Latest assistant text, whatever the state. */
  latestResponse?: string;
  /** Latest assistant text the runtime considers final. Honored only in a completed-turn state. */
  finalResponse?: string;
  detail?: string;
  error?: { code?: string; message?: string } | string;
  termination?: { reason?: string; at?: number | string; exitCode?: number; message?: string };
  providerSessionId?: string;
  remoteUrl?: string;
  host?: string;
  metadata?: Record<string, unknown>;
};

/** The normalized, read-time view of one attachment. Identity always comes from the ref. */
export type AgentSessionStatus = {
  runtime: AgentSessionRuntimeId;
  provider?: AgentSessionProviderId;
  sessionId: string;
  providerSessionId?: string;
  host?: string;
  remoteUrl?: string;
  state: AgentSessionState;
  /** Liveness. undefined when the runtime could not determine it — different from "gone". */
  alive?: boolean;
  startedAt?: number;
  lastEventAt?: number;
  latestResponse?: string;
  /** Populated ONLY when `state` is a completed-turn state. See COMPLETED_TURN_STATES. */
  finalResponse?: string;
  detail?: string;
  error?: AgentSessionError;
  termination?: AgentSessionTermination;
  metadata?: Record<string, string>;
  /** When this read ran (epoch ms). */
  reconciledAt: number;
};

// ── The callback seam ────────────────────────────────────────────────────────

/**
 * The whole integration for a runtime ClawConnect does not implement itself:
 * an id, a provider, and up to three functions, each addressing ONE session.
 *
 * `inspect` is the only required one — a runtime ClawConnect can read but not
 * drive is still fully useful, and declaring the other two optional is what
 * makes the derived capabilities honest.
 */
export type AgentSessionRuntimeCallbacks = {
  id: AgentSessionRuntimeId;
  provider: AgentSessionProviderId;
  /**
   * Read one session. Returning null/undefined means "this runtime has no such
   * session", which normalizes to `unavailable` + `session_not_found` — not to
   * a failure of the session, and not to a thrown error.
   */
  inspect(ref: AgentSessionRef, opts: AgentSessionCallOptions): Promise<AgentSessionObservation | null | undefined>;
  /** Deliver a follow-up turn to a session. Absent → the runtime reports `continue: false`. */
  continue?(
    ref: AgentSessionRef,
    request: { prompt?: string },
    opts: AgentSessionCallOptions,
  ): Promise<AgentSessionObservation | null | undefined>;
  /** Stop the session in its runtime. Absent → the runtime reports `detach: false`. */
  detach?(
    ref: AgentSessionRef,
    request: { reason?: string },
    opts: AgentSessionCallOptions,
  ): Promise<AgentSessionObservation | null | undefined>;
};

export type AgentSessionCallOptions = {
  /** Injected clock, so a caller's single `now` is used for the whole operation. */
  now: number;
  signal?: AbortSignal;
};

/** Derived, never declared — see AgentSessionRuntimeCallbacks. */
export type AgentSessionCapabilities = {
  inspect: boolean;
  continue: boolean;
  detach: boolean;
};

export type AgentSessionRuntime = {
  readonly id: AgentSessionRuntimeId;
  readonly provider: AgentSessionProviderId;
  readonly capabilities: AgentSessionCapabilities;
  readonly callbacks: AgentSessionRuntimeCallbacks;
};

const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidRuntimeId(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_ID_RE.test(value);
}

/**
 * An INSTANCE, not a module-level singleton: it is injected into
 * SessionManager the same way the job store and the Fleet adapter are, so
 * tests never have to reset shared global state and two hosts in one process
 * cannot silently share a runtime table.
 */
export class AgentSessionRuntimeRegistry {
  private runtimes = new Map<AgentSessionRuntimeId, AgentSessionRuntime>();

  /** Registers (or replaces) one runtime. Throws only on a malformed id — a wiring bug, not a runtime condition. */
  register(callbacks: AgentSessionRuntimeCallbacks): AgentSessionRuntime {
    if (!isValidRuntimeId(callbacks.id)) {
      throw new Error(`[agent-session] invalid runtime id: ${JSON.stringify(callbacks.id)}`);
    }
    const runtime: AgentSessionRuntime = {
      id: callbacks.id,
      provider: callbacks.provider,
      capabilities: {
        inspect: true,
        continue: typeof callbacks.continue === "function",
        detach: typeof callbacks.detach === "function",
      },
      callbacks,
    };
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  get(id: AgentSessionRuntimeId): AgentSessionRuntime | undefined {
    return this.runtimes.get(id);
  }

  has(id: AgentSessionRuntimeId): boolean {
    return this.runtimes.has(id);
  }

  /**
   * Registered runtime IDS only — never their sessions. Exists so a host can
   * confirm its own wiring; there is no call path from here to a runtime's
   * session list, because no such callback exists.
   */
  ids(): AgentSessionRuntimeId[] {
    return [...this.runtimes.keys()];
  }
}

// ── Normalization ────────────────────────────────────────────────────────────

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Epoch ms from either an epoch number or an ISO string — runtimes report both. */
export function coerceEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * Metadata is strings-only by contract so an attachment stays trivially
 * serializable through the JSON attachment store. Finite scalars are
 * stringified rather than dropped — a runtime reporting `{"attempt": 2}` means
 * something by it, and losing that silently is worse than coercing it.
 */
export function coerceMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    else if (typeof v === "boolean") out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceError(raw: AgentSessionObservation["error"]): AgentSessionError | undefined {
  if (typeof raw === "string") return raw ? { code: "runtime_error", message: raw } : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const message = optString(raw.message);
  const code = optString(raw.code);
  if (!message && !code) return undefined;
  return { code: code ?? "runtime_error", message: message ?? (code as string) };
}

/**
 * Termination is emitted only for terminal states. A runtime reporting both
 * `running` and a termination is confused, and passing that through would let
 * a consumer branching on `termination` call a live session finished.
 */
function coerceTermination(
  raw: AgentSessionObservation["termination"],
  state: AgentSessionState,
  fallbackAt: number | undefined,
): AgentSessionTermination | undefined {
  if (!TERMINAL_STATES.includes(state)) return undefined;
  const reasonRaw = raw && typeof raw === "object" ? optString(raw.reason) : undefined;
  const reason = reasonRaw && TERMINATION_REASONS.includes(reasonRaw) ? (reasonRaw as AgentSessionTermination["reason"]) : undefined;
  const derived: AgentSessionTermination["reason"] = isCompletedTurnState(state)
    ? "completed"
    : state === "dead"
      ? "died"
      : "failed";
  const at = coerceEpochMs(raw?.at) ?? fallbackAt;
  const exitCode = typeof raw?.exitCode === "number" ? raw.exitCode : undefined;
  const message = optString(raw?.message);
  return {
    reason: reason ?? derived,
    ...(at !== undefined ? { at } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * A loose runtime observation → the one normalized shape every consumer reads.
 * The rules enforced here, once, for every runtime that comes in through the
 * callback seam:
 *
 *   - identity (runtime, sessionId) comes from the REF, never from the reply,
 *     so a runtime cannot rename the session a conversation is attached to;
 *   - the state vocabulary is closed — an unrecognized state reads `unknown`;
 *   - `finalResponse` exists only in a completed-turn state, so a partial
 *     answer from a running or blocked session can never be mistaken for the
 *     turn's result;
 *   - `termination` only for terminal states, derived from the state when the
 *     runtime did not say;
 *   - timestamps in epoch ms whether the runtime sent epochs or ISO strings;
 *   - metadata merged over the ref's, strings only.
 */
export function normalizeAgentSessionObservation(
  ref: AgentSessionRef,
  observation: AgentSessionObservation,
  now: number,
): AgentSessionStatus {
  const state = coerceAgentSessionState(observation.state) ?? "unknown";
  const startedAt = coerceEpochMs(observation.startedAt);
  const lastEventAt = coerceEpochMs(observation.lastEventAt);
  const latestResponse = optString(observation.latestResponse);
  const finalResponse = isCompletedTurnState(state)
    ? (optString(observation.finalResponse) ?? latestResponse)
    : undefined;
  const observed = coerceMetadata(observation.metadata);
  const metadata = ref.metadata || observed ? { ...ref.metadata, ...observed } : undefined;
  const error = coerceError(observation.error);
  const termination = coerceTermination(observation.termination, state, lastEventAt);
  return {
    runtime: ref.runtime,
    provider: ref.provider,
    sessionId: ref.sessionId,
    providerSessionId: optString(observation.providerSessionId) ?? ref.providerSessionId,
    host: optString(observation.host) ?? ref.host,
    remoteUrl: optString(observation.remoteUrl) ?? ref.remoteUrl,
    state,
    ...(typeof observation.alive === "boolean" ? { alive: observation.alive } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    ...(latestResponse ? { latestResponse } : {}),
    ...(finalResponse ? { finalResponse } : {}),
    ...(optString(observation.detail) ? { detail: optString(observation.detail) } : {}),
    ...(error ? { error } : {}),
    ...(termination ? { termination } : {}),
    ...(metadata ? { metadata } : {}),
    reconciledAt: now,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type AgentSessionRequest =
  | { op: "inspect" }
  | { op: "continue"; prompt?: string }
  | { op: "detach"; reason?: string };

/**
 * A read that could not be performed. Never an exception: a ClawConnect task
 * must not fail on account of a delegation, so "this build cannot ask that
 * runtime" comes back as a normal status with a branchable code and the last
 * state anyone reported still attached.
 */
export function unavailableAgentSessionStatus(
  ref: AgentSessionRef,
  now: number,
  error: AgentSessionError,
  detail: string,
): AgentSessionStatus {
  const known = ref.lastKnownState ? ` Last reported state: ${ref.lastKnownState}.` : "";
  return {
    runtime: ref.runtime,
    provider: ref.provider,
    sessionId: ref.sessionId,
    providerSessionId: ref.providerSessionId,
    host: ref.host,
    remoteUrl: ref.remoteUrl,
    state: "unavailable",
    error,
    detail: `${detail}${known}`,
    ...(ref.metadata ? { metadata: ref.metadata } : {}),
    reconciledAt: now,
  };
}

const NOT_FOUND: AgentSessionObservation = {
  state: "unavailable",
  error: { code: "session_not_found", message: "The runtime has no state for this session." },
};

/**
 * Send exactly one operation to exactly the runtime that owns exactly this
 * attachment. A map lookup and one call — it never enumerates, never throws,
 * and every failure mode (no such runtime, no such capability, the callback
 * threw) returns an `unavailable` status carrying a precise code.
 */
export async function dispatchAgentSession(
  runtime: AgentSessionRuntime | undefined,
  ref: AgentSessionRef,
  request: AgentSessionRequest,
  opts: AgentSessionCallOptions,
): Promise<AgentSessionStatus> {
  const { now } = opts;
  if (!runtime) {
    return unavailableAgentSessionStatus(
      ref,
      now,
      { code: "unknown_runtime", message: `No runtime registered for "${ref.runtime}".` },
      `This ClawConnect build cannot ${request.op} "${ref.runtime}" sessions — the session itself may be fine.`,
    );
  }
  if (!runtime.capabilities[request.op]) {
    return unavailableAgentSessionStatus(
      ref,
      now,
      { code: "unsupported_operation", message: `Runtime "${ref.runtime}" does not support ${request.op}.` },
      `Runtime "${ref.runtime}" registered no ${request.op} callback, so this session cannot be asked to ${request.op}.`,
    );
  }
  try {
    const observed = await callRuntime(runtime, ref, request, opts);
    return normalizeAgentSessionObservation(ref, observed ?? NOT_FOUND, now);
  } catch (err) {
    return unavailableAgentSessionStatus(
      ref,
      now,
      { code: `${request.op}_failed`, message: err instanceof Error ? err.message : String(err) },
      `Runtime "${ref.runtime}" could not ${request.op} this session.`,
    );
  }
}

function callRuntime(
  runtime: AgentSessionRuntime,
  ref: AgentSessionRef,
  request: AgentSessionRequest,
  opts: AgentSessionCallOptions,
): Promise<AgentSessionObservation | null | undefined> {
  const cb = runtime.callbacks;
  switch (request.op) {
    case "inspect":
      return cb.inspect(ref, opts);
    case "continue":
      // Non-null assertions are safe: the capability check above proves the
      // callback exists, and capabilities are derived from the callbacks
      // rather than declared beside them.
      return cb.continue!(ref, { prompt: request.prompt }, opts);
    case "detach":
      return cb.detach!(ref, { reason: request.reason }, opts);
  }
}
