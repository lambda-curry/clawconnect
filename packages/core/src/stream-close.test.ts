import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

/**
 * The socket-close door on OpenClawGateway.chat().
 *
 * chat() only ever settled on a terminal `chat` event, so when the websocket
 * dropped mid-run the terminal event was emitted into a dead socket and simply
 * never observed. The run then sat for the FULL observation window — 30 minutes
 * in production — before rejecting, while a caller polled a task that looked
 * stuck. Recovery did eventually re-derive the answer from the durable
 * transcript, so nothing was lost; what was lost was half an hour.
 *
 * These tests pin the difference. `timeoutMs` is set far above the grace window
 * so a run that settles from the close path can be told apart from one that
 * merely timed out: if the close door regresses, the assertions do not go
 * green late — they hang past the grace and fail.
 *
 * Same in-process WebSocket-server fixture as gateway-chat.test.ts: a socket
 * genuinely closing is the entire subject here, and no mocked gateway can
 * express it. HOME is redirected before the import for the same reason that
 * file does it — gateway.ts resolves its device-identity file at module load.
 */
process.env.HOME = mkdtempSync(join(tmpdir(), "clawconnect-stream-close-"));
process.env.CLAWCONNECT_STREAM_CLOSE_GRACE_MS = "150";
const { OpenClawGateway } = await import("./gateway.ts");
const { NO_SUMMARY_SENTINEL } = await import("./types.ts");

/** Far above the grace window, so "settled from close" and "timed out" are distinguishable. */
const OBSERVATION_WINDOW_MS = 30_000;

type RequestFrame = { id?: string; method?: string; params?: Record<string, unknown> };
type RequestHandler = (frame: RequestFrame, socket: ServerSocket) => void;

async function startFakeGateway(onRequest: RequestHandler) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }));
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as RequestFrame;
      if (frame.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }));
        return;
      }
      onRequest(frame, socket);
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    /** Drop every live connection without a terminal event — the failure this file is about. */
    dropConnections: () => wss.clients.forEach((c) => c.terminate()),
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => resolve());
      }),
  };
}

const SESSION_KEY = "agent:main:main:thread:test";

const chatEvent = (runId: string, state: string, text?: string) =>
  JSON.stringify({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      state,
      ...(text === undefined ? {} : { message: { content: [{ type: "text", text }] } }),
    },
  });

const sendAck = (id: string | undefined, runId: string) =>
  JSON.stringify({ type: "res", id, ok: true, payload: { runId } });

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function harness(onRequest: RequestHandler) {
  const server = await startFakeGateway(onRequest);
  const gateway = new OpenClawGateway({ url: server.url, token: "test-token" });
  cleanup.push(async () => {
    gateway.close();
    await server.close();
  });
  return { gateway, server };
}

describe("OpenClawGateway.chat — the socket-close door", () => {
  it("settles from a mid-run socket close instead of waiting out the observation window", async () => {
    const { gateway, server } = await harness((frame, socket) => {
      if (frame.method === "chat.send") {
        socket.send(sendAck(frame.id, "run-1"));
        // Deliberately no terminal event: this run's terminal event is the one
        // that gets emitted into a dead socket in production.
        setTimeout(() => server.dropConnections(), 20);
      }
    });

    const startedAt = Date.now();
    const reply = await gateway.chat(SESSION_KEY, "do the thing", OBSERVATION_WINDOW_MS);
    const elapsed = Date.now() - startedAt;

    // Handed off to the caller's durable recovery rather than held hostage.
    expect(reply).toBe(NO_SUMMARY_SENTINEL);
    // The point of the fix: nowhere near the observation window.
    expect(elapsed).toBeLessThan(OBSERVATION_WINDOW_MS / 2);
  });

  it("never publishes a partial delta as the run's answer", async () => {
    const { gateway, server } = await harness((frame, socket) => {
      if (frame.method === "chat.send") {
        socket.send(sendAck(frame.id, "run-2"));
        // A cumulative delta — what the agent had said *so far* when the
        // transport died, mid-sentence as often as not. `delta` is the state
        // openclaw actually streams text in.
        socket.send(chatEvent("run-2", "delta", "partial answer so f"));
        setTimeout(() => server.dropConnections(), 20);
      }
    });

    const reply = await gateway.chat(SESSION_KEY, "do the thing", OBSERVATION_WINDOW_MS);

    // Returning the partial would settle the job `completed` with
    // terminalReason "live-final" — publishing a half-sentence as the final
    // answer AND skipping the recovery that would produce the real one.
    expect(reply).not.toContain("partial answer");
    expect(reply).toBe(NO_SUMMARY_SENTINEL);
  });

  it("does not disturb a run that already settled — close after terminal is a no-op", async () => {
    const { gateway, server } = await harness((frame, socket) => {
      if (frame.method === "chat.send") {
        socket.send(sendAck(frame.id, "run-3"));
        socket.send(chatEvent("run-3", "final", "the real answer"));
        // Close AFTER the terminal event. The settle barrier must ignore it:
        // a second settle would either overwrite the answer or throw.
        setTimeout(() => server.dropConnections(), 20);
      }
    });

    const reply = await gateway.chat(SESSION_KEY, "do the thing", OBSERVATION_WINDOW_MS);
    expect(reply).toBe("the real answer");

    // Give the close handler time to fire against an already-settled run.
    await new Promise((r) => setTimeout(r, 250));
    expect(reply).toBe("the real answer");
  });
});
