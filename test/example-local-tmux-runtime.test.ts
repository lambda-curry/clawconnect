/**
 * Tests for `examples/local-tmux-runtime/runtime.mjs`.
 *
 * It lives here, not beside the example, because `examples/` is deliberately
 * not a workspace package (the point of that example is that a runtime module
 * needs no build step and no dependency on ClawConnect) — and a test file
 * outside every workspace project is not picked up by the default `vp test`
 * run. A check nobody runs is a check that does not exist.
 *
 * Both mocks are pass-through recorders, so every test in this file still
 * touches the real tmux and the real filesystem. They exist so the abort tests
 * can prove a NEGATIVE — that an abandoned recovery spawns no subprocess and
 * reads no transcript — which no assertion on the return value alone can show,
 * since "aborted" and "nothing there" both come back the same way.
 */
const spy = vi.hoisted(() => ({
  execFileArgs: [] as string[][],
  readFilePaths: [] as string[],
  /** Runs before each real readFile; lets a test abort mid-flight, deterministically. */
  onReadFile: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (Array.isArray(args[1])) spy.execFileArgs.push(args[1] as string[]);
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: string, opts?: unknown) => {
      spy.readFilePaths.push(String(path));
      spy.onReadFile?.(String(path));
      return actual.readFile(path, opts as Parameters<typeof actual.readFile>[1]);
    },
  };
});

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — the example is deliberately plain JS with no .d.ts: an
// operator points CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES straight at it.
import { registerAgentSessionRuntimes } from "../examples/local-tmux-runtime/runtime.mjs";

const execFileAsync = promisify(execFile);

/** What ClawConnect hands a module: an object with `register`. Nothing else is part of the contract. */
type Inspected = {
  state?: string;
  alive?: boolean;
  finalResponse?: string;
  lastEventAt?: number;
};
type Callbacks = {
  id: string;
  provider?: string;
  inspect: (ref: { sessionId: string }, opts: { signal?: AbortSignal }) => Promise<Inspected>;
};

/** Registers the example against a fake registry and returns the one runtime it registered. */
function registered(fleetHomeDir: string): Callbacks {
  const runtimes: Callbacks[] = [];
  registerAgentSessionRuntimes({ register: (r: Callbacks) => runtimes.push(r) }, { fleetHomeDir });
  expect(runtimes).toHaveLength(1);
  return runtimes[0];
}

function inspect(fleetHomeDir: string, handle: string, signal?: AbortSignal): Promise<Inspected> {
  return registered(fleetHomeDir).inspect({ sessionId: handle }, { signal });
}

const HANDLE = "cf-nonexistent-handle-for-tests";

beforeEach(() => {
  spy.execFileArgs = [];
  spy.readFilePaths = [];
  spy.onReadFile = undefined;
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-tmux-runtime-test-"));
  dirs.push(dir);
  return dir;
}

/** Writes a meta.json + transcript pair for `handle` under `home`, and returns the transcript path. */
function writeSession(home: string, handle: string, lines: unknown[], transcriptName = "session.jsonl"): string {
  const dir = join(home, handle);
  mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, transcriptName);
  writeFileSync(transcriptPath, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));
  return transcriptPath;
}

