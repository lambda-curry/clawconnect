import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "@clawconnect/core";

const CONFIG_DIR = join(homedir(), ".clawconnect");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface FileConfig {
  url?: string;
  token?: string;
  agentId?: string;
}

function loadFileConfig(): FileConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

export function loadConfig(): GatewayConfig & { agentId: string } {
  const file = loadFileConfig();

  const url = process.env.OPENCLAW_URL ?? file.url;
  const token = process.env.OPENCLAW_PASSWORD ?? file.token;
  const agentId = process.env.OPENCLAW_AGENT_ID?.trim() ?? file.agentId ?? "main";

  if (!url) {
    console.error("Error: OPENCLAW_URL is required. Set it via environment variable or ~/.clawconnect/config.json");
    process.exit(3);
  }
  if (!token) {
    console.error(
      "Error: OPENCLAW_PASSWORD is required. Set it via environment variable or ~/.clawconnect/config.json",
    );
    process.exit(3);
  }

  return { url, token, agentId };
}
