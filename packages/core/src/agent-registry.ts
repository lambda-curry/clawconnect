import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_FILE = join(homedir(), ".clawconnect", "agents.json");

export interface AgentEntry {
  id: string;
  url: string;
  password: string;
  openclawAgentId: string;
}

interface AgentEntryInput {
  id?: unknown;
  url?: unknown;
  password?: unknown;
  openclawAgentId?: unknown;
}

interface RegistryFile {
  default?: unknown;
  agents?: unknown;
}

export interface AgentRegistry {
  default: string;
  agents: AgentEntry[];
  source: "file" | "env";
}

function readEnvFallback(): AgentRegistry | undefined {
  const url = process.env.OPENCLAW_URL;
  const password = process.env.OPENCLAW_PASSWORD;
  if (!url || !password) return undefined;
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID?.trim() || "main";
  const id = process.env.CLAWCONNECT_AGENT_ALIAS?.trim() || openclawAgentId || "main";
  return {
    default: id,
    agents: [{ id, url, password, openclawAgentId }],
    source: "env",
  };
}

function parseEntry(raw: AgentEntryInput, index: number): AgentEntry {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const password = typeof raw.password === "string" ? raw.password : "";
  const openclawAgentId =
    typeof raw.openclawAgentId === "string" && raw.openclawAgentId.trim().length > 0
      ? raw.openclawAgentId.trim()
      : "main";
  if (!id) throw new Error(`agents.json: entry #${index} missing "id"`);
  if (!url) throw new Error(`agents.json: entry "${id}" missing "url"`);
  if (!password) throw new Error(`agents.json: entry "${id}" missing "password"`);
  return { id, url, password, openclawAgentId };
}

export function loadAgentRegistry(): AgentRegistry {
  if (existsSync(REGISTRY_FILE)) {
    let raw: RegistryFile;
    try {
      raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as RegistryFile;
    } catch (err) {
      throw new Error(`Failed to parse ${REGISTRY_FILE}: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
      throw new Error(`agents.json: "agents" must be a non-empty array`);
    }
    const agents = raw.agents.map((entry, i) => parseEntry(entry as AgentEntryInput, i));
    const seen = new Set<string>();
    for (const a of agents) {
      if (seen.has(a.id)) throw new Error(`agents.json: duplicate agent id "${a.id}"`);
      seen.add(a.id);
    }
    const defaultId = typeof raw.default === "string" && raw.default.trim().length > 0 ? raw.default.trim() : agents[0]!.id;
    if (!agents.find((a) => a.id === defaultId)) {
      throw new Error(`agents.json: "default" = "${defaultId}" does not match any agent id`);
    }
    return { default: defaultId, agents, source: "file" };
  }
  const env = readEnvFallback();
  if (env) return env;
  throw new Error(
    `No ClawConnect agent config found. Create ~/.clawconnect/agents.json or set OPENCLAW_URL + OPENCLAW_PASSWORD.`,
  );
}

export function resolveAgent(registry: AgentRegistry, idOrUndefined?: string): AgentEntry {
  const wanted = idOrUndefined?.trim();
  if (!wanted) {
    const def = registry.agents.find((a) => a.id === registry.default);
    if (!def) throw new Error(`Internal: default agent "${registry.default}" not in registry`);
    return def;
  }
  const found = registry.agents.find((a) => a.id === wanted);
  if (!found) {
    const known = registry.agents.map((a) => a.id).join(", ");
    throw new Error(`Unknown agent "${wanted}". Configured agents: ${known}`);
  }
  return found;
}

export const REGISTRY_PATH = REGISTRY_FILE;
