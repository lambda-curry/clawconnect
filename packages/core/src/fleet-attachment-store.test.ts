import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileFleetAttachmentStore } from "./fleet-attachment-store.ts";
import type { SessionFleetState } from "./types.ts";

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

const sample: SessionFleetState = {
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

describe("JsonFileFleetAttachmentStore", () => {
  it("load() on a missing file returns an empty array, no error", () => {
    const store = new JsonFileFleetAttachmentStore(tmpFilePath());
    expect(store.load()).toEqual([]);
  });

  it("save() then load() round-trips exactly, including a nested directory that doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "nested", "deeper", "fleet.json");
    const store = new JsonFileFleetAttachmentStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
  });

  it("save() with an empty array overwrites a previously non-empty file", () => {
    const filePath = tmpFilePath();
    const store = new JsonFileFleetAttachmentStore(filePath);
    store.save([sample]);
    expect(store.load()).toEqual([sample]);
    store.save([]);
    expect(store.load()).toEqual([]);
  });

  it("load() on corrupt JSON returns an empty array instead of throwing", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, "{ not valid json");
    const store = new JsonFileFleetAttachmentStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("load() on a file containing a non-array JSON value returns an empty array", () => {
    const filePath = tmpFilePath();
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));
    const store = new JsonFileFleetAttachmentStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("never leaves a .tmp file behind after a successful save", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawconnect-fleetstore-test-"));
    dirs.push(dir);
    const filePath = join(dir, "fleet.json");
    new JsonFileFleetAttachmentStore(filePath).save([sample]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  it("preserves superseded lineage across a round-trip — old records are never dropped", () => {
    const filePath = tmpFilePath();
    const withLineage: SessionFleetState = {
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
    const store = new JsonFileFleetAttachmentStore(filePath);
    store.save([withLineage]);
    const reloaded = store.load();
    expect(reloaded).toEqual([withLineage]);
    expect(reloaded[0].attachments["att-1"].status).toBe("superseded");
  });
});
