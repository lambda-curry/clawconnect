/**
 * The provider-neutral half of the managed-attachment model: what a *runtime*
 * is, how a host teaches ClawConnect about one, and how whatever that runtime
 * answers becomes the single normalized shape the rest of the codebase reads.
 *
 * The durable side of the model — one current attachment per
 * conversation, replacement lineage, restart persistence, parent/turn
 * correlation — already exists in session.ts + attachment-store.ts and is
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
 * authentication. A host that drives such a runtime keeps all of that on
 * its own side of the callback boundary; ClawConnect only ever learns "runtime
 * X can be asked about session Y, and here is how".
 *
 * There is deliberately NO list/enumerate callback and no spawn. Every
 * operation addresses exactly one already-known attachment, so there is no
 * surface through which ClawConnect could sweep a runtime's sessions — the
 * structural form of "no heuristic scanning" that the attachment model already
 * holds, for every runtime alike.
 */

/** Which system owns a managed session's lifecycle — always a host-registered id; ClawConnect ships none. */
export type AgentSessionRuntimeId = string;

/** Which agent/model runs *inside* that session. Distinct from the runtime: two runtimes may run the same agent. */
export type AgentSessionProviderId = string;

/**
 * Lifecycle vocabulary, neutral across runtimes and closed — a runtime cannot
 * introduce a state no consumer knows how to branch on.
 *
 * Two runtimes disagree about which state means "the turn finished well": a
 * pane-based runtime's terminal success is `idle` (the pane stopped working),
 * a service-style runtime's is `completed`. Both are in the union and both are treated as a
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
 * `terminalReason` written on a parent turn that ended with nothing to show
 * because the session it delegated to is waiting on a human. The state rides
 * in the suffix so a caller can branch on WHICH block without a second field.
 *
 * A blocked delegation is the one "no summary" outcome that is not an ordinary
 * quiet finish: it is actionable, and every public surface has to be able to
 * tell the two apart (see describeBlockedAgentSession, and the needs-human
 * mapping in tools.ts).
 */
export const DELEGATE_BLOCKED_TERMINAL_REASON = "delegate-blocked";

export function delegateBlockedTerminalReason(state: AgentSessionState): string {
  return `${DELEGATE_BLOCKED_TERMINAL_REASON}:${state}`;
}

export function isDelegateBlockedTerminalReason(reason: string | undefined): boolean {
  return reason?.startsWith(`${DELEGATE_BLOCKED_TERMINAL_REASON}:`) === true;
}

/**
 * The neutral shape every blocked-delegation surface reads. Structurally typed
 * rather than importing AgentSessionAttachment: types.ts already imports from
 * this module, and this is the only part of the record any of them needs.
 */
export type BlockedAgentSessionView = {
  runtime: string;
  handle: string;
  status: string;
  latestResponse?: string;
  remoteUrl?: string;
};

function blockedSentence(attachment: BlockedAgentSessionView, lead: string, tail: string): string {
  const waiting = attachment.status === "needs_permission" ? "waiting for permission" : "waiting for input";
  const asked = attachment.latestResponse ? ` It last said: ${attachment.latestResponse}` : "";
  const where = attachment.remoteUrl ? ` Open it at ${attachment.remoteUrl}.` : "";
  return `${lead} ${attachment.runtime}/${attachment.handle} is ${waiting}.${asked}${where} ${tail}`;
}

/**
 * One sentence a caller can act on, for an attachment that is waiting on a
 * human — shared by every text surface so the MCP and ChatGPT transports
 * cannot drift on how a blocked delegation reads.
 */
export function describeBlockedAgentSession(
  attachment: BlockedAgentSessionView | undefined,
): string | undefined {
  if (!attachment || !isBlockedAgentSessionState(attachment.status)) return undefined;
  return blockedSentence(
    attachment,
    "This turn produced no result of its own: the delegated session",
    "Answer it through that session — the task is not finished.",
  );
}

