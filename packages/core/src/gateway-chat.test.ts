import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { GatewayEvent } from "./types.ts";

/**
 * End-to-end frame-ordering fixtures for OpenClawGateway.chat(), against a
 * real in-process WebSocket server. The subscribe-before-send contract can
 * only be proven at this level: it is entirely about which frames are on the
 * wire before the chat.send response comes back, which a mocked gateway
 * cannot express.
 *
 * gateway.ts resolves its device-identity file from homedir() at module load
 * time, so HOME is redirected to a temp dir before the import — these tests
 * never touch the real ~/.openclaw.
 */
process.env.HOME = mkdtempSync(join(tmpdir(), "clawconnect-gateway-"));
const { OpenClawGateway } = await import("./gateway.ts");

type RequestFrame = { id?: string; method?: string; params?: Record<string, unknown> };
type RequestHandler = (frame: RequestFrame, socket: ServerSocket) => void;

/**
 * Minimal stand-in for the openclaw gateway: completes the v3 device
 * handshake (the client signs it; nothing here verifies the signature) and
 * hands every other request to the test's own handler, which decides exactly
 * what to send and in what order.
 */
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
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => resolve());
      }),
  };
}

const chatEvent = (runId: string, state: string, text?: string, sessionKey = "agent:main:main:thread:test") =>
  JSON.stringify({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey,
      state,
      ...(text === undefined ? {} : { message: { content: [{ type: "text", text }] } }),
    },
  });

const agentToolEvent = (runId: string, name: string) =>
  JSON.stringify({
    type: "event",
    event: "agent",
    payload: { runId, stream: "tool", data: { phase: "start", name, args: { command: "pnpm test" } } },
  });

const sendAck = (id: string | undefined, runId: string) =>
  JSON.stringify({ type: "res", id, ok: true, payload: { runId } });

