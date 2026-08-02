import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPool } from "./gateway-pool.ts";
import { runTask, checkTask, getTask } from "./tools.ts";
import { setTelemetrySink } from "./telemetry.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { GatewayEvent } from "./types.ts";

/**
 * Deterministic payload-size fixtures for the shrunk recurring-payload
 * contract: typical running update < 2KB, hard ceiling ~8KB except
 * legitimate terminal content (full summary/artifacts are never bounded by
 * the log window). Exercised through the real tools.ts entry points
 * (checkTask/getTask), not the lower-level SessionManager, so this also
 * proves the telemetry wiring measures the actual returned snapshot.
 */

let onEventCb: ((e: GatewayEvent) => void) | undefined;
let resolveChat: ((v: string) => void) | undefined;

vi.mock("./gateway.ts", () => {
  function FakeOpenClawGateway() {
    return {
      chat(_sessionKey: string, _message: string, _timeoutMs: number, onEvent?: (e: GatewayEvent) => void) {
        onEventCb = onEvent;
        return new Promise<string>((resolve) => {
          resolveChat = resolve;
        });
      },
      close() {},
      pollTranscriptForFinalText: () => Promise.resolve(undefined),
    };
  }
  return { OpenClawGateway: FakeOpenClawGateway };
});

function singleAgentRegistry(): AgentRegistry {
  return {
    default: "clawdy",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [{ id: "clawdy", url: "ws://fake-clawdy", password: "x", openclawAgentId: "main" }],
  };
}

function emitMany(n: number, make: (i: number) => GatewayEvent) {
  for (let i = 0; i < n; i++) onEventCb?.(make(i));
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

afterEach(() => {
  setTelemetrySink(undefined);
  onEventCb = undefined;
  resolveChat = undefined;
});

describe("payload size — non-terminal running snapshot", () => {
  it("typical running update (realistic tool/lifecycle activity) stays under the 2KB target", async () => {
    const pool = new GatewayPool(singleAgentRegistry());
    const run = runTask(pool, { task: "do a realistic multi-step task" });
    emitMany(15, (i) =>
      i % 3 === 0
        ? { type: "tool", text: `Bash: running step ${i}`, toolName: "Bash", args: { command: `step-${i}.sh` } }
        : i % 3 === 1
          ? { type: "tool-result", text: "ok", toolName: "Bash", isError: false }
          : { type: "lifecycle", text: `checkpoint ${i} reached` },
    );

    const result = await getTask(pool, { jobId: run.jobId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.snapshot.status).toBe("running");
    expect(byteSize(result.snapshot)).toBeLessThan(2048);
  });

  it("worst case (every event truncated at the 240-char cap, long burst) stays under the ~8KB hard ceiling", async () => {
    const pool = new GatewayPool(singleAgentRegistry());
    const run = runTask(pool, { task: "long chatty task" });
    const longText = "x".repeat(1000); // will truncate to 240 per event
    emitMany(150, () => ({ type: "lifecycle", text: longText }));

    const result = await getTask(pool, { jobId: run.jobId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(byteSize(result.snapshot)).toBeLessThan(8192);
  });

  it("check_task (poll mode, immediate return on existing activity) also stays under the 2KB typical target", async () => {
    vi.useFakeTimers();
    try {
      const pool = new GatewayPool(singleAgentRegistry());
      const run = runTask(pool, { task: "poll-mode task" });
      emitMany(8, (i) => ({ type: "lifecycle", text: `step ${i} of the run` }));

      const resultPromise = checkTask(pool, { jobId: run.jobId, mode: "poll", knownLogCount: 0, waitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(byteSize(result.snapshot)).toBeLessThan(2048);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("payload size — terminal content is exempt from the log-window ceiling", () => {
  it("a large legitimate final summary is delivered in full even though it would blow past the running-update ceiling", async () => {
    const pool = new GatewayPool(singleAgentRegistry());
    const run = runTask(pool, { task: "produces a long final report" });
    const bigSummary = "## Report\n" + "Finding detail. ".repeat(400); // several KB
    resolveChat?.(bigSummary);
    await new Promise((r) => setTimeout(r, 20));

    const result = await getTask(pool, { jobId: run.jobId });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.isTerminal).toBe(true);
    expect(result.snapshot.summary).toBe(bigSummary);
    // The overall payload is allowed to exceed the running-update ceiling —
    // it's legitimate terminal content, not log-window bloat.
    expect(byteSize(result.snapshot)).toBeGreaterThan(2048);
  });
});

describe("telemetry — structured counts/bytes only, never prompt/log content", () => {
  it("records payloadBytes/logEventsReturned/logCursor alongside the existing status/terminal fields, with no task text anywhere in the event", async () => {
    const events: unknown[] = [];
    setTelemetrySink((e) => events.push(e));

    const pool = new GatewayPool(singleAgentRegistry());
    const run = runTask(pool, { task: "a very secret task description nobody should log" });
    emitMany(5, (i) => ({ type: "lifecycle", text: `step ${i}` }));
    await getTask(pool, { jobId: run.jobId });

    const getTaskEvents = events.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null && (e as Record<string, unknown>).tool === "get_task");
    expect(getTaskEvents.length).toBeGreaterThan(0);
    const last = getTaskEvents.at(-1)!;
    expect(typeof last.payloadBytes).toBe("number");
    expect(typeof last.logEventsReturned).toBe("number");
    expect(typeof last.logCursor).toBe("number");
    expect(last.terminalRetrieval).toBe(false);
    expect(JSON.stringify(events)).not.toContain("a very secret task description");
  });
});
