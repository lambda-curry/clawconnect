import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  NO_SUMMARY_SENTINEL,
  ParentObservationTimeoutError,
  type GatewayConfig,
  type GatewayEvent,
  type TranscriptTransportUpdate,
} from "./types.ts";

/**
 * How long a run whose socket dropped waits for a reconnect to deliver the
 * terminal event it never saw, before handing off to the caller's durable
 * recovery. Long enough to cover the gateway's own reconnect backoff; nowhere
 * near the observation window, which is the whole point — see the socket-close
 * door in chat().
 */
const STREAM_CLOSE_GRACE_MS = (() => {
  const raw = Number(process.env.CLAWCONNECT_STREAM_CLOSE_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

function logDebug(message: string, ...args: unknown[]): void {
  console.error(message, ...args);
}

/**
 * Extract the user-facing reply body when the agent calls OpenClaw's generic
 * `message` tool. Returns the trimmed text, or `""` when the tool isn't
 * `message` or no recognizable body field is present.
 *
 * Why: openclaw's `message` tool routes its payload through the agent's
 * configured delivery channel (WhatsApp, internal-ui, etc.) rather than
 * surfacing it back to the run_task caller via `chat:final`. The model's
 * own final assistant text in that case is typically a short ack like
 * "Sent the packet inline through chat." This helper recovers the intended
 * body from the tool args so the gateway can return it as the reply.
 *
 * Args shape varies: codex-app-server sends `{action, message}`, other
 * runtimes use `{content}` or `{text}`. Try each in order.
 *
 * Mirrors `captureInternalMessageReply` in
 * services/linear-agent/src/linear-stream.ts.
 */
export function extractMessageToolReply(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (toolName !== "message" || !args) return "";
  const candidate = args.message ?? args.content ?? args.text;
  if (typeof candidate !== "string") return "";
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : "";
}

// ── Device identity ──────────���───────────────────────────────────────────────

const DEVICE_FILE = join(homedir(), ".openclaw", "clawd-ui-device.json");

interface DeviceIdentity {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

function toBase64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateDevice(): DeviceIdentity {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync("ed25519");
  const privJwk = priv.export({ format: "jwk" }) as { d: string };
  const pubJwk = pub.export({ format: "jwk" }) as { x: string };
  const pubBytes = Buffer.from(pubJwk.x, "base64url");
  const privBytes = Buffer.from(privJwk.d, "base64url");
  const deviceId = createHash("sha256").update(pubBytes).digest("hex");
  return {
    version: 1,
    deviceId,
    publicKey: toBase64url(pubBytes),
    privateKey: toBase64url(privBytes),
  };
}

function loadOrCreateDevice(): DeviceIdentity {
  if (existsSync(DEVICE_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEVICE_FILE, "utf8")) as DeviceIdentity;
      if (d.version === 1 && d.deviceId && d.publicKey && d.privateKey) return d;
    } catch {
      // Regenerate on corrupt file
    }
  }
  const d = generateDevice();
  mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
  writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2), { mode: 0o600 });
  logDebug("[openclaw-gateway] generated new device identity");
  return d;
}

function signChallenge(input: {
  privateKey: string;
  deviceId: string;
  signedAt: number;
  nonce: string;
  token: string;
}): string {
  const payload = [
    "v3",
    input.deviceId,
    "gateway-client",
    "backend",
    "operator",
    "operator.read,operator.write,operator.admin",
    String(input.signedAt),
    input.token,
    input.nonce,
    "node",
    "",
  ].join("|");

  const privBytes = Buffer.from(input.privateKey, "base64url");
  const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8Der = Buffer.concat([PKCS8_PREFIX, privBytes]);
  const key = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  return toBase64url(sign(null, Buffer.from(payload), key));
}

// ── Frame types ──────────────────────────────────────────────────────────────

interface Frame {
  type: "req" | "res" | "event";
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: unknown;
  event?: string;
  method?: string;
}

/**
 * Ceiling on frames held between subscribing and learning the runId (see
 * `chat`). One RPC round-trip's worth of events is a handful; this only
 * bounds the pathological case where the send never comes back.
 */
const MAX_PRE_RUNID_FRAMES = 500;

interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: { content: Array<{ type: string; text?: string; thinking?: string }> };
  errorMessage?: string;
}

type SessionMessagePayload = {
  sessionKey?: string;
  messageId?: string;
  messageSeq?: number;
  message?: Record<string, unknown>;
};

type HistoryPage = {
  messages?: unknown[];
  hasMore?: boolean;
  nextOffset?: number | null;
};

function transcriptMessageIdentity(message: Record<string, unknown>): {
  id?: string;
  sequence?: number;
} {
  const meta = message.__openclaw;
  const record = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
  return {
    ...(typeof record?.id === "string" ? { id: record.id } : {}),
    ...(typeof record?.seq === "number" && Number.isSafeInteger(record.seq) && record.seq > 0
      ? { sequence: record.seq }
      : {}),
  };
}

/**
 * Older history rows can predate durable message metadata. Their content hash
 * is weaker than the upstream identity, but still prevents a catch-up read
 * from projecting the same legacy tool row on every replay pass.
 */
