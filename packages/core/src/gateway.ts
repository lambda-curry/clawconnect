import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { GatewayConfig, GatewayEvent } from "./types.ts";

function logDebug(message: string, ...args: unknown[]): void {
  console.error(message, ...args);
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
  return { version: 1, deviceId, publicKey: toBase64url(pubBytes), privateKey: toBase64url(privBytes) };
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

interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: { content: Array<{ type: string; text?: string; thinking?: string }> };
  errorMessage?: string;
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

// ── Gateway client ───────────────────────────────────────────────────────────

export class OpenClawGateway {
  private ws: WebSocket | null = null;
  private subscribers = new Map<string, (frame: Frame) => void>();
  private pendingRpcs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
    this.connectPromise = this._connect().then(
      () => {
        this.reconnectAttempt = 0;
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
                client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
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
      this.scheduleReconnect();
    });
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
        (err) => console.error(`[openclaw-gateway] reconnect failed:`, (err as Error).message),
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
  }

  private async sendRpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
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
    },
  ): Promise<string> {
    const stableThreshold = Math.max(1, options.stableThreshold ?? 1);
    const hardCapMs = options.hardCapMs ?? (options.attempts ? options.attempts * options.intervalMs : Infinity);
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
        logDebug(`[poll ${diagId}] exit: shouldAbort=true at attempt=${attempt} elapsed=${Date.now() - startedAt}ms`);
        return stableTrailingText;
      }
      if (Date.now() - startedAt >= hardCapMs) {
        logDebug(`[poll ${diagId}] exit: hardCap at attempt=${attempt} elapsed=${Date.now() - startedAt}ms`);
        return stableTrailingText;
      }
      if (Date.now() - lastChangeAt >= idleTimeoutMs) {
        logDebug(`[poll ${diagId}] exit: idle at attempt=${attempt} elapsedSinceChange=${Date.now() - lastChangeAt}ms`);
        return stableTrailingText;
      }
      if (attempt > 0) await new Promise((r) => setTimeout(r, options.intervalMs));
      if (options.shouldAbort?.()) {
        logDebug(`[poll ${diagId}] exit: shouldAbort=true after sleep at attempt=${attempt}`);
        return stableTrailingText;
      }
      try {
        // maxChars is passed explicitly: the gateway otherwise truncates each
        // history message to 8k chars, which would clip the long reports this
        // fallback exists to recover.
        const res = (await this.sendRpc(
          "chat.history",
          { sessionKey, limit: 20, maxChars: 200_000 },
          20_000,
        )) as { messages?: unknown };
        const messages = Array.isArray(res?.messages) ? res.messages : [];
        // Trailing-assistant scan, newest-first. Skip assistant messages with
        // no visible text (thinking-only / tool-only turns) — they don't
        // contain the report — but DO stop at the first non-assistant entry.
        // The agent's final visible answer is the last assistant text after
        // the last tool round; walking past a toolResult into older preamble
        // would return stale content.
        let currentTrailingText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m || typeof m !== "object" || (m as Record<string, unknown>).role !== "assistant") {
            break;
          }
          const text = extractAssistantMessageText(m as Record<string, unknown>);
          if (text) {
            currentTrailingText = text;
            break;
          }
        }
        const lastMsg = messages[messages.length - 1];
        const snapshotKey =
          lastMsg && typeof lastMsg === "object"
            ? `${(lastMsg as Record<string, unknown>).role ?? "?"}:${
                extractAssistantMessageText(lastMsg as Record<string, unknown>).length
              }:${messages.length}`
            : `empty:${messages.length}`;
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
      } catch (err) {
        logDebug("[openclaw-gateway] transcript fallback attempt failed:", (err as Error).message);
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
   */
  async chat(
    sessionKey: string,
    message: string,
    timeoutMs: number,
    onEvent?: (entry: GatewayEvent) => void,
  ): Promise<string> {
    await this.connect();

    const idempotencyKey = randomUUID();

    const sendResult = (await this.sendRpc("chat.send", { sessionKey, message, idempotencyKey }, 30_000)) as {
      runId?: string;
    };
    const runId = sendResult?.runId;
    if (!runId) throw new Error("chat.send did not return a runId");

    return new Promise<string>((resolve, reject) => {
      const subId = randomUUID();
      let accumulated = "";

      const extractText = (blocks: Array<{ type: string; text?: string; thinking?: string }>) =>
        blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");

      const timer = setTimeout(() => {
        this.subscribers.delete(subId);
        this.subscribers.delete(agentSubId);
        reject(new Error("OpenClaw task timed out"));
      }, timeoutMs);

      // Track agent stream events for logs + text fallback
      let agentStreamText = "";
      const agentSubId = randomUUID();
      this.subscribers.set(agentSubId, (frame) => {
        if (frame.type !== "event" || frame.event !== "agent") return;
        const p = frame.payload as { runId?: string; stream?: string; data?: Record<string, unknown> };
        if (p.runId !== runId) return;

        if (p.stream === "assistant" && p.data?.text) {
          agentStreamText = p.data.text as string;
        }

        if (onEvent) {
          if (p.stream === "lifecycle") {
            const phase = p.data?.phase as string;
            onEvent({ type: "lifecycle", text: phase === "start" ? "Agent started" : "Agent finished" });
          } else if (p.stream === "tool" && p.data?.phase === "start") {
            const toolName = (p.data?.name as string) ?? "unknown";
            const args = (p.data?.args as Record<string, unknown>) ?? {};
            const summary = args.command ?? args.file_path ?? args.pattern ?? args.query ?? "";
            onEvent({ type: "tool", text: `${toolName}: ${String(summary).slice(0, 80)}`, toolName, args });
          } else if (p.stream === "tool" && p.data?.phase === "result") {
            const toolName = (p.data?.name as string) ?? "unknown";
            const isError = p.data?.isError as boolean;
            onEvent({ type: "tool-result", text: `${toolName} ${isError ? "failed" : "done"}`, toolName, isError });
          }
        }
      });

      this.subscribers.set(subId, (frame) => {
        if (frame.type !== "event" || frame.event !== "chat") return;
        const payload = frame.payload as ChatEventPayload;
        if (payload.runId !== runId) return;

        if (payload.state === "delta") {
          const text = extractText(payload.message?.content ?? []);
          if (text) accumulated = text; // each delta is cumulative, not incremental
        } else if (payload.state === "final") {
          clearTimeout(timer);
          this.subscribers.delete(subId);
          this.subscribers.delete(agentSubId);
          const blocks = payload.message?.content ?? [];
          logDebug(
            "[openclaw-gateway] final blocks:",
            JSON.stringify(blocks.map((b) => ({ type: b.type, len: (b.text ?? b.thinking ?? "").length }))),
          );
          // prefer full final message text → last chat delta → agent stream text
          const liveText = extractText(blocks) || accumulated || agentStreamText;
          if (liveText) {
            resolve(liveText);
          } else {
            // The live stream yielded no final text. On long / compaction-heavy
            // runs the gateway's chat buffer can be wiped mid-run by a
            // compaction-triggered lifecycle error, so the real final response
            // exists only in the persisted transcript (SFR-247). Read it back
            // before falling through to the generic "no response" sentinel.
            logDebug("[openclaw-gateway] no live final text — trying transcript fallback");
            this.fetchTranscriptFinalText(sessionKey).then(
              (transcriptText) =>
                resolve(transcriptText || "Stream finished with no response collected."),
              () => resolve("Stream finished with no response collected."),
            );
          }
        } else if (payload.state === "aborted") {
          clearTimeout(timer);
          this.subscribers.delete(subId);
          this.subscribers.delete(agentSubId);
          reject(new Error("OpenClaw task aborted"));
        } else if (payload.state === "error") {
          clearTimeout(timer);
          this.subscribers.delete(subId);
          this.subscribers.delete(agentSubId);
          reject(new Error(payload.errorMessage ?? "OpenClaw task error"));
        }
      });
    });
  }
}
