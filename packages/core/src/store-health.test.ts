import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapabilities } from "./capability.ts";
import { GatewayPool } from "./gateway-pool.ts";
import type { AgentRegistry } from "./agent-registry.ts";

/**
 * A degraded store used to be visible in exactly one place: a stderr line
 * nobody reads. The consequence was that after a restart with an unreadable
 * job file, every in-flight task was orphaned and the ONLY in-band evidence
 * was the absence of tasks — indistinguishable from there having been none.
 *
 * These cover the path from the store's own failure to the surface a
 * supervisor actually calls when something looks inconsistent.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-storehealth-test-"));
  dirs.push(dir);
  return dir;
}

function registry(): AgentRegistry {
  return {
    default: "test-agent",
    source: "env",
    groups: {},
    groupLabels: {},
    agents: [{ id: "test-agent", url: "ws://fake", password: "fake", openclawAgentId: "main" }],
  };
}

function connectionInfo(pool: GatewayPool): Record<string, unknown> {
  const capability = buildCapabilities({
    pool,
    registry: registry(),
    scope: { allowedIds: ["test-agent"], defaultId: "test-agent", serverName: "ClawConnect" },
    identity: { user: null },
    defaultCheckMode: "wait",
    protocol: () => ({ era: "modern", version: "2026-07-28" }),
  }).find((c) => c.name === "get_connection_info");
  const result = capability?.handler({}) as { structuredContent?: Record<string, unknown> };
  return result.structuredContent ?? {};
}

describe("a store that could not be read reaches a surface a supervisor reads", () => {
  it("get_connection_info omits degradedStores entirely when every store loaded", () => {
    const pool = new GatewayPool(registry(), tmpDir());
    pool.warmAll();
    expect(pool.storeHealth()).toEqual([]);
    // Omitted rather than reported empty, so its PRESENCE is the signal — a
    // field that is always there and usually empty is one a reader skips.
    expect(connectionInfo(pool)).not.toHaveProperty("degradedStores");
  });

  it("reports the job store that failed, and where its contents were preserved", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "test-agent.json"), "{ not valid json");
    const pool = new GatewayPool(registry(), dir);
    pool.warmAll();

    const degraded = connectionInfo(pool).degradedStores as { kind: string; preservedAs?: string }[];
    expect(degraded).toHaveLength(1);
    expect(degraded[0].kind).toBe("job");
    expect(degraded[0].preservedAs).toMatch(/test-agent\.json\.corrupt-/);
  });

  it("reports the attachment store too, and both at once when both failed", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "test-agent.json"), "{ not valid json");
    writeFileSync(join(dir, "test-agent.attachments.json"), "also not valid");
    const pool = new GatewayPool(registry(), dir);
    pool.warmAll();

    const degraded = connectionInfo(pool).degradedStores as { kind: string }[];
    expect(degraded.map((d) => d.kind).sort()).toEqual(["attachment", "job"]);
  });
});
