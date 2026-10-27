import { spawnSync } from "node:child_process";
import { expect, it } from "vite-plus/test";

it("releases input and output schemas after per-request servers are closed", () => {
  // A separate process gives this check real GC without changing the test runner.
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { setImmediate } from "node:timers/promises";
    import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
    import { registerCapability } from ${JSON.stringify(new URL("../dist/index.mjs", import.meta.url).href)};

    async function registerAndClose(index) {
      const server = new McpServer({ name: "schema-retention-test", version: "0.0.0" });
      const inputSchema = {
        type: "object",
        properties: { agent: { type: "string", enum: ["agent-" + index] } },
        required: ["agent"],
      };
      const outputSchema = {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      };
      registerCapability(server, {
        name: "test_tool",
        title: "Test tool",
        description: "READ ONLY: test schema lifetime.",
        inputSchema,
        outputSchema,
        annotations: { title: "Test tool", readOnlyHint: true, destructiveHint: false },
        mutates: false,
        handler: async () => ({ structuredContent: { result: "ok" } }),
      });
      await server.close();
      return [new WeakRef(server), new WeakRef(inputSchema), new WeakRef(outputSchema)];
    }

    const refs = [];
    for (let i = 0; i < 40; i++) refs.push(...await registerAndClose(i));
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      global.gc();
    }
    assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0,
      "closed request servers and their compiled schemas must be collectible");
  `,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
