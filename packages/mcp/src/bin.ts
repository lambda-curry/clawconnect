#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.ts";

const url = process.env.OPENCLAW_URL;
const token = process.env.OPENCLAW_PASSWORD;
const agentId = process.env.OPENCLAW_AGENT_ID?.trim() ?? "main";

if (!url || !token) {
  console.error("clawconnect-mcp: OPENCLAW_URL and OPENCLAW_PASSWORD are required.");
  console.error("Set them as environment variables in your MCP server config.");
  process.exit(1);
}

const { server } = createMcpServer({ url, token, agentId });
const transport = new StdioServerTransport();
await server.connect(transport);