/** Poll a predicate on real timers — the reconnect loop is genuinely async I/O. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

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
  return gateway;
}

describe("OpenClawGateway.chat — run correlation across the send boundary", () => {
  it("delivers the reply when the terminal chat event arrives BEFORE the send is acknowledged", async () => {
    // The shape that strands a finished run: openclaw starts the run and
    // emits its events, and the response carrying the runId only lands
    // afterwards. Listeners registered after the send miss the final event
    // entirely and the caller waits out the full timeout.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(chatEvent("run-1", "final", "the final answer"));
      socket.send(sendAck(frame.id, "run-1"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe(
      "the final answer",
    );
  });

  it("replays pre-acknowledgement tool events to onEvent, in order, before the final", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(agentToolEvent("run-2", "Bash"));
      socket.send(agentToolEvent("run-2", "Read"));
      socket.send(chatEvent("run-2", "final", "done"));
      socket.send(sendAck(frame.id, "run-2"));
    });

    const seen: GatewayEvent[] = [];
    const reply = await gateway.chat("agent:main:main:thread:test", "hi", 10_000, (e) => seen.push(e));

    expect(reply).toBe("done");
    expect(seen.map((e) => e.type === "tool" && e.toolName)).toEqual(["Bash", "Read"]);
  });

  it("ignores buffered frames belonging to a different run", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      // Straggler from an unrelated run, then this run's own final.
      socket.send(chatEvent("some-other-run", "final", "not our answer"));
      socket.send(sendAck(frame.id, "run-3"));
      socket.send(chatEvent("run-3", "final", "our answer"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe("our answer");
  });

  it("keeps this run's final when unrelated sessions flood the socket before the acknowledgement", async () => {
    // The pre-runId buffer is fed by ALL socket traffic. Another session's
    // busy run must not be able to crowd out the one frame this call exists
    // to receive.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      for (let i = 0; i < 600; i++) {
        socket.send(chatEvent(`noisy-run-${i}`, "final", "someone else's answer", "agent:other:main:thread:noise"));
      }
      socket.send(chatEvent("run-5", "final", "our answer"));
      socket.send(sendAck(frame.id, "run-5"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe("our answer");
  });

  it("keeps this run's buffered final when a flood of agent frames would overflow the buffer", async () => {
    // Agent frames carry no sessionKey, so they cannot be filtered on
    // arrival — they can only be bounded. Evicting oldest-first would throw
    // away the terminal chat frame that was buffered before them; progress
    // chatter must be sacrificed instead.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(chatEvent("run-6", "final", "our answer"));
      for (let i = 0; i < 600; i++) {
        socket.send(agentToolEvent(`noisy-run-${i}`, "Bash"));
      }
      socket.send(sendAck(frame.id, "run-6"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe("our answer");
  });

  it("still handles the ordinary case where the acknowledgement precedes the events", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(sendAck(frame.id, "run-4"));
      socket.send(agentToolEvent("run-4", "Bash"));
      socket.send(chatEvent("run-4", "delta", "partial"));
      socket.send(chatEvent("run-4", "final", "the final answer"));
    });

    const seen: GatewayEvent[] = [];
    const reply = await gateway.chat("agent:main:main:thread:test", "hi", 10_000, (e) => seen.push(e));
    expect(reply).toBe("the final answer");
    expect(seen).toHaveLength(1);
  });

  it("hands the runId to onRunId before replaying anything", async () => {
    // The correlation key for upstream run state. A fake gateway cannot
    // cover this, so it is asserted against the real chat() path.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(agentToolEvent("run-9", "Bash"));
      socket.send(sendAck(frame.id, "run-9"));
      socket.send(chatEvent("run-9", "final", "done"));
    });

    const seenRunIds: string[] = [];
    const seenEvents: GatewayEvent[] = [];
    const reply = await gateway.chat(
      "agent:main:main:thread:test",
      "hi",
      10_000,
      (e) => seenEvents.push(e),
      (runId) => seenRunIds.push(runId),
    );

    expect(reply).toBe("done");
    expect(seenRunIds).toEqual(["run-9"]);
    // Ordering matters: a reconciliation racing the replay must already be
    // able to name the run, so the id lands before buffered events flush.
    expect(seenEvents).toHaveLength(1);
  });

  it("rejects when the send itself fails, without stranding the caller", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "session busy" } }));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).rejects.toThrow(/session busy/);
  });

  it("rejects when the send returns no runId — there is nothing to correlate against", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).rejects.toThrow(
      /did not return a runId/,
    );
  });
});

describe("OpenClawGateway reconnect — a failed attempt must re-arm", () => {
  it("reconnects on a later retry after the first reconnect attempt fails", async () => {
    // Regression for the dead end this replaced: scheduleReconnect cleared its
    // own timer before retrying, so if that retry threw, nothing was left to
    // fire another one — no timer, and no socket to emit another `close`. The
    // client stayed offline until the process restarted. Live logs showed 53
    // disconnects against 56 live-timeout errors, which is that dead end.
    //
    // Only the background loop can prove this: sendRpc calls connect() itself,
    // so any RPC-based assertion would reconnect the client and mask the bug.
    // The reconnect log line is the one unambiguous signal.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    const { port } = wss.address() as AddressInfo;
    const handshake = (socket: ServerSocket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as RequestFrame;
        if (frame.method === "connect") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }));
        }
      });
    };
    wss.on("connection", handshake);

    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));

    const gateway = new OpenClawGateway({ url: `ws://127.0.0.1:${port}`, token: "t" });
    let revived: WebSocketServer | undefined;
    try {
      await gateway.connect();

      // Drop the server so the client sees `close` and starts reconnecting
      // into a port with nothing listening — the first attempt must fail.
      await new Promise<void>((r) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => r());
      });
      await waitFor(() => lines.some((l) => l.includes("reconnect failed")), 8_000);

      // Bring it back on the same port. Only a RE-ARMED timer can find it.
      revived = new WebSocketServer({ port, host: "127.0.0.1" });
      await once(revived, "listening");
      revived.on("connection", handshake);

      await waitFor(() => lines.some((l) => l.includes("reconnected after")), 15_000);
      expect(lines.some((l) => l.includes("reconnect failed"))).toBe(true);
    } finally {
      console.error = realError;
      gateway.close();
      if (revived) await new Promise<void>((r) => revived!.close(() => r()));
    }
  }, 30_000);
});

describe("OpenClawGateway.reconcileRun — bounded read of upstream truth", () => {
  const history = (messages: unknown[]) => ({ messages });

  it("reports a settled transcript with its trailing assistant text", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.history") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: history([
            { role: "user", content: "do the thing" },
            { role: "assistant", content: [{ type: "text", text: "here is the report" }] },
          ]),
        }),
      );
    });

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", { intervalMs: 1 });
    expect(observation).toMatchObject({ ok: true, changed: false, trailingText: "here is the report" });
    // Carried so a caller can compare successive observations for progress
    // that happens between them, not just within one.
    expect(observation.snapshotKey).not.toBe("");
  });

  it("reports a still-advancing transcript as changed", async () => {
    let reads = 0;
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.history") return;
      reads += 1;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: history(
            Array.from({ length: reads }, (_, i) => ({ role: "toolResult", content: `tool round ${i}` })),
          ),
        }),
      );
    });

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", { intervalMs: 1 });
    expect(observation.changed).toBe(true);
    expect(observation.ok).toBe(true);
  });

  it("reports a settled transcript with no visible assistant text", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.history") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: history([{ role: "toolResult", content: "exit 0" }]),
        }),
      );
    });

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", { intervalMs: 1 });
    expect(observation).toMatchObject({ ok: true, changed: false, trailingText: "" });
    expect(observation.snapshotKey).not.toBe("");
  });

  it("reports not-ok when upstream can't be read — a failed read is not evidence of a finished run", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.history") return;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "no such session" } }));
    });

    await expect(gateway.reconcileRun("agent:main:main:thread:test", { intervalMs: 1 })).resolves.toMatchObject({
      ok: false,
    });
  });
});
