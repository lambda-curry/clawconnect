#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAgentRegistry } from "@clawconnect/core";
import { createMcpServer } from "./server.ts";

let registry;
try {
  registry = loadAgentRegistry();
} catch (err) {
  console.error(`clawconnect-mcp: ${(err as Error).message}`);
  console.error("Create ~/.clawconnect/agents.json or set OPENCLAW_URL + OPENCLAW_PASSWORD.");
  process.exit(1);
}

console.error(
  `clawconnect-mcp: loaded ${registry.agents.length} agent(s) from ${registry.source} ` +
    `(default=${registry.default}, agents=${registry.agents.map((a) => a.id).join(",")})`,
);

const { server } = createMcpServer({ registry });
const transport = new StdioServerTransport();
await server.connect(transport);
