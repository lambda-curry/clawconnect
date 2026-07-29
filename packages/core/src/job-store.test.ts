import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileJobStore, type PersistedJob } from "./job-store.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpFilePath(name = "jobs.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-test-"));
  dirs.push(dir);
  return join(dir, name);
}

const sample: PersistedJob = {
  jobId: "j1",
  sessionKey: "s1",
  startedAt: 1000,
  lastEventAt: 2000,
  pollCount: 3,
  prompt: { task: "do the thing", context: "ctx", senderName: "jake" },
};

describe("JsonFileJobStore", () => {
  it("load() on a missing file returns an empty array, no error", () => {
    const store = new JsonFileJobStore(tmpFilePath());
    expect(store.load()).toEqual([]);
  });

  it("save() then load() round-trips exactly, including a nested directory that doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "nested", "deeper", "jobs.json");
    const store = new JsonFileJobStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
  });

  it("save() with an empty array overwrites a previously non-empty file — a job that went terminal actually disappears", () => {
    const filePath = tmpFilePath();
    const store = new JsonFileJobStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
    store.save([]);
    expect(store.load()).toEqual([]);
  });

  it("load() on corrupt JSON returns an empty array instead of throwing", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, "{ not valid json");
    const store = new JsonFileJobStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("load() on a file containing a non-array JSON value returns an empty array", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));
    const store = new JsonFileJobStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("never leaves a .tmp file behind after a successful save", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "jobs.json");
    new JsonFileJobStore(filePath).save([sample]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });
});
