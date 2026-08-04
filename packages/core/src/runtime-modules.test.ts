import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentSessionRuntimes, RUNTIME_MODULES_ENV } from "./runtime-modules.ts";

/**
 * The wiring step that makes the callback seam reachable from a shipped
 * binary. ClawConnect knows nothing about any runtime here — a module the
 * operator names does the registering, and everything runtime-specific stays
 * on its side of the boundary.
 */

const dirs: string[] = [];

function moduleFile(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-runtime-mod-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const silent = { log: () => {} };

describe("loading host-registered runtimes", () => {
  it("registers what a module's registerAgentSessionRuntimes hook asks for", async () => {
    const path = moduleFile(
      "hostRuntime-bridge.mjs",
      `export function registerAgentSessionRuntimes(registry) {
         registry.register({ id: "example-runtime", provider: "anthropic-claude-code", inspect: async () => ({ state: "running" }) });
       }`,
    );

    const registry = await loadAgentSessionRuntimes(path, silent);
    expect(registry?.ids()).toEqual(["example-runtime"]);
    // Capabilities stay DERIVED from the callbacks the module actually gave.
    expect(registry?.get("example-runtime")?.capabilities).toEqual({ inspect: true, continue: false, detach: false });
  });

  it("accepts a default export, several modules at once, and a relative specifier", async () => {
    const first = moduleFile(
      "one.mjs",
      `export default (registry) => registry.register({ id: "runtime-one", provider: "p", inspect: async () => ({}) });`,
    );
    const second = moduleFile(
      "two.mjs",
      `export function registerAgentSessionRuntimes(registry) {
         registry.register({ id: "runtime-two", provider: "p", inspect: async () => ({}) });
       }`,
    );
    const baseDir = second.slice(0, second.lastIndexOf("/"));

    const registry = await loadAgentSessionRuntimes(`${first}, ./two.mjs`, { ...silent, baseDir });
    expect(registry?.ids().sort()).toEqual(["runtime-one", "runtime-two"]);
  });

  it("returns undefined — claude-fleet only — when nothing is configured", async () => {
    expect(await loadAgentSessionRuntimes(undefined, silent)).toBeUndefined();
    expect(await loadAgentSessionRuntimes("", silent)).toBeUndefined();
    expect(await loadAgentSessionRuntimes("   ", silent)).toBeUndefined();
  });

  it("never lets a broken integration stop the connector from starting", async () => {
    const logs: string[] = [];
    const throwing = moduleFile("boom.mjs", `export function registerAgentSessionRuntimes() { throw new Error("no credentials"); }`);
    const empty = moduleFile("nothing.mjs", `export const notARegistrar = 1;`);
    const good = moduleFile(
      "good.mjs",
      `export function registerAgentSessionRuntimes(registry) {
         registry.register({ id: "still-here", provider: "p", inspect: async () => ({}) });
       }`,
    );

    const registry = await loadAgentSessionRuntimes(
      `${throwing},/nope/does-not-exist.mjs,${empty},${good}`,
      { log: (m) => logs.push(m) },
    );

    // One module's failure does not take the others with it.
    expect(registry?.ids()).toEqual(["still-here"]);
    expect(logs.join("\n")).toContain("no credentials");
    expect(logs.join("\n")).toContain("does-not-exist.mjs");
    expect(logs.join("\n")).toContain("exports no registerAgentSessionRuntimes");
  });

  it("reports nothing reachable when the configured modules register nothing", async () => {
    const empty = moduleFile("silent.mjs", `export function registerAgentSessionRuntimes() {}`);
    expect(await loadAgentSessionRuntimes(empty, silent)).toBeUndefined();
  });

  it("reads the deployment's env var by default", async () => {
    const path = moduleFile(
      "env.mjs",
      `export function registerAgentSessionRuntimes(registry) {
         registry.register({ id: "from-env", provider: "p", inspect: async () => ({}) });
       }`,
    );
    const previous = process.env[RUNTIME_MODULES_ENV];
    process.env[RUNTIME_MODULES_ENV] = path;
    try {
      const registry = await loadAgentSessionRuntimes(undefined, silent);
      expect(registry?.ids()).toEqual(["from-env"]);
    } finally {
      if (previous === undefined) delete process.env[RUNTIME_MODULES_ENV];
      else process.env[RUNTIME_MODULES_ENV] = previous;
    }
  });
});