function assistant(timestamp: string | undefined, text: string) {
  return {
    type: "assistant",
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

// Computed once at module top level (real top-level await, not inside a
// describe callback) so it.runIf below gets a plain boolean.
const hasTmux = await tmuxAvailable();

describe("the local-tmux runtime module registers through the neutral seam", () => {
  it("registers exactly one runtime, with an id and a provider", () => {
    const runtime = registered(tmpHome());
    expect(runtime.id).toBe("claude-fleet");
    expect(runtime.provider).toBe("anthropic-claude-code");
  });

  it("offers only `inspect` — a tmux pane can neither be handed a turn nor be ended from here", () => {
    const runtime = registered(tmpHome()) as Record<string, unknown>;
    expect(typeof runtime.inspect).toBe("function");
    expect(runtime.continue).toBeUndefined();
    expect(runtime.detach).toBeUndefined();
  });
});

describe("inspect reports only what it can prove", () => {
  it("returns a bare not-alive answer (no state) for a handle with no tmux session and no transcript", async () => {
    const observed = await inspect(tmpHome(), HANDLE);
    expect(observed).toEqual({ alive: false });
    // No `state`: a probe that cannot tell working from waiting must not claim
    // either, or it would clobber a status the host reported explicitly.
    expect(observed.state).toBeUndefined();
  });

  it("rejects an unsafe handle without shelling out at all", async () => {
    await expect(inspect(tmpHome(), "../../etc/passwd")).resolves.toEqual({ alive: false });
    expect(spy.execFileArgs).toEqual([]);
  });

  it("reports nothing when no meta.json exists for the handle", async () => {
    await expect(inspect(tmpHome(), HANDLE)).resolves.toEqual({ alive: false });
  });

  it("reports nothing when meta.json is corrupt", async () => {
    const home = tmpHome();
    mkdirSync(join(home, HANDLE), { recursive: true });
    writeFileSync(join(home, HANDLE, "meta.json"), "{ not valid json");
    await expect(inspect(home, HANDLE)).resolves.toEqual({ alive: false });
  });

  it("reports nothing when transcriptPath is missing or points nowhere", async () => {
    const home = tmpHome();
    const dir = join(home, HANDLE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({}));
    await expect(inspect(home, HANDLE)).resolves.toEqual({ alive: false });

    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: join(dir, "does-not-exist.jsonl") }));
    await expect(inspect(home, HANDLE)).resolves.toEqual({ alive: false });
  });

  it("reports a completed turn carrying the last assistant text and the entry's OWN timestamp", async () => {
    const home = tmpHome();
    writeSession(home, HANDLE, [
      { type: "user", timestamp: "2026-08-03T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
      assistant("2026-08-03T00:00:05.000Z", "working on it"),
      assistant("2026-08-03T00:01:00.000Z", "done — final answer"),
    ]);
    const observed = await inspect(home, HANDLE);
    expect(observed.state).toBe("completed");
    expect(observed.finalResponse).toBe("done — final answer");
    // Not wall-clock read time: this is the bound ClawConnect uses to decide
    // whether the answer can belong to the job asking for it.
    expect(observed.lastEventAt).toBe(Date.parse("2026-08-03T00:01:00.000Z"));
  });

  it("skips assistant entries with no visible text, and unparseable lines", async () => {
    const home = tmpHome();
    writeSession(home, HANDLE, [
      assistant("2026-08-03T00:00:00.000Z", "real answer"),
      "{ not valid json",
      { type: "assistant", timestamp: "2026-08-03T00:00:05.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] } },
    ]);
    await expect(inspect(home, HANDLE)).resolves.toMatchObject({ finalResponse: "real answer" });
  });

  it("skips a text-bearing entry with no parseable timestamp rather than fabricating one", async () => {
    const home = tmpHome();
    writeSession(home, HANDLE, [
      assistant(undefined, "undated text"),
      assistant("not-a-real-timestamp", "also undated"),
      assistant("2026-08-03T00:00:00.000Z", "the actual dated answer"),
    ]);
    const observed = await inspect(home, HANDLE);
    expect(observed.finalResponse).toBe("the actual dated answer");
    expect(observed.lastEventAt).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
  });

  it("rejects an absolute transcriptPath escaping the home dir, even though the file genuinely exists and is readable", async () => {
    const home = tmpHome();
    const dir = join(home, HANDLE);
    mkdirSync(dir, { recursive: true });

    // A real, valid transcript that just happens to live OUTSIDE the home dir
    // — a naive existsSync-only check would have happily accepted this.
    const outsideDir = mkdtempSync(join(tmpdir(), "clawconnect-tmux-runtime-outside-"));
    dirs.push(outsideDir);
    const outsideTranscript = join(outsideDir, "secret.jsonl");
    writeFileSync(outsideTranscript, JSON.stringify(assistant("2026-08-03T00:00:00.000Z", "should never be read")));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: outsideTranscript }));

    await expect(inspect(home, HANDLE)).resolves.toEqual({ alive: false });
  });

  it("rejects a relative-traversal transcriptPath even when the resolved target happens to exist", async () => {
    const home = tmpHome();
    const dir = join(home, HANDLE);
    mkdirSync(dir, { recursive: true });
    // Deep enough "../" traversal to escape any tmpdir nesting and land on a
    // real, always-present file — proves the containment check runs BEFORE any
    // read is attempted, not that the target happens to be unreadable.
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: "../../../../../../../../etc/passwd" }));
    await expect(inspect(home, HANDLE)).resolves.toEqual({ alive: false });
  });

  it("accepts a transcriptPath legitimately nested under the home dir", async () => {
    const home = tmpHome();
    mkdirSync(join(home, HANDLE, "nested"), { recursive: true });
    writeSession(home, HANDLE, [assistant("2026-08-03T00:00:00.000Z", "legit answer")], join("nested", "session.jsonl"));
    await expect(inspect(home, HANDLE)).resolves.toMatchObject({ finalResponse: "legit answer" });
  });
});

