import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { GatewayEvent, TranscriptTransportUpdate } from "./types.ts";

process.env.HOME = mkdtempSync(join(tmpdir(), "clawconnect-transcript-recovery-"));
const { OpenClawGateway } = await import("./gateway.ts");

const SESSION_KEY = "agent:main:main:thread:recovery-test";
type RequestFrame = { id?: string; method?: string; params?: Record<string, unknown> };

function toolMessage(sequence: number, name: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${sequence}`, name, arguments: { command: `step ${sequence}` } }],
    __openclaw: { id: `message-${sequence}`, seq: sequence },
  };
}

function sessionMessage(sequence: number, name: string) {
  return JSON.stringify({
    type: "event",
    event: "session.message",
    payload: {
      sessionKey: SESSION_KEY,
      messageId: `message-${sequence}`,
      messageSeq: sequence,
      message: toolMessage(sequence, name),
    },
  });
}

function response(id: string | undefined, payload: unknown) {
  return JSON.stringify({ type: "res", id, ok: true, payload });
}

function finalEvent(runId: string, text: string) {
  return JSON.stringify({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      state: "final",
      message: { content: [{ type: "text", text }] },
    },
  });
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup) await close();
  cleanup = [];
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

describe("OpenClawGateway resumable transcript", () => {
  it("fails startup with an explicit gateway-unavailable error", async () => {
    const reservation = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(reservation, "listening");
    const { port } = reservation.address() as AddressInfo;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const gateway = new OpenClawGateway({ url: `ws://127.0.0.1:${port}`, token: "test-token" });
    cleanup.push(async () => gateway.close());

    await expect(gateway.chat(SESSION_KEY, "do the thing", 5_000)).rejects.toThrow(
      /gateway unavailable at task startup/i,
    );
  });

  it("replays and deduplicates durable tool events before restoring the live subscription", async () => {
    const history: Record<string, unknown>[] = [];
    let connectionNumber = 0;
    let reconnectHistoryReads = 0;
    let subscribeCount = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    wss.on("connection", (socket) => {
      connectionNumber += 1;
      const thisConnection = connectionNumber;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test" } }));
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as RequestFrame;
        if (frame.method === "connect") {
          socket.send(response(frame.id, { protocol: 4 }));
          return;
        }
        if (frame.method === "chat.history") {
          if (thisConnection > 1) reconnectHistoryReads += 1;
          socket.send(response(frame.id, { messages: history, hasMore: false }));
          if (thisConnection > 1 && reconnectHistoryReads === 2) {
            history.push(toolMessage(4, "Write"));
            setTimeout(() => {
              socket.send(sessionMessage(4, "Write"));
              socket.send(finalEvent("run-recover", "completed on the original run"));
            }, 10);
          }
          return;
        }
        if (frame.method === "sessions.messages.subscribe") {
          subscribeCount += 1;
          socket.send(response(frame.id, { ok: true }));
          return;
        }
        if (frame.method === "chat.send") {
          socket.send(response(frame.id, { runId: "run-recover" }));
          history.push(toolMessage(1, "Read"));
          socket.send(sessionMessage(1, "Read"));
          setTimeout(() => {
            history.push(toolMessage(2, "Bash"), toolMessage(3, "Edit"));
            socket.terminate();
          }, 20);
        }
      });
    });

    const { port } = wss.address() as AddressInfo;
    const gateway = new OpenClawGateway({ url: `ws://127.0.0.1:${port}`, token: "test-token" });
    cleanup.push(async () => {
      gateway.close();
      wss.clients.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    const events: GatewayEvent[] = [];
    const states: TranscriptTransportUpdate[] = [];
    const reply = await gateway.chat(
      SESSION_KEY,
      "do the thing",
      20_000,
      (event) => events.push(event),
      undefined,
      (state) => states.push(state),
    );

    expect(reply).toBe("completed on the original run");
    expect(events.filter((event) => event.type === "tool").map((event) => event.toolName)).toEqual([
      "Read",
      "Bash",
      "Edit",
      "Write",
    ]);
    expect(subscribeCount).toBe(2);
    expect(states).toContainEqual(expect.objectContaining({ upstream: "reconnecting", transcript: "detached" }));
    expect(states).toContainEqual(expect.objectContaining({ upstream: "reconnecting", transcript: "replaying" }));
    expect(states.at(-1)).toMatchObject({ upstream: "connected", transcript: "live", lastSeenSequence: 4 });
  }, 20_000);

  it("retries a lost chat.send acknowledgement with the same idempotency key", async () => {
    const keys: string[] = [];
    let connectionNumber = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    wss.on("connection", (socket) => {
      connectionNumber += 1;
      const thisConnection = connectionNumber;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test" } }));
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as RequestFrame;
        if (frame.method === "connect") {
          socket.send(response(frame.id, { protocol: 4 }));
        } else if (frame.method === "chat.history") {
          socket.send(response(frame.id, { messages: [], hasMore: false }));
        } else if (frame.method === "sessions.messages.subscribe") {
          socket.send(response(frame.id, { ok: true }));
        } else if (frame.method === "chat.send") {
          keys.push(String(frame.params?.idempotencyKey));
          if (thisConnection === 1) {
            socket.terminate();
          } else {
            socket.send(response(frame.id, { runId: "one-logical-run" }));
            setTimeout(() => socket.send(finalEvent("one-logical-run", "recovered send")), 10);
          }
        }
      });
    });
    const { port } = wss.address() as AddressInfo;
    const gateway = new OpenClawGateway({ url: `ws://127.0.0.1:${port}`, token: "test-token" });
    cleanup.push(async () => {
      gateway.close();
      wss.clients.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    await expect(gateway.chat(SESSION_KEY, "do the thing", 20_000)).resolves.toBe("recovered send");
    await waitFor(() => keys.length === 2);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  }, 20_000);
});