/**
 * The same fact, said for a turn that is STILL RUNNING. The distinction the
 * wording has to carry is what a caller should do next: the terminal notice
 * says the task is over and unfinished, this one says the task is alive but
 * cannot move — and that continuing to poll, which is exactly what check_task
 * tells a model to do, will never unblock it.
 */
export function describeActiveBlockedAgentSession(
  attachment: BlockedAgentSessionView | undefined,
): string | undefined {
  if (!attachment || !isBlockedAgentSessionState(attachment.status)) return undefined;
  return blockedSentence(
    attachment,
    "This task is not progressing: the delegated session",
    "Polling cannot advance it — answer it through that session, then keep polling.",
  );
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
 * state so "we could not reach the runtime" never reads as "the session failed".
 */
export type AgentSessionError = {
  /** Stable and machine-branchable: "unknown_runtime", "unsupported_operation", "session_not_found", "<op>_failed". */
  code: string;
  message: string;
};

/**
 * The neutral view of one attachment handed to a runtime callback. Built from
 * the durable record by session.ts, deliberately NOT the record itself: a host
 * never sees ClawConnect's internal attachment shape (lineage ids, delegated turn
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

/**
 * What a job-shaped surface needs to decide whether its turn is blocked. Both
 * a live JobSnapshot and a stored Job row satisfy it.
 */
export type BlockedDelegationSnapshot = {
  jobId: string;
  status: string;
  agentSession?: BlockedAgentSessionView & { delegatedTurnId?: string };
};

/**
 * The attachment THIS turn is blocked on, or undefined.
 *
 * Scoped to the turn that actually delegated (`delegatedTurnId === jobId`),
 * for the same reason recovery is: an attachment left current from an earlier
 * turn says nothing about this one, and letting it speak here would make every
 * later task on the session read as blocked.
 */
function blockedAttachmentForTurn(
  snapshot: BlockedDelegationSnapshot,
): (BlockedAgentSessionView & { delegatedTurnId?: string }) | undefined {
  const attachment = snapshot.agentSession;
  if (!attachment || attachment.delegatedTurnId !== snapshot.jobId) return undefined;
  return isBlockedAgentSessionState(attachment.status) ? attachment : undefined;
}

/**
 * A turn waiting on a human in the session it delegated to, in the one neutral
 * shape every surface projects from — listing rows and both transports' text.
 *
 * Fires for a RUNNING turn as well as a terminal one. That is the whole point:
 * the child blocks long before the parent turn ends, so a projection that only
 * spoke at terminal left the normal case — a live delegation sitting on a
 * question — reading as an ordinary busy task that just needs more polling.
 *
 * Derived from the attachment rather than from the job's terminalReason on
 * purpose: the block can also be discovered by a read that lands AFTER the job
 * went terminal, and this stays right in that case too.
 */
export type BlockedDelegation = {
  runtime: string;
  handle: string;
  /** Which block — "needs_input" or "needs_permission" — so a caller need not re-derive it from prose. */
  state: AgentSessionState;
  /** Where a human opens the session, when the runtime published one. */
  remoteUrl?: string;
  /** True while the parent turn is still running; false once it has gone terminal. */
  active: boolean;
  notice: string;
};

export function blockedDelegation(snapshot: BlockedDelegationSnapshot): BlockedDelegation | undefined {
  const attachment = blockedAttachmentForTurn(snapshot);
  if (!attachment) return undefined;
  const active = snapshot.status === "running";
  const notice = active
    ? describeActiveBlockedAgentSession(attachment)
    : describeBlockedAgentSession(attachment);
  if (!notice) return undefined;
  return {
    runtime: attachment.runtime,
    handle: attachment.handle,
    state: attachment.status as AgentSessionState,
    ...(attachment.remoteUrl ? { remoteUrl: attachment.remoteUrl } : {}),
    active,
    notice,
  };
}

/**
 * The TERMINAL notice only — the form the transports' terminal branches use,
 * so neither can quietly present a finished-but-blocked delegation as an
 * ordinary finished task. A running turn is answered by `blockedDelegation`,
 * whose notice is phrased for a task that is still alive.
 */
export function blockedDelegationNotice(snapshot: BlockedDelegationSnapshot): string | undefined {
  if (snapshot.status === "running") return undefined;
  return blockedDelegation(snapshot)?.notice;
}

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
  /**
   * Aborted when the operation is abandoned — either by the caller's own
   * signal, or by the bounded deadline below. A runtime that honors it can
   * stop work it will never be asked about again; one that ignores it is
   * still abandoned, because the deadline does not depend on cooperation.
   */
  signal?: AbortSignal;
  /**
   * Deadline for ONE callback, in ms. Defaults to
   * AGENT_SESSION_CALL_TIMEOUT_MS; <= 0 or non-finite disables the bound
   * (tests that drive their own clock, and nothing in production).
   */
  timeoutMs?: number;
};

