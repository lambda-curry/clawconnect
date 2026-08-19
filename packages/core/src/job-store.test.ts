import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileJobStore, type PersistedJob } from "./job-store.ts";
import type { StoreDegradation } from "./store-health.ts";

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

  it("never leaves a .tmp file behind after a successful save", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "jobs.json");
    new JsonFileJobStore(filePath).save([sample]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });
});

/**
 * A failed load used to answer `[]` and log one line to stderr. The next save
 * — a whole-map overwrite — then wrote the truncated set over the only file
 * that could have shown what was lost, so the evidence destroyed itself and
 * every in-flight job at restart was orphaned silently.
 *
 * The rule these cover: MISSING means empty (a fact); UNREADABLE means the
 * file is preserved before anything can overwrite it, and the degradation is
 * reported to whoever wired the store up.
 */
describe("JsonFileJobStore: an unreadable file is preserved, a missing one is not a failure", () => {
  it("a missing file loads empty, reports no degradation, and saves normally afterwards", () => {
    const filePath = tmpFilePath();
    const seen: StoreDegradation[] = [];
    const store = new JsonFileJobStore(filePath, (d) => seen.push(d));
    expect(store.load()).toEqual([]);
    expect(seen).toEqual([]);
    // No side effects: absence is not an error, so nothing was written either.
    expect(existsSync(filePath)).toBe(false);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
  });

  it("corrupt JSON is preserved under a timestamped name, and a later save cannot destroy it", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, "{ not valid json");
    const seen: StoreDegradation[] = [];
    const store = new JsonFileJobStore(filePath, (d) => seen.push(d));

    expect(store.load()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("job");
    expect(seen[0].preservedAs).toBeDefined();
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe("{ not valid json");
    // Moved aside, not copied — nothing is left at the original path to be
    // silently overwritten.
    expect(existsSync(filePath)).toBe(false);

    // The save that would previously have shredded the evidence.
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe("{ not valid json");
  });

  it("a file holding valid JSON that is not an array is treated as unreadable too", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));
    const seen: StoreDegradation[] = [];
    expect(new JsonFileJobStore(filePath, (d) => seen.push(d)).load()).toEqual([]);
    // Whatever this file is, it is not this store's contents — and answering
    // `[]` for it erases it exactly the way a syntax error did.
    expect(seen).toHaveLength(1);
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe('{"not":"an array"}');
  });

  it("a valid file still loads unchanged, and reports nothing", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify([sample]));
    const seen: StoreDegradation[] = [];
    expect(new JsonFileJobStore(filePath, (d) => seen.push(d)).load()).toEqual([sample]);
    expect(seen).toEqual([]);
  });

  it("refuses to save at all when the unreadable file could not even be preserved", () => {
    // Preservation fails here WITHOUT depending on the effective user: the
    // preserved name is the original plus a ~33-character suffix, so a
    // basename already near the filesystem's limit cannot grow one and the
    // rename fails ENAMETOOLONG for anybody. The earlier version made the
    // parent directory read-only, which a root process writes straight
    // through — the rename would then succeed and this test would fail for an
    // environmental reason rather than a real one. It also had to restore the
    // mode afterwards, and a failing assertion before that line left the
    // directory unremovable for the rest of the run.
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-jobstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, `${"j".repeat(240)}.json`);
    writeFileSync(filePath, "{ not valid json");

    const seen: StoreDegradation[] = [];
    const store = new JsonFileJobStore(filePath, (d) => seen.push(d));
    expect(store.load()).toEqual([]);
    expect(seen).toHaveLength(1);
    // The discriminating assertion: preservation was ATTEMPTED and failed.
    expect(seen[0].preservedAs).toBeUndefined();
    expect(seen[0].message).toMatch(/could not be preserved/i);

    store.save([sample]);
    // Untouched — the save was refused, not attempted and half-done.
    expect(readFileSync(filePath, "utf8")).toBe("{ not valid json");
  });
});
