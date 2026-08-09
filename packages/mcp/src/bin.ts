#!/usr/bin/env node
// Process-level safety net: a bug in a fire-and-forget Promise (e.g., the
// background long-poll / lazy re-check in SessionManager) would otherwise
// crash the MCP subprocess. The host (Claude Code) would have to reconnect,
// and the in-memory jobs map is gone — active runs land at "Task state not
// found for that session." Log loudly and keep the process up.
process.on("unhandledRejection", (reason) => {
  console.error("[mcp] unhandledRejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[mcp] uncaughtException (kept alive):", err);
});

import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentRegistry, loadAgentSessionRuntimes } from "@clawconnect/core";
import { serveClawConnectStdio } from "./stdio.ts";

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

// Managed-session wiring, both halves of it (see core's runtime-modules.ts and
// attachment-store.ts). Absent CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES
// this is exactly the previous behavior — claude-fleet only — and the store
// directory is inert until something actually attaches.
const agentSessionRuntimes = await loadAgentSessionRuntimes();
const attachmentStoreDir =
  process.env.CLAWCONNECT_ATTACHMENT_STORE_DIR?.trim() ||
  join(homedir(), ".clawconnect", "attachments");

// serveStdio owns the opening exchange: a 2026-07-28 server/discover probe
// selects the modern per-request-envelope era, while initialize (or another
// claim-less opening) explicitly falls back to the legacy 2025-era protocol.
// One factory instance is then pinned for the lifetime of this stdio
// connection, preserving the server-owned task pool across calls.
serveClawConnectStdio(
  { registry, agentSessionRuntimes, attachmentStoreDir },
  {
    onerror: (error) => console.error("[mcp] stdio serving error:", error),
  },
);
