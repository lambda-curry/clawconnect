import "dotenv/config";
import { createServer } from "node:http";

// Process-level safety net: a bug anywhere in a fire-and-forget Promise (e.g.,
// the background long-poll / lazy re-check in SessionManager) would otherwise
// kill the connector via unhandledRejection / uncaughtException. launchd
// kickstarts it back up, but the in-memory jobs map is gone — every active
// run lands at "Task state not found for that session." Log loudly and keep
// the process up. See the f873d89 incident (totalMs ReferenceError took the
// connector down mid-long-poll for an active discovery run).
process.on("unhandledRejection", (reason) => {
  console.error("[connector] unhandledRejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[connector] uncaughtException (kept alive):", err);
});

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentRegistry, loadAgentSessionRuntimes } from "@clawconnect/core";
import type { AgentRegistry } from "@clawconnect/core";
import { createApp } from "./app.js";

// Build identity, resolved at BOOT (see get_connection_info).
//
// This was first written by a build step, which the build cache promptly
// defeated: the stamp script's own inputs had not changed, so a cache hit
// replayed the previous commit's SHA into an artifact built from a newer one
// — a build identity confidently reporting the wrong commit, which is the
// exact failure it exists to prevent and worse than reporting nothing.
//
// Reading it at process start cannot be cached. What it reports is the commit
// the deployed checkout is on, which for a build-then-restart deploy is the
// code now running. An explicit CLAWCONNECT_BUILD_SHA still wins, for
// deployments that ship an artifact with no repository beside it; with
// neither, get_connection_info reports "unknown" rather than guessing.
if (!process.env.CLAWCONNECT_BUILD_SHA) {
  try {
    process.env.CLAWCONNECT_BUILD_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No repository to ask — an installed package or a container built from a
    // tarball. "unknown" is the honest answer.
  }
}

// Try the shared multi-agent registry (~/.clawconnect/agents.json) first.
// Fall back to env-only single-agent so existing deployments keep working.
let registry: AgentRegistry;
try {
  registry = loadAgentRegistry();
  console.log(
    `[chatgpt-app] loaded ${registry.agents.length} agent(s) from ${registry.source} (default=${registry.default}, agents=${registry.agents.map((a) => a.id).join(",")})`,
  );
} catch (err) {
  const url = process.env.OPENCLAW_URL;
  const password = process.env.OPENCLAW_PASSWORD;
  if (!url || !password) {
    console.error(`[chatgpt-app] no registry: ${(err as Error).message}`);
    process.exit(1);
  }
  const singleAgentId = process.env.CLAWCONNECT_AGENT_ALIAS?.trim() || "default";
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID?.trim() || "main";
  registry = {
    default: singleAgentId,
    source: "env",
    agents: [{ id: singleAgentId, url, password, openclawAgentId }],
    groups: {},
    groupLabels: {},
  };
  console.log(`[chatgpt-app] env fallback registry: single agent "${singleAgentId}"`);
}

// The host's managed-agent-session runtimes, if this deployment configured any
// (CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES — see core's runtime-modules.ts).
// Without it the registry option on createApp is decorative in production:
// nothing in a shipped binary could ever supply one. Unset, no runtime is
// reachable — the default install — and every MCP tool behaves identically.
const agentSessionRuntimes = await loadAgentSessionRuntimes();

const { requestListener } = createApp(registry, { agentSessionRuntimes });

const server = createServer(requestListener);
const port = Number(process.env.PORT || 7331);
server.timeout = 0;
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
