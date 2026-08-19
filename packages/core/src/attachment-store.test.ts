import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileAttachmentStore } from "./attachment-store.ts";
import type { StoreDegradation } from "./store-health.ts";
import type { SessionAttachmentState } from "./types.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpFilePath(name = "fleet.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
  dirs.push(dir);
  return join(dir, name);
}

const sample: SessionAttachmentState = {
  sessionKey: "agent:main:main:thread:s1",
  currentAttachmentId: "att-1",
  attachments: {
    "att-1": {
      id: "att-1",
      runtime: "claude-fleet",
      handle: "cf-foo",
      providerSessionId: "prov-1",
      host: "workstation-1",
      worktree: "/tmp/fleet/cf-foo/wt",
      attachedAt: 1000,
      status: "running",
    },
  },
};

describe("JsonFileAttachmentStore", () => {
  it("load() on a missing file returns an empty array, no error", () => {
    const store = new JsonFileAttachmentStore(tmpFilePath());
    expect(store.load()).toEqual([]);
  });

  it("save() then load() round-trips exactly, including a nested directory that doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "nested", "deeper", "fleet.json");
    const store = new JsonFileAttachmentStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
  });

  it("save() with an empty array overwrites a previously non-empty file", () => {
    const filePath = tmpFilePath();
    const store = new JsonFileAttachmentStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
    store.save([]);
    expect(store.load()).toEqual([]);
  });

  it("load() on corrupt JSON returns an empty array instead of throwing", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, "{ not valid json");
    const store = new JsonFileAttachmentStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("load() on a file holding a non-array JSON value returns an empty array", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));
    const store = new JsonFileAttachmentStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("never leaves a .tmp file behind after a successful save", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "fleet.json");
    new JsonFileAttachmentStore(filePath).save([sample]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  it("preserves superseded lineage across a round-trip — old records are never dropped", () => {
    const filePath = tmpFilePath();
    const withLineage: SessionAttachmentState = {
      sessionKey: "agent:main:main:thread:s2",
      currentAttachmentId: "att-2",
      attachments: {
        "att-1": { ...sample.attachments["att-1"], status: "superseded", reason: "replaced for a fresh worktree" },
        "att-2": {
          id: "att-2",
          runtime: "claude-fleet",
          handle: "cf-bar",
          host: "workstation-1",
          attachedAt: 2000,
          status: "running",
          replacesAttachmentId: "att-1",
        },
      },
    };
    const store = new JsonFileAttachmentStore(filePath);
    store.save([withLineage]);
    const reloaded = store.load();
    expect(reloaded).toEqual([withLineage]);
    expect(reloaded[0].attachments["att-1"].status).toBe("superseded");
  });
});

/**
 * Same rule as the job store, and it matters more here: this store holds
 * every session that has ever attached, so a silent empty load discards
 * lineage rather than only work currently in flight.
 */
describe("JsonFileAttachmentStore: an unreadable file is preserved, a missing one is not a failure", () => {
  it("a missing file loads empty, reports no degradation, and saves normally afterwards", () => {
    const filePath = tmpFilePath();
    const seen: StoreDegradation[] = [];
    const store = new JsonFileAttachmentStore(filePath, (d) => seen.push(d));
    expect(store.load()).toEqual([]);
    expect(seen).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
  });

  it("corrupt JSON is preserved under a timestamped name, and a later save cannot destroy it", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, "{ not valid json");
    const seen: StoreDegradation[] = [];
    const store = new JsonFileAttachmentStore(filePath, (d) => seen.push(d));

    expect(store.load()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("attachment");
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe("{ not valid json");
    expect(existsSync(filePath)).toBe(false);

    store.save([sample]);
    expect(store.load()).toEqual([sample]);
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe("{ not valid json");
  });

  it("a file holding valid JSON that is not an array is treated as unreadable too", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));
    const seen: StoreDegradation[] = [];
    expect(new JsonFileAttachmentStore(filePath, (d) => seen.push(d)).load()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(readFileSync(seen[0].preservedAs as string, "utf8")).toBe('{"not":"an array"}');
  });

  it("a valid file still loads unchanged, and reports nothing", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify([sample]));
    const seen: StoreDegradation[] = [];
    expect(new JsonFileAttachmentStore(filePath, (d) => seen.push(d)).load()).toEqual([sample]);
    expect(seen).toEqual([]);
  });

  it("refuses to save at all when the unreadable file could not even be preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "attachments.json");
    writeFileSync(filePath, "{ not valid json");
    chmodSync(dir, 0o500);

    const seen: StoreDegradation[] = [];
    const store = new JsonFileAttachmentStore(filePath, (d) => seen.push(d));
    expect(store.load()).toEqual([]);
    expect(seen[0].preservedAs).toBeUndefined();

    // Writable again, so the refusal below is the store's rule rather than
    // the filesystem's.
    chmodSync(dir, 0o700);
    store.save([sample]);
    expect(readFileSync(filePath, "utf8")).toBe("{ not valid json");
  });
});
