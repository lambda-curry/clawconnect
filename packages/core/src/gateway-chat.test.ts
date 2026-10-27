import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
async function startFakeGateway(onRequest: RequestHandler, autoTranscript = true) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "test-nonce" },
      }),
    );
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as RequestFrame;
      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }),
        );
        return;
      }
      if (autoTranscript && frame.method === "chat.history") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { messages: [], hasMore: false },
          }),
        );
        return;
      }
      if (autoTranscript && frame.method === "sessions.messages.subscribe") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
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

const chatEvent = (
  runId: string,
  state: string,
  text?: string,
  sessionKey = "agent:main:main:thread:test",
) =>
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
    payload: {
      runId,
      stream: "tool",
      data: { phase: "start", name, args: { command: "pnpm test" } },
    },
  });

const sessionToolEvent = (sequence: number, name: string) =>
  JSON.stringify({
    type: "event",
    event: "session.message",
    payload: {
      sessionKey: "agent:main:main:thread:test",
      messageId: `tool-${sequence}`,
      messageSeq: sequence,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${sequence}`, name, arguments: {} }],
        __openclaw: { id: `tool-${sequence}`, seq: sequence },
      },
    },
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
  vi.unstubAllEnvs();
});

async function harness(onRequest: RequestHandler, autoTranscript = true) {
  const server = await startFakeGateway(onRequest, autoTranscript);
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
      socket.send(sessionToolEvent(1, "Bash"));
      socket.send(sessionToolEvent(2, "Read"));
      socket.send(chatEvent("run-2", "final", "done"));
      socket.send(sendAck(frame.id, "run-2"));
    });

    const seen: GatewayEvent[] = [];
    const reply = await gateway.chat("agent:main:main:thread:test", "hi", 10_000, (e) =>
      seen.push(e),
    );

    expect(reply).toBe("done");
    expect(seen.map((e) => e.type === "tool" && e.toolName)).toEqual(["Bash", "Read"]);
  });

  it("projects a batch of contiguous transcript events before terminal cleanup", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      for (let i = 1; i <= 100; i++) socket.send(sessionToolEvent(i, `Tool${i}`));
      socket.send(chatEvent("batch-run", "final", "done"));
      socket.send(sendAck(frame.id, "batch-run"));
    });
    const seen: GatewayEvent[] = [];
    await expect(
      gateway.chat("agent:main:main:thread:test", "hi", 10_000, (event) => seen.push(event)),
    ).resolves.toBe("done");
    expect(seen).toHaveLength(100);
    expect(seen.at(-1)).toMatchObject({ toolName: "Tool100" });
  });

  it("ignores buffered frames belonging to a different run", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      // Straggler from an unrelated run, then this run's own final.
      socket.send(chatEvent("some-other-run", "final", "not our answer"));
      socket.send(sendAck(frame.id, "run-3"));
      socket.send(chatEvent("run-3", "final", "our answer"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe(
      "our answer",
    );
  });

  it("keeps this run's final when unrelated sessions flood the socket before the acknowledgement", async () => {
    // The pre-runId buffer is fed by ALL socket traffic. Another session's
    // busy run must not be able to crowd out the one frame this call exists
    // to receive.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      for (let i = 0; i < 600; i++) {
        socket.send(
          chatEvent(
            `noisy-run-${i}`,
            "final",
            "someone else's answer",
            "agent:other:main:thread:noise",
          ),
        );
      }
      socket.send(chatEvent("run-5", "final", "our answer"));
      socket.send(sendAck(frame.id, "run-5"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe(
      "our answer",
    );
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

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).resolves.toBe(
      "our answer",
    );
  });

  it("still handles the ordinary case where the acknowledgement precedes the events", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(sendAck(frame.id, "run-4"));
      socket.send(agentToolEvent("run-4", "Bash"));
      socket.send(sessionToolEvent(1, "Bash"));
      socket.send(chatEvent("run-4", "delta", "partial"));
      socket.send(chatEvent("run-4", "final", "the final answer"));
    });

    const seen: GatewayEvent[] = [];
    const reply = await gateway.chat("agent:main:main:thread:test", "hi", 10_000, (e) =>
      seen.push(e),
    );
    expect(reply).toBe("the final answer");
    // Both sources report the call: the live agent frame carries it the moment
    // it starts (with its args), the durable transcript again once persisted.
    // Reconciling the two is the CALLER's job — SessionManager collapses the
    // echo — because only the caller can tell a resumed transcript-only run
    // from a live one. The gateway's job is to not silently drop either.
    expect(seen.map((e) => e.text).sort()).toEqual(["Bash: ", "Bash: pnpm test"]);
  });

  it("hands the runId to onRunId before replaying anything", async () => {
    // The correlation key for upstream run state. A fake gateway cannot
    // cover this, so it is asserted against the real chat() path.
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(agentToolEvent("run-9", "Bash"));
      socket.send(sessionToolEvent(1, "Bash"));
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
    expect(seenEvents).toHaveLength(2);
  });

  it("rejects when the send itself fails, without stranding the caller", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { message: "session busy" },
        }),
      );
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 10_000)).rejects.toThrow(
      /session busy/,
    );
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

  it("rejects the elapsed wait window with the typed parent-observation error, not a generic one", async () => {
    // The type is the whole signal: session.ts routes THIS rejection into
    // transcript recovery (the run is probably still going) and every other
    // one into a terminal error. A plain Error here would silently restore
    // the old "timeout means the task failed" behaviour.
    const gateway = await harness((frame, socket) => {
      // Acknowledged, correlated — and then nothing. The run is alive
      // upstream; only our willingness to keep watching runs out.
      if (frame.method === "chat.send") socket.send(sendAck(frame.id, "run-timeout"));
    });

    await expect(gateway.chat("agent:main:main:thread:test", "hi", 150)).rejects.toMatchObject({
      name: "ParentObservationTimeoutError",
      timeoutMs: 150,
    });
  });

  it("rejects an upstream run error with a plain error — that IS a verdict on the run", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.send") return;
      socket.send(sendAck(frame.id, "run-failed"));
      socket.send(
        JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: "run-failed",
            sessionKey: "agent:main:main:thread:test",
            state: "error",
            errorMessage: "provider returned 500",
          },
        }),
      );
    });

    const rejection = await gateway.chat("agent:main:main:thread:test", "hi", 10_000).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(rejection?.message).toBe("provider returned 500");
    expect(rejection?.name).not.toBe("ParentObservationTimeoutError");
  });
});

describe("OpenClawGateway.abort — run-scoped cancellation", () => {
  it("uses chat.abort instead of dispatching a second chat.send", async () => {
    const gateway = await harness((frame, socket) => {
      expect(frame.method).toBe("chat.abort");
      expect(frame.params).toEqual({
        sessionKey: "agent:main:main:thread:test",
        runId: "run-to-cancel",
      });
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { ok: true, aborted: true, runIds: ["run-to-cancel"] },
        }),
      );
    });

    await expect(gateway.abort("agent:main:main:thread:test", "run-to-cancel")).resolves.toEqual({
      ok: true,
      aborted: true,
      runIds: ["run-to-cancel"],
    });
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
      socket.send(
        JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }),
      );
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as RequestFrame;
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }),
          );
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
    }, false);

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", {
      intervalMs: 1,
    });
    expect(observation).toMatchObject({
      ok: true,
      changed: false,
      trailingText: "here is the report",
    });
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
            Array.from({ length: reads }, (_, i) => ({
              role: "toolResult",
              content: `tool round ${i}`,
            })),
          ),
        }),
      );
    }, false);

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", {
      intervalMs: 1,
    });
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
    }, false);

    const observation = await gateway.reconcileRun("agent:main:main:thread:test", {
      intervalMs: 1,
    });
    expect(observation).toMatchObject({ ok: true, changed: false, trailingText: "" });
    expect(observation.snapshotKey).not.toBe("");
  });

  it("reports not-ok when upstream can't be read — a failed read is not evidence of a finished run", async () => {
    const gateway = await harness((frame, socket) => {
      if (frame.method !== "chat.history") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: { message: "no such session" },
        }),
      );
    }, false);

    await expect(
      gateway.reconcileRun("agent:main:main:thread:test", { intervalMs: 1 }),
    ).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("bounded transcript replay and pending work", () => {
  const sessionKey = "agent:main:main:thread:test";
  const row = (sequence: number, text = "progress") => ({
    role: "assistant",
    content: [{ type: "text", text }],
    __openclaw: { id: `row-${sequence}`, seq: sequence },
  });

  it.each([
    ["CLAWCONNECT_TRANSCRIPT_MAX_MESSAGES", "2", [row(1), row(2), row(3)]],
    ["CLAWCONNECT_TRANSCRIPT_MAX_BYTES", "100", [row(1, "x".repeat(200))]],
  ])("stops explicitly when replay exceeds %s", async (name, value, messages) => {
    vi.stubEnv(name as string, value as string);
    const states: string[] = [];
    const events: GatewayEvent[] = [];
    const gateway = await harness((frame, socket) => {
      if (frame.method === "chat.history") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { messages } }));
      }
    }, false);
    await gateway.resumeTranscript(
      sessionKey,
      0,
      (event) => events.push(event),
      (state) => states.push(state.transcript),
    );
    expect(states.at(-1)).toBe("detached");
    expect(events).toEqual([]);
    expect(gateway.diagnostics()).toMatchObject({
      transcriptLimitFailures: 1,
      transcriptWatches: 1,
      transcriptReplayMessages: 0,
      transcriptReplayBytes: 0,
      pendingTranscriptWork: 0,
    });
  });

  it("caps pagination even when an upstream keeps returning empty pages", async () => {
    vi.stubEnv("CLAWCONNECT_TRANSCRIPT_MAX_PAGES", "2");
    let reads = 0;
    const gateway = await harness((frame, socket) => {
      if (frame.method === "chat.history") {
        reads++;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { messages: [], hasMore: true, nextOffset: reads },
          }),
        );
      }
    }, false);
    await gateway.resumeTranscript(sessionKey, 0, undefined, undefined);
    expect(reads).toBe(2);
    expect(gateway.diagnostics()).toMatchObject({
      transcriptWatches: 1,
      transcriptLimitFailures: 1,
    });
  });

  it.each([
    ["CLAWCONNECT_TRANSCRIPT_QUEUE_MAX_ITEMS", "2", 3],
    ["CLAWCONNECT_TRANSCRIPT_QUEUE_MAX_BYTES", "100", 1],
  ])("bounds pending work with %s while recovery is blocked", async (name, value, count) => {
    vi.stubEnv(name, value);
    let release: (() => void) | undefined;
    let subscriptions = 0;
    let socket: ServerSocket | undefined;
    const states: string[] = [];
    const events: GatewayEvent[] = [];
    const gateway = await harness((frame, connection) => {
      if (frame.method === "chat.history") {
        connection.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { messages: [] } }),
        );
      }
      if (frame.method === "sessions.messages.subscribe") {
        socket = connection;
        const acknowledge = () =>
          connection.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
        if (++subscriptions === 1) release = acknowledge;
        else acknowledge();
      }
    }, false);
    const resuming = gateway.resumeTranscript(
      sessionKey,
      0,
      (event) => events.push(event),
      (state) => states.push(state.transcript),
    );
    await waitFor(() => Boolean(release), 1_000);
    for (let i = 1; i <= count; i++) socket!.send(sessionToolEvent(i, "Bash"));
    await waitFor(() => gateway.diagnostics().transcriptLimitFailures === 1, 1_000);
    expect(gateway.diagnostics().pendingTranscriptWork).toBeLessThanOrEqual(2);
    expect(gateway.diagnostics().pendingTranscriptBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(states.at(-1)).toBe("detached");
    release!();
    await resuming;
    await waitFor(() => gateway.diagnostics().pendingTranscriptWork === 0, 1_000);
    expect(events).toEqual([]);
    expect(gateway.diagnostics()).toMatchObject({
      transcriptWatches: 1,
      pendingTranscriptBytes: 0,
    });
  });

  it("keeps sequenced live messages out of the identity index and bounds legacy identities", async () => {
    vi.stubEnv("CLAWCONNECT_TRANSCRIPT_MAX_MESSAGES", "2");
    let socket: ServerSocket | undefined;
    const gateway = await harness((frame, connection) => {
      socket = connection;
      connection.send(
        JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { messages: [] } }),
      );
    }, false);
    await gateway.resumeTranscript(sessionKey, 0, undefined, undefined);
    for (let i = 1; i <= 5; i++) socket!.send(sessionToolEvent(i, "Bash"));
    await waitFor(() => gateway.diagnostics().pendingTranscriptWork === 0, 1_000);
    expect(gateway.diagnostics().transcriptSeenIds).toBe(0);
    for (let i = 1; i <= 3; i++) {
      socket!.send(
        JSON.stringify({
          type: "event",
          event: "session.message",
          payload: {
            sessionKey,
            messageId: `legacy-${i}`,
            message: { role: "assistant", content: `legacy ${i}` },
          },
        }),
      );
    }
    await waitFor(() => gateway.diagnostics().transcriptLimitFailures === 1, 1_000);
    expect(gateway.diagnostics()).toMatchObject({ transcriptSeenIds: 0, transcriptWatches: 1 });
  });
});

describe("transcript limit recovery", () => {
  const sessionKey = "agent:main:main:thread:test";
  const row = (sequence: number, text = "progress") => ({
    role: "assistant",
    content: [{ type: "text", text }],
    __openclaw: { id: `row-${sequence}`, seq: sequence },
  });

  it("resumes at a bounded current head, reports the sequence gap, and accepts subsequent events", async () => {
    vi.stubEnv("CLAWCONNECT_TRANSCRIPT_MAX_MESSAGES", "2");
    const states: Array<{
      reason?: string;
      skippedSequenceCount?: number;
      lastSeenSequence?: number;
    }> = [];
    const events: GatewayEvent[] = [];
    let socket: ServerSocket | undefined;
    const gateway = await harness((frame, connection) => {
      socket = connection;
      const messages = frame.params?.limit === 1 ? [row(20)] : [row(18), row(19), row(20)];
      connection.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: frame.method === "chat.history" ? { messages } : {},
        }),
      );
    }, false);
    await gateway.resumeTranscript(
      sessionKey,
      0,
      (event) => events.push(event),
      (state) => states.push(state),
    );
    await waitFor(() => states.some((state) => state.reason === "limit_recovered"), 1_000);
    expect(states.find((state) => state.reason === "limit_recovered")).toMatchObject({
      skippedSequenceCount: 20,
      lastSeenSequence: 20,
    });
    socket!.send(sessionToolEvent(21, "AfterLimit"));
    await waitFor(() => events.length === 1, 1_000);
    expect(events[0]).toMatchObject({ toolName: "AfterLimit" });
    expect(gateway.diagnostics()).toMatchObject({
      transcriptPausedWatches: 0,
      transcriptSkippedSequences: 20,
    });
  });

  it("coalesces overload while paused and retries head recovery on a real reconnect", async () => {
    vi.stubEnv("CLAWCONNECT_TRANSCRIPT_MAX_BYTES", "250");
    let healthy = false;
    let headReads = 0;
    let socket: ServerSocket | undefined;
    const events: GatewayEvent[] = [];
    const reasons: string[] = [];
    const gateway = await harness((frame, connection) => {
      socket = connection;
      if (frame.method === "chat.history") {
        if (frame.params?.limit === 1) headReads++;
        connection.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { messages: [row(100, healthy ? "head" : "x".repeat(1_000))] },
          }),
        );
      } else connection.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    }, false);
    await gateway.resumeTranscript(
      sessionKey,
      0,
      (event) => events.push(event),
      (state) => {
        if (state.reason) reasons.push(state.reason);
      },
    );
    await waitFor(() => headReads === 1 && gateway.diagnostics().pendingRpcs === 0, 1_000);
    for (let i = 1; i <= 100; i++) socket!.send(sessionToolEvent(i, "Skipped"));
    await waitFor(() => gateway.diagnostics().transcriptSkippedEvents === 100, 1_000);
    expect(headReads).toBe(1);
    expect(gateway.diagnostics()).toMatchObject({
      pendingTranscriptWork: 0,
      transcriptPausedWatches: 1,
      transcriptWatches: 1,
    });
    healthy = true;
    socket!.terminate();
    await waitFor(() => reasons.includes("limit_recovered"), 4_000);
    expect(headReads).toBe(3);
    socket!.send(sessionToolEvent(101, "AfterReconnect"));
    await waitFor(() => events.length === 1, 1_000);
    expect(events[0]).toMatchObject({ toolName: "AfterReconnect" });
    expect(gateway.diagnostics()).toMatchObject({
      transcriptPausedWatches: 0,
      transcriptSkippedEvents: 100,
      transcriptSkippedSequences: 100,
    });
  });
});