/**
 * This whole path runs while a job is held out of a terminal status, under the
 * recovery deadline ClawConnect already holds. Before the signal reached here
 * the deadline aborted nothing anyone was listening to: the tmux child kept
 * running and the transcript was still read, synchronously, off the event loop.
 */
describe("an abandoned recovery stops immediately", () => {
  /** A handle with a genuinely readable transcript, so an empty answer can only mean the abort. */
  function readableSession(): string {
    const home = tmpHome();
    writeSession(home, HANDLE, [assistant("2026-08-03T00:00:00.000Z", "the answer")]);
    return home;
  }

  it("an already-aborted signal stops inspect before it spawns tmux or reads anything", async () => {
    const home = readableSession();

    // Same fixture, no signal: proves the empty answer below is the abort and
    // not a missing/unreadable transcript.
    await expect(inspect(home, HANDLE)).resolves.toMatchObject({ finalResponse: "the answer" });
    spy.execFileArgs = [];
    spy.readFilePaths = [];

    await expect(inspect(home, HANDLE, AbortSignal.abort())).resolves.toEqual({ alive: false });
    expect(spy.execFileArgs).toEqual([]);
    expect(spy.readFilePaths).toEqual([]);
  });

  it("an abort that lands DURING the read comes back as an empty answer, not a rejection", async () => {
    const home = readableSession();
    const controller = new AbortController();
    // Fires on the meta.json read — the first read this path does — so the
    // abort lands mid-operation rather than before it starts.
    spy.onReadFile = () => controller.abort();

    await expect(inspect(home, HANDLE, controller.signal)).resolves.toEqual({ alive: false });
    expect(spy.readFilePaths).toHaveLength(1);
  });

  it("a live signal that never aborts changes nothing", async () => {
    const home = readableSession();
    const observed = await inspect(home, HANDLE, new AbortController().signal);
    expect(observed.finalResponse).toBe("the answer");
    expect(observed.lastEventAt).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
  });

  it("passes the signal down to the tmux liveness probe", async () => {
    const home = readableSession();
    await inspect(home, HANDLE, new AbortController().signal);
    expect(spy.execFileArgs).toEqual([["has-session", "-t", HANDLE]]);
  });
});

it.runIf(hasTmux)(
  "reports liveness and NOTHING else while the pane is still up, even with a readable transcript",
  async () => {
    const home = tmpHome();
    const handle = `cf-runtime-test-${process.pid}`;
    writeSession(home, handle, [assistant(undefined, "mid-run text")]);

    await execFileAsync("tmux", ["new-session", "-d", "-s", handle]);
    try {
      const observed = await inspect(home, handle);
      expect(observed).toEqual({ alive: true });
      // A live pane's transcript can still change under the read, so a
      // mid-run snapshot must never surface as a completed turn.
      expect(observed.finalResponse).toBeUndefined();
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", handle]).catch(() => {});
    }
  },
);