function transcriptMessageFallbackId(message: Record<string, unknown>): string {
  return `legacy:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
}

/** Project one durable transcript row into the connector's progress events. */
export function transcriptMessageEvents(message: Record<string, unknown>): GatewayEvent[] {
  const role = message.role;
  if (role === "assistant" && Array.isArray(message.content)) {
    return message.content.flatMap((block): GatewayEvent[] => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return [];
      const value = block as Record<string, unknown>;
      if (value.type !== "toolCall") return [];
      const toolName = typeof value.name === "string" ? value.name : "unknown";
      const candidate = value.arguments ?? value.input;
      const args = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : {};
      const summary = args.command ?? args.file_path ?? args.pattern ?? args.query ?? "";
      const summaryText =
        typeof summary === "string" || typeof summary === "number" || typeof summary === "boolean"
          ? String(summary)
          : "";
      return [{
        type: "tool",
        text: `${toolName}: ${summaryText.slice(0, 80)}`,
        toolName,
        args,
      }];
    });
  }
  if (role !== "toolResult") return [];
  const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
  const isError = message.isError === true;
  return [{
    type: "tool-result",
    text: `${toolName} ${isError ? "failed" : "done"}`,
    toolName,
    isError,
  }];
}

/**
 * Extract visible assistant text from a `chat.history` message. The gateway
 * projects history messages with `content` as either an array of typed blocks
 * or a plain string, and some carry a top-level `text` instead.
 */
function extractAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text?: string } =>
          Boolean(b) && typeof b === "object" && !Array.isArray(b),
      )
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }
  if (typeof content === "string") return content.trim();
  if (typeof message.text === "string") return message.text.trim();
  return "";
}

export function formatLifecycleEventText(phase: unknown): string {
  const normalized = typeof phase === "string" && phase.trim() ? phase.trim() : "unknown";
  return `Agent lifecycle: ${normalized}`;
}

/**
 * Trailing-assistant scan of a `chat.history` message list, newest-first.
 * Skips assistant messages with no visible text (thinking-only / tool-only
 * turns) — they don't carry the report — but stops at the first
 * non-assistant entry: the agent's final visible answer is the last
 * assistant text after the last tool round, and walking past a toolResult
 * into older preamble would return stale content.
 */
export function trailingAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || (m as Record<string, unknown>).role !== "assistant") break;
    const text = extractAssistantMessageText(m as Record<string, unknown>);
    if (text) return text;
  }
  return "";
}

/**
 * Cheap change-detector for one transcript read: role and visible-text
 * length of the last entry, plus the entry count. Two reads that produce the
 * same key mean the transcript did not advance between them.
 */
export function transcriptSnapshotKey(messages: unknown[]): string {
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") return `empty:${messages.length}`;
  const role = (last as Record<string, unknown>).role;
  const roleLabel = typeof role === "string" ? role : "?";
  return `${roleLabel}:${extractAssistantMessageText(last as Record<string, unknown>).length}:${messages.length}`;
}

/**
 * What upstream truth says about a run whose live stream has gone quiet.
 * Deliberately an observation, not a verdict: the caller (SessionManager)
 * owns the bounded policy that turns repeated observations into a terminal
 * job status.
 */
export type RunObservation = {
  /** True when at least two transcript reads succeeded — enough to judge. */
  ok: boolean;
  /** True when the transcript advanced between reads: the run is still producing. */
  changed: boolean;
  /** Visible trailing-assistant text at the last successful read; "" when the trailing entry carries none. */
  trailingText: string;
  /**
   * Liveness only. `active` is positive evidence from openclaw's
   * `sessionInfo.hasActiveRun`/`activeRunIds` that execution is ongoing;
   * everything else is `unknown`.
   *
   * Deliberately one-directional. `hasActiveRun` is a LATCH, not a state:
   * openclaw sets `projectSessionActive` true only at registration
   * (chat-abort.ts) and clears it on ANY lifecycle end/error — including the
   * per-attempt `lifecycle:end` this connector already documents as firing
   * mid-run (see recoverLateFinalText). Re-registration of the same runId is
   * refused, so once cleared a live run is invisible for the rest of its
   * life. Absence therefore proves nothing, and is never read as terminal.
   * Being wrong in the `active` direction only costs a longer wait, which is
   * the pre-existing behavior; being wrong in the terminal direction would
   * abort a live run via the released busy guard.
   */
  upstream: "active" | "unknown";
  /**
   * Snapshot key of the last successful read ("" when none succeeded).
   * Exposed so a caller comparing successive observations can detect
   * progress that happened BETWEEN them — a run that advances one tool round
   * per minute looks stable inside any single observation window.
   */
  snapshotKey: string;
};

/**
 * Read openclaw's run-state flags off a `chat.history` payload.
 *
 * `sessionInfo` carries no typebox schema upstream, so every field is treated
 * as optional and anything unrecognized degrades to "unknown" rather than
 * being guessed at.
 *
 *   our runId listed in activeRunIds → active
 *   hasActiveRun === true            → active (ours may be one it can't name;
 *                                      queued turns, hidden runs and
 *                                      restart-redispatched runs are all
 *                                      absent from activeRunIds by design)
 *   anything else                    → unknown
 */
export function classifyUpstreamRun(
  sessionInfo: unknown,
  runId?: string,
): RunObservation["upstream"] {
  if (!sessionInfo || typeof sessionInfo !== "object") return "unknown";
  const info = sessionInfo as { hasActiveRun?: unknown; activeRunIds?: unknown };
  const ids = Array.isArray(info.activeRunIds)
    ? info.activeRunIds.filter((id): id is string => typeof id === "string")
    : undefined;
  if (runId && ids?.includes(runId)) return "active";
  if (info.hasActiveRun === true) return "active";
  return "unknown";
}

// ── Gateway client ───────────────────────────────────────────────────────────

export class OpenClawGateway {
  private ws: WebSocket | null = null;
  private subscribers = new Map<string, (frame: Frame) => void>();
  /** One entry per in-flight chat run — see notifyStreamClose. */
  private streamCloseListeners = new Set<() => void>();
  /** Resubscribe hooks for connection-scoped session.message subscriptions. */
  private reconnectListeners = new Set<() => void>();
  private transcriptWatches = new Map<string, () => void>();
  private pendingRpcs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionallyClosed = false;

  private static readonly RECONNECT_BASE_MS = 1_000;
  private static readonly RECONNECT_MAX_MS = 30_000;

  constructor(private readonly config: GatewayConfig) {}

  private wsUrl(): string {
    return this.config.url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.intentionallyClosed = false;
    const reconnecting = this.reconnectAttempt > 0;
    this.connectPromise = this._connect().then(
      () => {
        this.reconnectAttempt = 0;
        if (reconnecting) this.notifyReconnect();
      },
      (err) => {
        this.connectPromise = null;
        throw err;
      },
    );
    return this.connectPromise;
  }

  private _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const device = loadOrCreateDevice();
      const ws = new WebSocket(this.wsUrl());
      const connectId = randomUUID();

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("OpenClaw handshake timeout"));
      }, 15_000);

      const onHandshake = (raw: WebSocket.RawData) => {
        let frame: Frame;
        try {
          frame = JSON.parse(raw.toString()) as Frame;
        } catch {
          return;
        }

        if (frame.type === "event" && frame.event === "connect.challenge") {
          const { nonce } = frame.payload as { nonce: string };
          const signedAt = Date.now();
          ws.send(
            JSON.stringify({
              type: "req",
              id: connectId,
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                  id: "gateway-client",
                  version: "internal",
                  platform: "node",
                  mode: "backend",
                },
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.admin"],
                caps: ["tool-events"],
                commands: [],
                permissions: {},
                auth: { password: this.config.token, token: this.config.token },
                device: {
                  id: device.deviceId,
                  publicKey: device.publicKey,
                  signature: signChallenge({
                    privateKey: device.privateKey,
                    deviceId: device.deviceId,
                    signedAt,
                    nonce,
                    token: this.config.token,
                  }),
                  signedAt,
                  nonce,
                },
              },
            }),
          );
          return;
        }

        if (frame.type === "res" && frame.id === connectId) {
          clearTimeout(timeout);
          ws.removeListener("message", onHandshake);
          if (!frame.ok) {
            reject(new Error(`OpenClaw connect rejected: ${JSON.stringify(frame.error)}`));
            ws.terminate();
            return;
          }
          this.ws = ws;
          this.attachHandlers(ws);
          logDebug("[openclaw-gateway] connected");
          resolve();
        }
      };

      ws.on("message", onHandshake);
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      ws.once("close", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket closed during handshake"));
      });
    });
  }

  private attachHandlers(ws: WebSocket) {
    ws.removeAllListeners("message");
    ws.removeAllListeners("close");
    ws.removeAllListeners("error");

    ws.on("error", (err) => console.error("[openclaw-gateway] ws error:", err.message));

    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        return;
      }

      if (frame.type === "res" && frame.id) {
        const rpc = this.pendingRpcs.get(frame.id);
        if (rpc) {
          this.pendingRpcs.delete(frame.id);
          if (frame.ok) rpc.resolve(frame.payload);
          else rpc.reject(new Error(JSON.stringify(frame.error)));
        }
      }

      for (const cb of this.subscribers.values()) {
        try {
          cb(frame);
        } catch {
          // Subscriber errors should not crash the gateway
        }
      }
    });

    ws.on("close", () => {
      logDebug("[openclaw-gateway] disconnected");
      this.ws = null;
      this.connectPromise = null;
      for (const [id, rpc] of this.pendingRpcs) {
        rpc.reject(new Error("Gateway disconnected"));
        this.pendingRpcs.delete(id);
      }
      // In-flight chat runs are NOT rpcs — they settle on an event, not on a
      // response, so nothing above reaches them. Without this, a run whose
      // terminal event was emitted into the now-dead socket waits out the whole
      // observation window before anyone notices.
      this.notifyStreamClose();
      this.scheduleReconnect();
    });
  }

  /**
   * Tells every in-flight run that its transport went away. Listeners decide
   * for themselves whether that is terminal — a reconnect may still deliver a
   * merely-delayed event, which is why this starts a grace period rather than
   * settling anything here.
   */
  private notifyStreamClose(): void {
    // Copied first: a listener settling its run removes itself during iteration.
    for (const listener of Array.from(this.streamCloseListeners)) {
      try {
        listener();
      } catch (err) {
        // A single run's close handling must never break socket teardown for
        // the others, or for the reconnect that follows.
        logDebug("[openclaw-gateway] stream-close listener threw:", err);
      }
    }
  }

  private notifyReconnect(): void {
    for (const listener of Array.from(this.reconnectListeners)) {
      try {
        listener();
      } catch (err) {
        logDebug("[openclaw-gateway] reconnect listener threw:", err);
      }
    }
  }

  private scheduleReconnect() {
    if (this.intentionallyClosed || this.reconnectTimer) return;
    this.reconnectAttempt++;
    const delay = Math.min(
      OpenClawGateway.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1),
      OpenClawGateway.RECONNECT_MAX_MS,
    );
    logDebug(`[openclaw-gateway] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(
        () => logDebug(`[openclaw-gateway] reconnected after ${this.reconnectAttempt} attempt(s)`),
        (err) => {
          // Re-arm. Without this a single failed attempt ended reconnection
          // permanently: the timer is already cleared and no socket remains
          // to fire another `close`, so the client stayed offline until the
          // process restarted. Live logs showed 53 disconnects against 56
          // live-timeout errors, which is that dead end.
          console.error(`[openclaw-gateway] reconnect failed:`, (err as Error).message);
          this.scheduleReconnect();
        },
      );
    }, delay);
  }

  close() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectPromise = null;
    for (const stop of Array.from(this.transcriptWatches.values())) stop();
    this.transcriptWatches.clear();
  }

  private async sendRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected");
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pendingRpcs.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  private async readHistoryAfter(
    sessionKey: string,
    afterSequence: number,
  ): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let offset = 0;
    for (;;) {
      const page = (await this.sendRpc(
        "chat.history",
        { sessionKey, limit: 1_000, offset, maxChars: 500_000 },
        20_000,
      )) as HistoryPage;
      const messages = Array.isArray(page.messages)
        ? page.messages.filter(
            (message): message is Record<string, unknown> =>
              Boolean(message) && typeof message === "object" && !Array.isArray(message),
          )
        : [];
      collected.push(...messages);
      const sequences = messages
        .map((message) => transcriptMessageIdentity(message).sequence)
        .filter((sequence): sequence is number => sequence !== undefined);
      if (
        page.hasMore !== true ||
        typeof page.nextOffset !== "number" ||
        page.nextOffset <= offset ||
        (sequences.length > 0 && Math.min(...sequences) <= afterSequence)
      ) {
        break;
      }
      offset = page.nextOffset;
    }
    return collected.sort((left, right) => {
      const a = transcriptMessageIdentity(left).sequence ?? Number.MAX_SAFE_INTEGER;
      const b = transcriptMessageIdentity(right).sequence ?? Number.MAX_SAFE_INTEGER;
      return a - b;
    });
  }

  /**
   * Start one resumable durable transcript reader for a session. History is
   * read before subscription, then again after subscription to close the
   * history/subscribe race. Reconnects run the same replay/subscribe/catch-up
   * sequence. Stable sequence/message identities make every pass idempotent.
   */
  private async startTranscriptWatch(
    sessionKey: string,
    onEvent: ((entry: GatewayEvent) => void) | undefined,
    onState: ((update: TranscriptTransportUpdate) => void) | undefined,
    resumeAfterSequence?: number,
  ): Promise<() => void> {
    this.stopTranscriptWatch(sessionKey);
    let stopped = false;
    let lastSeenSequence = resumeAfterSequence ?? 0;
    const seenIds = new Set<string>();
    let work = Promise.resolve();
    let unavailableTimer: ReturnType<typeof setTimeout> | undefined;
    const subId = randomUUID();

    const report = (
      upstream: TranscriptTransportUpdate["upstream"],
      transcript: TranscriptTransportUpdate["transcript"],
    ) => onState?.({
      upstream,
      transcript,
      ...(lastSeenSequence > 0 ? { lastSeenSequence } : {}),
    });

    const accept = (message: Record<string, unknown>, payload?: SessionMessagePayload) => {
      const identity = transcriptMessageIdentity(message);
      const sequence = payload?.messageSeq ?? identity.sequence;
      const id = payload?.messageId ?? identity.id ?? transcriptMessageFallbackId(message);
      if (sequence !== undefined && sequence <= lastSeenSequence) return;
      if (id && seenIds.has(id)) return;
      if (id) seenIds.add(id);
      if (sequence !== undefined) lastSeenSequence = Math.max(lastSeenSequence, sequence);
      for (const event of transcriptMessageEvents(message)) onEvent?.(event);
    };

    const replay = async (baseline: boolean) => {
      // A new watch only needs the current high-water mark, not the session's
      // entire lifetime. Resume/gap-fill reads walk older pages until they
      // cross the stored cursor.
      const messages = await this.readHistoryAfter(
        sessionKey,
        baseline ? Number.MAX_SAFE_INTEGER : lastSeenSequence,
      );
      if (baseline) {
        for (const message of messages) {
          const identity = transcriptMessageIdentity(message);
          seenIds.add(identity.id ?? transcriptMessageFallbackId(message));
          if (identity.sequence !== undefined) {
            lastSeenSequence = Math.max(lastSeenSequence, identity.sequence);
          }
        }
        return;
      }
      for (const message of messages) accept(message);
    };

    const recover = async (baseline: boolean) => {
      if (stopped) return;
      if (unavailableTimer) {
        clearTimeout(unavailableTimer);
        unavailableTimer = undefined;
      }
      report(baseline ? "connected" : "reconnecting", "replaying");
      await replay(baseline);
      if (stopped) return;
      await this.sendRpc("sessions.messages.subscribe", { key: sessionKey }, 20_000);
      await replay(false);
      if (stopped) return;
      report("connected", "live");
    };

    const enqueueRecovery = (baseline: boolean) => {
      work = work.then(() => recover(baseline)).catch((err: unknown) => {
        if (stopped) return;
        report("unavailable", "detached");
        logDebug(
          `[openclaw-gateway] transcript recovery failed for ${sessionKey}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return work;
    };

    const onReconnect = () => {
      if (stopped) return;
      void enqueueRecovery(false);
    };
    const onDisconnected = () => {
      if (stopped) return;
      report("reconnecting", "detached");
      unavailableTimer = setTimeout(() => {
        if (!stopped) report("unavailable", "detached");
      }, 60_000);
      unavailableTimer.unref?.();
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (unavailableTimer) clearTimeout(unavailableTimer);
      this.subscribers.delete(subId);
      this.reconnectListeners.delete(onReconnect);
      this.streamCloseListeners.delete(onDisconnected);
      if (this.transcriptWatches.get(sessionKey) === stop) {
        this.transcriptWatches.delete(sessionKey);
      }
    };
    this.transcriptWatches.set(sessionKey, stop);
    this.reconnectListeners.add(onReconnect);
    this.streamCloseListeners.add(onDisconnected);
    this.subscribers.set(subId, (frame) => {
      if (frame.type !== "event" || frame.event !== "session.message") return;
      const payload = frame.payload as SessionMessagePayload;
      if (payload.sessionKey !== sessionKey || !payload.message) return;
      work = work.then(async () => {
        const sequence = payload.messageSeq ?? transcriptMessageIdentity(payload.message!).sequence;
        if (sequence !== undefined && sequence > lastSeenSequence + 1) {
          report("connected", "replaying");
          await replay(false);
        }
        accept(payload.message!, payload);
        report("connected", "live");
      }).catch((err: unknown) => {
        report("unavailable", "detached");
        logDebug("[openclaw-gateway] live transcript gap-fill failed:", err);
      });
    });

    await enqueueRecovery(resumeAfterSequence === undefined);
    return stop;
  }

  resumeTranscript(
    sessionKey: string,
    resumeAfterSequence: number | undefined,
    onEvent: ((entry: GatewayEvent) => void) | undefined,
    onState: ((update: TranscriptTransportUpdate) => void) | undefined,
  ): Promise<void> {
    return this.startTranscriptWatch(sessionKey, onEvent, onState, resumeAfterSequence).then(
      () => undefined,
    );
  }

  stopTranscriptWatch(sessionKey: string): void {
    this.transcriptWatches.get(sessionKey)?.();
  }

  private async sendChatWithRetry(
    sessionKey: string,
    message: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.sendRpc(
          "chat.send",
          { sessionKey, message, idempotencyKey },
          30_000,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable =
          lastError.message === "Gateway disconnected" ||
          lastError.message === "Gateway not connected" ||
          lastError.message.startsWith("RPC timeout: chat.send") ||
          lastError.message.includes("WebSocket closed") ||
          lastError.message.includes("handshake timeout");
        if (!retryable || attempt === 3) throw lastError;
        logDebug(
          `[openclaw-gateway] chat.send acknowledgement lost; retrying the same idempotency key ` +
            `(attempt ${attempt + 1}/3)`,
        );
        try {
          await this.connect();
        } catch {
          // sendRpc reconnects on the next attempt; keep the acknowledgement
          // failure as the retry's authoritative error in the meantime.
        }
      }
    }
    throw lastError ?? new Error("chat.send failed without an error");
  }

  /**
   * Abort the run currently owned by a session. This is deliberately a
   * control-plane RPC rather than a second `chat.send("stop")`: a stop
   * message has its own stream lifecycle and can outlive the connector job
   * that asked for it, which is exactly how recovery-era cancellations used
   * to disappear.
   *
   * Passing the runId scopes the abort to this job. Older gateways accept the
   * session key alone, so the fallback remains available for jobs reloaded
   * from a pre-runId store record.
   */
  async abort(
    sessionKey: string,
    runId?: string,
  ): Promise<{ ok: boolean; aborted: boolean; runIds?: string[] }> {
    const params: Record<string, unknown> = { sessionKey };
    if (runId) params.runId = runId;
    return (await this.sendRpc("chat.abort", params, 15_000)) as {
      ok: boolean;
      aborted: boolean;
      runIds?: string[];
    };
  }

  /**
   * One `chat.history` read, reduced to the two things every caller needs:
   * whether the transcript moved (`snapshotKey`) and what the agent's last
   * visible answer is (`trailingText`). Returns null when the read failed —
   * callers decide whether that's fatal.
   *
   * maxChars is passed explicitly: the gateway otherwise truncates each
   * history message to 8k chars, which would clip the long reports these
   * reads exist to recover.
   */
  private async readTranscriptSample(
    sessionKey: string,
    runId?: string,
  ): Promise<{ snapshotKey: string; trailingText: string; upstream: RunObservation["upstream"] } | null> {
    try {
      const res = (await this.sendRpc(
        "chat.history",
        { sessionKey, limit: 20, maxChars: 200_000 },
        20_000,
      )) as { messages?: unknown; sessionInfo?: unknown };
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      return {
        snapshotKey: transcriptSnapshotKey(messages),
        trailingText: trailingAssistantText(messages),
        upstream: classifyUpstreamRun(res?.sessionInfo, runId),
      };
    } catch (err) {
      logDebug("[openclaw-gateway] transcript read failed:", (err as Error).message);
      return null;
    }
  }

  /**
   * Bounded read of upstream truth for a run whose live event stream has gone
   * quiet. Takes `samples` transcript reads `intervalMs` apart and reports
   * whether the transcript is still advancing and what the trailing assistant
   * text is — nothing more. The live `chat` stream is not consulted: the whole
   * point is that it may have dropped the terminal event.
   *
   * Requires two successful reads before claiming `ok`; a single read can't
   * distinguish "not moving" from "we only looked once".
   */
  async reconcileRun(
    sessionKey: string,
    options: { samples?: number; intervalMs?: number; runId?: string } = {},
  ): Promise<RunObservation> {
    const samples = Math.max(2, options.samples ?? 2);
    const intervalMs = options.intervalMs ?? 15_000;
    let successes = 0;
    let previousKey: string | undefined;
    let changed = false;
    let trailingText = "";
    let snapshotKey = "";
    let upstream: RunObservation["upstream"] = "unknown";
    for (let i = 0; i < samples; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      const sample = await this.readTranscriptSample(sessionKey, options.runId);
      if (!sample) continue;
      successes += 1;
      trailingText = sample.trailingText;
      snapshotKey = sample.snapshotKey;
      // Last successful read wins: a run that went terminal between samples
      // should read as terminal, not be pinned to the earlier "active".
      upstream = sample.upstream;
      if (previousKey !== undefined && sample.snapshotKey !== previousKey) changed = true;
      previousKey = sample.snapshotKey;
    }
    const observation: RunObservation = {
      ok: successes >= 2,
      changed,
      trailingText,
      snapshotKey,
      upstream,
    };
    logDebug(
      `[openclaw-gateway] reconcile ${sessionKey.slice(-12)}: reads=${successes}/${samples} ` +
        `ok=${observation.ok} changed=${observation.changed} upstream=${observation.upstream} ` +
        `trailingLen=${observation.trailingText.length}`,
    );
    return observation;
  }

  /**
   * Fallback for when the live chat stream produces no final text: read the
   * persisted session transcript via `chat.history` and return the most recent
   * assistant message's visible text. Returns "" if nothing usable is found or
   * the RPC fails — callers treat that as "no response collected".
   *
   * This exists because the gateway synthesizes the terminal `chat` event
   * purely from its in-memory streaming buffer, which can be cleared mid-run by
   * a compaction-triggered lifecycle error (SFR-247). The transcript is the
   * durable source of truth.
   *
   * The terminal `chat` event can arrive before the runner has flushed the
   * final assistant message to the persisted transcript, so we poll
   * `chat.history` a few times with backoff rather than reading once.
   */
  private async fetchTranscriptFinalText(sessionKey: string): Promise<string> {
    return this.pollTranscriptForFinalText(sessionKey, {
      attempts: 8,
      intervalMs: 700,
      // Require 2 consecutive polls with the same transcript tail before
      // accepting a text. Catches the immediate post-emit write-race (where
      // the transcript settles within ~1s of chat:final) without returning
      // a transient line from a still-growing transcript.
      stableThreshold: 2,
    });
  }

  /**
   * Public version of the transcript fallback, parameterized for use as a
   * background long-poll. Repeatedly calls `chat.history` and scans the
   * trailing run of assistant messages; returns the first non-empty text
   * found, or "" if nothing lands before the attempts run out.
   *
   * Used by SessionManager to keep a `completed_no_summary` job in `running`
   * state for several minutes while watching for a late-arriving final
   * assistant message. On multi-attempt/compaction-heavy runs, the agent's
   * real final answer can land minutes after the first lifecycle:end fires
   * (per-attempt boundary, not run boundary) — this poll outlasts the wait.
   */
  async pollTranscriptForFinalText(
    sessionKey: string,
    options: {
      attempts?: number;
      intervalMs: number;
      shouldAbort?: () => boolean;
      /**
       * Number of consecutive polls where the transcript's last entry must be
       * unchanged before we accept the current trailing-assistant text as
       * final. Defaults to 1 (no stability check) for short inline use; the
       * SessionManager long-poll caller passes a higher value.
       */
      stableThreshold?: number;
      /**
       * If set, the poll exits early when the transcript has been idle (no
       * snapshot change) for this long even though stability hasn't formally
       * settled. Catches "agent finished without writing visible text and
       * went quiet" — there's nothing to wait for.
       */
      idleTimeoutMs?: number;
      /**
       * Absolute safety cap. The poll always exits after this much wall time
       * regardless of activity. Defaults to Infinity when `attempts` is also
       * unset (keep going while the run is actively writing).
       */
      hardCapMs?: number;
      /**
       * Correlation key for the liveness classification reported through
       * `onSample`. Optional and only ever sharpens the answer: with it, our
       * own run appearing in `activeRunIds` is positive evidence; without it,
       * only the session-wide `hasActiveRun` flag is. See classifyUpstreamRun.
       */
      runId?: string;
      /**
       * Called once per SUCCESSFUL transcript read, with what that read said
       * about whether the run is still executing. Every read already computes
       * this (`readTranscriptSample` classifies `sessionInfo` on every call);
       * without a way out it was simply discarded, and a caller deciding
       * whether to stop watching had nothing but stillness to go on.
       *
       * Reporting it rather than acting on it is deliberate: this poll stays an
       * observer with fixed exits, and the policy question — "is absence
       * allowed to end a turn?" — stays with SessionManager, which is where the
       * identical question is already answered for the quiet watchdog (see
       * reconcileQuietRun's "absence is never a verdict").
       */
      onSample?: (sample: {
        checkedAt: number;
        upstream: RunObservation["upstream"];
        /** The transcript advanced since the previous successful read. False on the first read — nothing to compare against yet. */
        changed: boolean;
      }) => void;
    },
  ): Promise<string> {
    const stableThreshold = Math.max(1, options.stableThreshold ?? 1);
    const hardCapMs =
      options.hardCapMs ?? (options.attempts ? options.attempts * options.intervalMs : Infinity);
    const idleTimeoutMs = options.idleTimeoutMs ?? Infinity;
    const maxAttempts = options.attempts ?? Number.POSITIVE_INFINITY;
    // SFR-247 diag — remove after the immediate-exit bug is understood.
    const diagId = `${sessionKey.slice(-12)}/${Date.now().toString(36).slice(-5)}`;
    logDebug(
      `[poll ${diagId}] enter attempts=${options.attempts ?? "∞"} interval=${options.intervalMs}ms ` +
        `stable=${stableThreshold} idle=${idleTimeoutMs === Infinity ? "∞" : `${idleTimeoutMs / 1000}s`} ` +
        `hardCap=${hardCapMs === Infinity ? "∞" : `${hardCapMs / 1000}s`} ` +
        `hasShouldAbort=${typeof options.shouldAbort === "function"}`,
    );
    // Trailing-assistant text only counts if observed against a transcript
    // whose last entry stayed identical for `stableThreshold` consecutive
    // polls. Returning on the FIRST non-empty trailing-assistant text is
    // unsafe: a run can flash a short status line ("I'm tracing the live
    // wiring now…") early, keep working for minutes, and never come back to
    // the trailing-assistant slot. Stability detection waits for the
    // transcript to actually stop growing before deciding.
    let stableTrailingText = "";
    let lastSnapshotKey = "";
    let stableCount = 0;
    const startedAt = Date.now();
    // Most recent moment the transcript's last entry changed. Used to gate
    // `idleTimeoutMs`: even if stability hasn't formally hit, give up after
    // this long without activity so a quiet/abandoned session doesn't pin
    // the job in `running` forever.
    let lastChangeAt = Date.now();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.shouldAbort?.()) {
        logDebug(
          `[poll ${diagId}] exit: shouldAbort=true at attempt=${attempt} elapsed=${Date.now() - startedAt}ms`,
        );
        return stableTrailingText;
      }
      if (Date.now() - startedAt >= hardCapMs) {
        logDebug(
          `[poll ${diagId}] exit: hardCap at attempt=${attempt} elapsed=${Date.now() - startedAt}ms`,
        );
        return stableTrailingText;
      }
      if (Date.now() - lastChangeAt >= idleTimeoutMs) {
        logDebug(
          `[poll ${diagId}] exit: idle at attempt=${attempt} elapsedSinceChange=${Date.now() - lastChangeAt}ms`,
        );
        return stableTrailingText;
      }
      if (attempt > 0) await new Promise((r) => setTimeout(r, options.intervalMs));
      if (options.shouldAbort?.()) {
        logDebug(`[poll ${diagId}] exit: shouldAbort=true after sleep at attempt=${attempt}`);
        return stableTrailingText;
      }
      const sample = await this.readTranscriptSample(sessionKey, options.runId);
      if (!sample) continue;
      const { snapshotKey, trailingText: currentTrailingText } = sample;
      // Before any exit decision below: a read that succeeded is evidence
      // about the run, and the caller needs it even on the polls that decide
      // nothing — that is what makes "still executing" visible during a long
      // still stretch rather than only in hindsight.
      options.onSample?.({
        checkedAt: Date.now(),
        upstream: sample.upstream,
        changed: lastSnapshotKey !== "" && snapshotKey !== lastSnapshotKey,
      });
      logDebug(
        `[poll ${diagId}] attempt=${attempt} snapshotKey=${snapshotKey} ` +
          `trailingLen=${currentTrailingText.length} stableCount=${stableCount} ` +
          `prevKey=${lastSnapshotKey || "(empty)"}`,
      );
      if (snapshotKey === lastSnapshotKey) {
        stableCount += 1;
        // Stability is only a valid "run is done" signal when the trailing
        // entry actually has visible assistant text. A stable toolResult /
        // thinking-only trailing entry just means the agent is between
        // tool rounds, doing a model_call — which can take 30+ seconds
        // even on healthy runs. Returning empty here would mark a still-
        // active run as completed_no_summary.
        //
        // Keep polling on stable-but-empty; the idle-timeout (`idleTimeoutMs`,
        // typically minutes) is the right signal that the agent has gone
        // silent without ever writing a visible answer.
        if (stableCount >= stableThreshold && currentTrailingText.length > 0) {
          stableTrailingText = currentTrailingText;
          logDebug(
            `[poll ${diagId}] exit: stable+text after ${stableCount} polls, text=${stableTrailingText.length} chars`,
          );
          return stableTrailingText;
        }
      } else {
        stableCount = 1;
        lastSnapshotKey = snapshotKey;
        // Transcript moved — the run is genuinely active. Reset the idle
        // clock so we don't give up while it's still producing.
        lastChangeAt = Date.now();
      }
    }
    // Timeout exhausted without observing stability. Return whatever we last
    // accepted under a stable snapshot (or "" if we never reached stability).
    // Better to return empty than to return a transient mid-run status line
    // and convince the caller the run finished when it didn't.
    return stableTrailingText;
  }

  /**
   * Send a message to a session and wait for the final response.
   * Returns the text of the assistant reply.
   *
   * Subscribes BEFORE `chat.send` and correlates afterwards. openclaw starts
   * emitting the run's `agent`/`chat` events the moment it accepts the send,
   * which can be before the send's response — carrying the runId — gets back
   * to us; several frames can also arrive in a single socket read and be
   * dispatched synchronously ahead of any continuation. Registering the
   * listeners after the send therefore drops whatever landed in that window,
   * and a dropped terminal `chat` event leaves this promise hanging until
   * `timeoutMs` — which is what pins a finished job in `running`. Everything
   * seen before the runId is known is buffered and replayed against it.
   */
  async chat(
    sessionKey: string,
    message: string,
    timeoutMs: number,
    onEvent?: (entry: GatewayEvent) => void,
    onRunId?: (runId: string) => void,
    onTranscriptState?: (update: TranscriptTransportUpdate) => void,
  ): Promise<string> {
    try {
      await this.connect();
    } catch (err) {
      throw new Error(
        `OpenClaw gateway unavailable at task startup: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const stopThisTranscriptWatch = await this.startTranscriptWatch(
      sessionKey,
      onEvent,
      onTranscriptState,
    );

    const idempotencyKey = randomUUID();

    return new Promise<string>((resolve, reject) => {
      const subId = randomUUID();
      const agentSubId = randomUUID();
      let runId: string | undefined;
      const bufferedFrames: Frame[] = [];
      // Diagnostics for the two ways a pre-runId frame can be discarded.
      // Reported with the replay so a run that lost events is explainable
      // from the log rather than by inference.
      let droppedForeignChatFrames = 0;
      let evictedFrames = 0;
      let accumulated = "";
      // SFR-message-veto: when the agent calls OpenClaw's generic `message`
      // tool, the body it intended for the caller lives in the tool args and
      // gets routed by openclaw's delivery subsystem to whatever channel the
      // sender resolves to (WhatsApp, internal-ui, etc.) — NOT back through
      // `chat:final`. The model's final assistant text in that case is
      // typically a short ack like "Sent the packet inline through chat."
      // Capture the tool-args text here so we can prefer it as the run_task
      // reply, mirroring services/linear-agent/src/linear-stream.ts.
      let messageToolReply = "";
      // Track agent stream events for logs + text fallback
      let agentStreamText = "";

      const extractText = (blocks: Array<{ type: string; text?: string; thinking?: string }>) =>
        blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");

      const timer = setTimeout(() => {
        // Only unsubscribes — nothing here aborts the upstream run, which is
        // why this rejection is typed: the run is very likely still going.
        cleanup(false);
        reject(new ParentObservationTimeoutError(timeoutMs));
      }, timeoutMs);

      /**
       * The settle barrier. Every terminal branch below already calls
       * cleanup() before it resolves or rejects, so marking the run settled
       * here covers all of them without rewiring a single existing exit — and
       * the socket-close door checks it before doing anything.
       */
      let settled = false;
      let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (stopTranscript = true) => {
        settled = true;
        clearTimeout(timer);
        if (closeGraceTimer) clearTimeout(closeGraceTimer);
        this.streamCloseListeners.delete(onStreamClosed);
        this.subscribers.delete(subId);
        this.subscribers.delete(agentSubId);
        if (stopTranscript) stopThisTranscriptWatch();
      };

      /**
       * The socket-close door. A dropped transport is not by itself a verdict
       * on the run: openclaw may still be executing it, and a reconnect can
       * deliver a merely-delayed terminal event. So this opens a grace window
       * rather than settling, and only hands off if nothing arrives.
       *
       * The handoff resolves — it does not reject — with the SENTINEL, which
       * puts the caller on its durable-transcript recovery path. Rejecting
       * would invent a failure for a run that is very likely still going.
       *
       * Deliberately NOT resolved with the text this run happened to be
       * holding. That text is a cumulative `delta` — what the agent had said
       * so far, mid-sentence as often as not — and returning it here would
       * settle the job `completed` with `terminalReason: "live-final"`, i.e.
       * publish a partial as the run's final answer AND skip the recovery that
       * would have produced the real one. Partial text never becomes a turn's
       * result; the transcript is the authority. The held length is logged
       * only so a truncated-looking recovery is explainable.
       */
      const onStreamClosed = () => {
        if (settled || closeGraceTimer) return;
        closeGraceTimer = setTimeout(() => {
          if (settled) return;
          const heldLength = (messageToolReply || accumulated || agentStreamText).length;
          logDebug(
            `[openclaw-gateway] socket closed with no terminal event; handing off to durable ` +
              `recovery after ${STREAM_CLOSE_GRACE_MS}ms grace (${heldLength} chars were held)`,
          );
          cleanup(false);
          resolve(NO_SUMMARY_SENTINEL);
        }, STREAM_CLOSE_GRACE_MS);
        // Never hold the process open for a run nobody is waiting on.
        closeGraceTimer.unref?.();
      };
      this.streamCloseListeners.add(onStreamClosed);

      const handleAgentEvent = (p: {
        runId?: string;
        stream?: string;
        data?: Record<string, unknown>;
      }) => {
        if (p.runId !== runId) return;

        if (p.stream === "assistant" && p.data?.text) {
          agentStreamText = p.data.text as string;
        }

        if (p.stream === "tool" && p.data?.phase === "start") {
          const toolName = (p.data?.name as string) ?? "unknown";
          const args = (p.data?.args as Record<string, unknown>) ?? {};
          // Capture even if no onEvent subscriber — this is for the reply path.
          const captured = extractMessageToolReply(toolName, args);
          if (captured) messageToolReply = captured;
        }

          if (onEvent) {
            if (p.stream === "lifecycle") {
            onEvent({
              type: "lifecycle",
              text: formatLifecycleEventText(p.data?.phase),
            });
            }
          }
      };

      const handleChatEvent = (payload: ChatEventPayload) => {
        if (payload.runId !== runId) return;

        if (payload.state === "delta") {
          const text = extractText(payload.message?.content ?? []);
          if (text) accumulated = text; // each delta is cumulative, not incremental
        } else if (payload.state === "final") {
          const blocks = payload.message?.content ?? [];
          logDebug(
            "[openclaw-gateway] final blocks:",
            JSON.stringify(
              blocks.map((b) => ({ type: b.type, len: (b.text ?? b.thinking ?? "").length })),
            ),
          );
          // prefer `message` tool args → full final message text → last chat
          // delta → agent stream text. The tool-args path wins because when
          // the agent used the `message` tool, the model's own final assistant
          // text is typically a short ack ("Sent the packet inline through
          // chat.") and the real body lives in the tool args.
          const liveText = extractText(blocks) || accumulated || agentStreamText;
          if (messageToolReply) {
            cleanup();
            logDebug(
              `[openclaw-gateway] preferring captured \`message\` tool reply ` +
                `(${messageToolReply.length} chars) over live final text (${liveText.length} chars)`,
            );
            resolve(messageToolReply);
          } else if (liveText) {
            cleanup();
            resolve(liveText);
          } else {
            // The live stream yielded no final text. On long / compaction-heavy
            // runs the gateway's chat buffer can be wiped mid-run by a
            // compaction-triggered lifecycle error, so the real final response
            // exists only in the persisted transcript (SFR-247). Read it back
            // before falling through to the generic "no response" sentinel.
            logDebug("[openclaw-gateway] no live final text — trying transcript fallback");
            cleanup(false);
            this.fetchTranscriptFinalText(sessionKey).then(
              (transcriptText) =>
                resolve(transcriptText || NO_SUMMARY_SENTINEL),
              () => resolve(NO_SUMMARY_SENTINEL),
            );
          }
        } else if (payload.state === "aborted") {
          cleanup();
          reject(new Error("OpenClaw task aborted"));
        } else if (payload.state === "error") {
          cleanup();
          reject(new Error(payload.errorMessage ?? "OpenClaw task error"));
        }
      };

      const dispatch = (frame: Frame) => {
        if (frame.event === "agent") {
          handleAgentEvent(frame.payload as { runId?: string; stream?: string; data?: Record<string, unknown> });
        } else if (frame.event === "chat") {
          handleChatEvent(frame.payload as ChatEventPayload);
        }
      };

      // Before the runId is known there is nothing to correlate on, so hold
      // the frames instead of discarding them. The buffer is fed by ALL
      // socket traffic, including other sessions' busy runs, so it is
      // narrowed twice:
      //
      //   1. `chat` events carry a sessionKey — another session's are
      //      dropped on arrival and never compete for space.
      //   2. At the cap, the victim is the oldest `agent` frame, never a
      //      `chat` frame. Agent frames are progress chatter (at worst a
      //      missing log line); every buffered chat frame belongs to this
      //      session and could be the terminal event this call exists to
      //      receive. A flood of agent frames must not be able to evict it.
      const buffer = (frame: Frame) => {
        if (frame.event === "chat") {
          const frameSessionKey = (frame.payload as { sessionKey?: string } | undefined)?.sessionKey;
          if (typeof frameSessionKey === "string" && frameSessionKey !== sessionKey) {
            droppedForeignChatFrames += 1;
            if (droppedForeignChatFrames === 1) {
              logDebug(
                `[openclaw-gateway] dropping pre-runId chat frames for other sessions ` +
                  `(first: ${frameSessionKey}) while awaiting the send for ${sessionKey}`,
              );
            }
            return;
          }
        }
        bufferedFrames.push(frame);
        if (bufferedFrames.length <= MAX_PRE_RUNID_FRAMES) return;
        // Oldest agent frame if there is one; otherwise the buffer is all
        // this session's chat frames and the oldest is the least likely to
        // be terminal.
        const agentIndex = bufferedFrames.findIndex((f) => f.event === "agent");
        bufferedFrames.splice(agentIndex >= 0 ? agentIndex : 0, 1);
        evictedFrames += 1;
      };

      this.subscribers.set(agentSubId, (frame) => {
        if (frame.type !== "event" || frame.event !== "agent") return;
        if (runId === undefined) {
          buffer(frame);
          return;
        }
        handleAgentEvent(frame.payload as { runId?: string; stream?: string; data?: Record<string, unknown> });
      });

      this.subscribers.set(subId, (frame) => {
        if (frame.type !== "event" || frame.event !== "chat") return;
        if (runId === undefined) {
          buffer(frame);
          return;
        }
        handleChatEvent(frame.payload as ChatEventPayload);
      });

      this.sendChatWithRetry(sessionKey, message, idempotencyKey).then(
        (sendResult) => {
          const id = (sendResult as { runId?: string } | undefined)?.runId;
          if (!id) {
            cleanup();
            reject(new Error("chat.send did not return a runId"));
            return;
          }
          runId = id;
          // Hand the correlation key to the caller before replaying anything,
          // so a reconciliation racing this dispatch can already name the run.
          onRunId?.(id);
          // splice before dispatching: a buffered `final` runs cleanup and
          // resolves, and nothing should be left queued behind it.
          const replay = bufferedFrames.splice(0);
          if (replay.length > 0 || droppedForeignChatFrames > 0 || evictedFrames > 0) {
            logDebug(
              `[openclaw-gateway] replaying ${replay.length} frame(s) that arrived before runId ${id} ` +
                `(dropped ${droppedForeignChatFrames} foreign-session chat frame(s), ` +
                `evicted ${evictedFrames} over-cap frame(s))`,
            );
          }
          for (const frame of replay) dispatch(frame);
        },
        (err: Error) => {
          cleanup();
          reject(err);
        },
      );
    });
  }
}
