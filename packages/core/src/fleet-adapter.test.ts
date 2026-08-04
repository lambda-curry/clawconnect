/**
 * Both mocks are pass-through recorders, so every test in this file still
 * touches the real tmux and the real filesystem. They exist so the abort tests
 * can prove a NEGATIVE — that an abandoned recovery spawns no subprocess and
 * reads no transcript — which no assertion on the return value alone can show,
 * since "aborted" and "nothing there" both come back as null.
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
import { LocalTmuxFleetAdapter } from "./fleet-adapter.ts";
import type { AgentSessionAttachment } from "./types.ts";

const execFileAsync = promisify(execFile);

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
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetadapter-test-"));
  dirs.push(dir);
  return dir;
}

function makeAttachment(overrides: Partial<AgentSessionAttachment> = {}): AgentSessionAttachment {
  return {
    id: "att-1",
    runtime: "claude-fleet",
    handle: "cf-nonexistent-handle-for-tests",
    host: "workstation-1",
    attachedAt: Date.now(),
    status: "running",
    ...overrides,
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

describe("LocalTmuxFleetAdapter", () => {
  it("isLive returns false (not throws) for a handle with no tmux session", async () => {
    const adapter = new LocalTmuxFleetAdapter(tmpHome());
    await expect(adapter.isLive(makeAttachment())).resolves.toBe(false);
  });

  it("isLive returns false for an unsafe handle without shelling out at all", async () => {
    const adapter = new LocalTmuxFleetAdapter(tmpHome());
    await expect(adapter.isLive(makeAttachment({ handle: "../../etc/passwd" }))).resolves.toBe(false);
  });

  it("readTerminalHandoff returns null for an unsafe handle", async () => {
    const adapter = new LocalTmuxFleetAdapter(tmpHome());
    await expect(adapter.readTerminalHandoff(makeAttachment({ handle: "../escape" }))).resolves.toBeNull();
  });

  it("readTerminalHandoff returns null when no meta.json exists for the handle", async () => {
    const adapter = new LocalTmuxFleetAdapter(tmpHome());
    await expect(adapter.readTerminalHandoff(makeAttachment())).resolves.toBeNull();
  });

  it("readTerminalHandoff returns null when meta.json is corrupt", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "{ not valid json");
    const adapter = new LocalTmuxFleetAdapter(home);
    await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();
  });

  it("readTerminalHandoff returns null when transcriptPath is missing or points nowhere", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({}));
    const adapter = new LocalTmuxFleetAdapter(home);
    await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();

    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: join(dir, "does-not-exist.jsonl") }));
    await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();
  });

  it("readTerminalHandoff reads the last assistant text from the transcript", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "session.jsonl");
    const lines = [
      { type: "user", timestamp: "2026-08-03T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
      { type: "assistant", timestamp: "2026-08-03T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } },
      { type: "assistant", timestamp: "2026-08-03T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "done — final answer" }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));

    const adapter = new LocalTmuxFleetAdapter(home);
    const handoff = await adapter.readTerminalHandoff(attachment);
    expect(handoff?.text).toBe("done — final answer");
    expect(handoff?.resultAt).toBe(Date.parse("2026-08-03T00:01:00.000Z"));
  });

  it("readTerminalHandoff skips assistant entries with no visible text and unparseable lines", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", timestamp: "2026-08-03T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "real answer" }] } }),
      "{ not valid json",
      JSON.stringify({ type: "assistant", timestamp: "2026-08-03T00:00:05.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] } }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));

    const adapter = new LocalTmuxFleetAdapter(home);
    const handoff = await adapter.readTerminalHandoff(attachment);
    expect(handoff?.text).toBe("real answer");
  });

  it("readTerminalHandoff skips a text-bearing entry with no parseable timestamp rather than fabricating one", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "session.jsonl");
    const lines = [
      // Newest entry has text but no usable timestamp — must be skipped, not
      // dated with Date.now() as a substitute.
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "undated text" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "not-a-real-timestamp", message: { role: "assistant", content: [{ type: "text", text: "also undated" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-08-03T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "the actual dated answer" }] } }),
    ];
    writeFileSync(transcriptPath, lines.join("\n"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));

    const adapter = new LocalTmuxFleetAdapter(home);
    const handoff = await adapter.readTerminalHandoff(attachment);
    expect(handoff?.text).toBe("the actual dated answer");
    expect(handoff?.resultAt).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
  });

  it("readTerminalHandoff rejects an absolute transcriptPath that escapes fleetHomeDir, even though the file genuinely exists and is readable", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });

    // A real, valid transcript that just happens to live OUTSIDE fleetHomeDir
    // — a naive existsSync-only check would have happily accepted this.
    const outsideDir = mkdtempSync(join(tmpdir(), "clawconnect-fleetadapter-outside-"));
    dirs.push(outsideDir);
    const outsideTranscript = join(outsideDir, "secret.jsonl");
    writeFileSync(
      outsideTranscript,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "should never be read" }] },
      }),
    );
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: outsideTranscript }));

    const adapter = new LocalTmuxFleetAdapter(home);
    await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();
  });

  it("readTerminalHandoff rejects a relative-traversal transcriptPath even when the resolved target happens to exist", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    // Deep enough "../" traversal to escape any tmpdir nesting and land on a
    // real, always-present file — proves the containment check runs BEFORE
    // any read is attempted, not that the target happens to be unreadable.
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath: "../../../../../../../../etc/passwd" }));

    const adapter = new LocalTmuxFleetAdapter(home);
    await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();
  });

  it("readTerminalHandoff accepts a transcriptPath legitimately nested under fleetHomeDir", async () => {
    const home = tmpHome();
    const attachment = makeAttachment();
    const dir = join(home, attachment.handle);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = join(dir, "nested", "session.jsonl");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-03T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "legit answer" }] },
      }),
    );
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));

    const adapter = new LocalTmuxFleetAdapter(home);
    const handoff = await adapter.readTerminalHandoff(attachment);
    expect(handoff?.text).toBe("legit answer");
  });

  /**
   * This whole path runs while a job is held out of a terminal status, under
   * the recovery deadline session.ts already holds. Before the signal reached
   * here the deadline aborted nothing anyone was listening to: the tmux child
   * kept running and the transcript was still read, synchronously, off the
   * event loop.
   */
  describe("an abandoned recovery stops immediately", () => {
    /** A handle with a genuinely readable transcript, so a null return can only mean the abort. */
    function readableSession(): { home: string; attachment: AgentSessionAttachment } {
      const home = tmpHome();
      const attachment = makeAttachment();
      const dir = join(home, attachment.handle);
      mkdirSync(dir, { recursive: true });
      const transcriptPath = join(dir, "session.jsonl");
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-03T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
        }),
      );
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));
      return { home, attachment };
    }

    it("an already-aborted signal stops readTerminalHandoff before it spawns tmux or reads anything", async () => {
      const { home, attachment } = readableSession();
      const adapter = new LocalTmuxFleetAdapter(home);

      // Same fixture, no signal: proves the null below is the abort and not a
      // missing/unreadable transcript.
      await expect(adapter.readTerminalHandoff(attachment)).resolves.toMatchObject({ text: "the answer" });
      spy.execFileArgs = [];
      spy.readFilePaths = [];

      await expect(adapter.readTerminalHandoff(attachment, AbortSignal.abort())).resolves.toBeNull();
      expect(spy.execFileArgs).toEqual([]);
      expect(spy.readFilePaths).toEqual([]);
    });

    it("an already-aborted signal stops isLive before it spawns tmux", async () => {
      const adapter = new LocalTmuxFleetAdapter(tmpHome());
      await expect(adapter.isLive(makeAttachment(), AbortSignal.abort())).resolves.toBe(false);
      expect(spy.execFileArgs).toEqual([]);
    });

    it("an abort that lands DURING the read comes back as null, not a rejection", async () => {
      const { home, attachment } = readableSession();
      const controller = new AbortController();
      // Fires on the meta.json read — the first read this path does — so the
      // abort lands mid-operation rather than before it starts.
      spy.onReadFile = () => controller.abort();

      const adapter = new LocalTmuxFleetAdapter(home);
      await expect(adapter.readTerminalHandoff(attachment, controller.signal)).resolves.toBeNull();
      expect(spy.readFilePaths).toHaveLength(1);
    });

    it("a live signal that never aborts changes nothing", async () => {
      const { home, attachment } = readableSession();
      const adapter = new LocalTmuxFleetAdapter(home);
      const handoff = await adapter.readTerminalHandoff(attachment, new AbortController().signal);
      expect(handoff?.text).toBe("the answer");
      expect(handoff?.resultAt).toBe(Date.parse("2026-08-03T00:00:00.000Z"));
    });

    it("passes the signal to the tmux liveness probe", async () => {
      const { home, attachment } = readableSession();
      const adapter = new LocalTmuxFleetAdapter(home);
      await adapter.isLive(attachment, new AbortController().signal);
      expect(spy.execFileArgs).toEqual([["has-session", "-t", attachment.handle]]);
    });
  });

  it.runIf(hasTmux)(
    "readTerminalHandoff returns null while the tmux session is still live, even with a readable transcript",
    async () => {
      const home = tmpHome();
      const handle = `cf-adapter-test-${Date.now()}`;
      const attachment = makeAttachment({ handle });
      const dir = join(home, handle);
      mkdirSync(dir, { recursive: true });
      const transcriptPath = join(dir, "session.jsonl");
      writeFileSync(
        transcriptPath,
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "mid-run text" }] } }),
      );
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ transcriptPath }));

      await execFileAsync("tmux", ["new-session", "-d", "-s", handle]);
      try {
        const adapter = new LocalTmuxFleetAdapter(home);
        await expect(adapter.isLive(attachment)).resolves.toBe(true);
        await expect(adapter.readTerminalHandoff(attachment)).resolves.toBeNull();
      } finally {
        await execFileAsync("tmux", ["kill-session", "-t", handle]).catch(() => {});
      }
    },
  );
});