/**
 * How long ONE runtime callback may run before the read is abandoned as
 * `unavailable`.
 *
 * A callback is host code reaching a service ClawConnect knows nothing about.
 * Without a deadline, a hung HTTP request inside a host's `inspect` wedges a
 * ClawConnect turn forever — terminal recovery awaits that call, so the job
 * never reaches ANY terminal status and the caller polls a job that will never
 * move. A timeout is not a failure of the session: it comes back through the
 * same best-effort `unavailable` path as every other unanswerable read,
 * carrying the last state anyone reported.
 */
export const AGENT_SESSION_CALL_TIMEOUT_MS = 60_000;

/** Thrown only by withAgentSessionTimeout; branch on it with isAgentSessionTimeout. */
class AgentSessionTimeoutError extends Error {
  readonly isAgentSessionTimeout = true;
}

export function isAgentSessionTimeout(err: unknown): boolean {
  return err instanceof AgentSessionTimeoutError;
}

/**
 * Runs one asynchronous operation under a deadline, aborting it (and any
 * caller-supplied signal chain) when the deadline passes. Used for every call
 * out of ClawConnect into code it does not own — which since 2026-08-18 means
 * exactly the registry callbacks below, no adapter of our own having survived
 * the move to examples/.
 */
export async function withAgentSessionTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = AGENT_SESSION_CALL_TIMEOUT_MS,
  outer?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return op(outer ?? new AbortController().signal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", forwardAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new AgentSessionTimeoutError(`No answer within ${timeoutMs}ms.`);
          // Abort first: the operation is abandoned whether or not it ever
          // settles, and a runtime that honors the signal can stop now.
          controller.abort(err);
          reject(err);
        }, timeoutMs);
        // A pending deadline is never a reason to hold the process open.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", forwardAbort);
  }
}

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
 * SessionManager the same way the job store and the legacy adapter are, so
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
  // Which agent runs INSIDE the session is a property of the runtime that
  // answers for it, not of the text that named the session: a marker cannot
  // claim a provider the registered runtime does not have, and a marker that
  // omits one cannot erase what the runtime already told us. Applied to the
  // ref itself, so the callback and the normalized status agree.
  const boundRef = ref.provider === runtime.provider ? ref : { ...ref, provider: runtime.provider };
  try {
    const observed = await withAgentSessionTimeout(
      (signal) => callRuntime(runtime, boundRef, request, { ...opts, signal }),
      opts.timeoutMs,
      opts.signal,
    );
    return normalizeAgentSessionObservation(boundRef, observed ?? NOT_FOUND, now);
  } catch (err) {
    const timedOut = isAgentSessionTimeout(err);
    return unavailableAgentSessionStatus(
      boundRef,
      now,
      {
        code: timedOut ? `${request.op}_timeout` : `${request.op}_failed`,
        message: err instanceof Error ? err.message : String(err),
      },
      timedOut
        ? `Runtime "${ref.runtime}" did not answer the ${request.op} in time and was abandoned — the session itself may be fine.`
        : `Runtime "${ref.runtime}" could not ${request.op} this session.`,
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
