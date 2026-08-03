import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTmuxFleetAdapter } from "./fleet-adapter.ts";
import type { FleetAttachmentRecord } from "./types.ts";

const execFileAsync = promisify(execFile);

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

function makeAttachment(overrides: Partial<FleetAttachmentRecord> = {}): FleetAttachmentRecord {
  return {
    id: "att-1",
    runtime: "claude-fleet",
    handle: "cf-nonexistent-handle-for-tests",
    host: "minip3",
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
