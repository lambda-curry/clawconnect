import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_FILE = join(homedir(), ".clawconnect", "agents.json");

export interface AgentEntry {
  id: string;
  url: string;
  password: string;
  openclawAgentId: string;
  /** Display emoji (e.g. "🦀"). Optional. */
  emoji?: string;
  /** Short role label (e.g. "personal assistant", "design engineer"). Optional. */
  role?: string;
  /** 1-2 sentence description shown by list_agents. Optional. */
  description?: string;
  /** Guidance for when a caller AI should pick this agent over others. Optional. */
  whenToUse?: string;
  /** QMD HTTP endpoint this agent's memory lives behind. Defaults to http://127.0.0.1:18790. */
  qmdUrl?: string;
  /** QMD auth token scoped to this agent (e.g. "qmd-<agent>-..."). Required for memory tools to work. */
  qmdToken?: string;
  /** User-visible list of QMD collections this agent can search. Hint only — QMD enforces access via qmdToken. */
  collections?: string[];
}

interface AgentEntryInput {
  id?: unknown;
  url?: unknown;
  password?: unknown;
  openclawAgentId?: unknown;
  emoji?: unknown;
  role?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  qmdUrl?: unknown;
  qmdToken?: unknown;
  collections?: unknown;
}

interface RegistryFile {
  default?: unknown;
  agents?: unknown;
  groups?: unknown;
  groupLabels?: unknown;
}

export interface AgentRegistry {
  default: string;
  agents: AgentEntry[];
  /**
   * Named agent groups. A connection can pin a group with `?group=lc-labs`
   * instead of spelling out `?agents=dexter,meg,samwise,buzz` — so group
   * membership is edited server-side without anyone re-pasting their URL.
   */
  groups: Record<string, string[]>;
  /**
   * Optional display name per group, surfaced as the MCP server name when a
   * connection is scoped to that group — so multiple connectors added to the
   * same client are distinguishable (e.g. "Bakery ClawConnect"). Groups with
   * no label fall back to the generic "ClawConnect".
   */
  groupLabels: Record<string, string>;
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
    groups: {},
    groupLabels: {},
    source: "env",
  };
}

/** Parse the optional `groupLabels` map: group name → display string. */
function parseGroupLabels(raw: unknown, groupNames: Set<string>): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, label] of Object.entries(raw as Record<string, unknown>)) {
    const key = name.trim();
    if (!key) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    if (!groupNames.has(key)) {
      console.warn(`agents.json: groupLabels references unknown group "${key}" — ignored`);
      continue;
    }
    out[key] = label.trim();
  }
  return out;
}

/**
 * Parse the optional `groups` map. Members that aren't known agent ids are
 * dropped with a warning (so a typo doesn't silently widen access — the
 * group just gets smaller). Empty/invalid groups are dropped entirely.
 */
function parseGroups(raw: unknown, agentIds: Set<string>): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(raw as Record<string, unknown>)) {
    const key = name.trim();
    if (!key) continue;
    if (!Array.isArray(members)) {
      console.warn(`agents.json: group "${key}" is not an array — skipped`);
      continue;
    }
    const resolved: string[] = [];
    for (const m of members) {
      if (typeof m !== "string") continue;
      const id = m.trim();
      if (!id) continue;
      if (!agentIds.has(id)) {
        console.warn(`agents.json: group "${key}" references unknown agent "${id}" — dropped`);
        continue;
      }
      if (!resolved.includes(id)) resolved.push(id);
    }
    if (resolved.length === 0) {
      console.warn(`agents.json: group "${key}" has no valid members — skipped`);
      continue;
    }
    out[key] = resolved;
  }
  return out;
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
  const optString = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const collections = Array.isArray(raw.collections)
    ? raw.collections.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim())
    : undefined;
  return {
    id,
    url,
    password,
    openclawAgentId,
    emoji: optString(raw.emoji),
    role: optString(raw.role),
    description: optString(raw.description),
    whenToUse: optString(raw.whenToUse),
    qmdUrl: optString(raw.qmdUrl),
    qmdToken: optString(raw.qmdToken),
    collections: collections && collections.length > 0 ? collections : undefined,
  };
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
    const groups = parseGroups(raw.groups, new Set(agents.map((a) => a.id)));
    const groupLabels = parseGroupLabels(raw.groupLabels, new Set(Object.keys(groups)));
    return { default: defaultId, agents, groups, groupLabels, source: "file" };
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

/**
 * Compact one-line label for an agent — `id (emoji role)` if role/emoji are
 * known, else just `id`. Used in tool-schema enum descriptions so a calling
 * AI sees who's who at the same surface where it picks an agent.
 */
export function agentBlurb(entry: AgentEntry): string {
  const parts: string[] = [];
  if (entry.emoji) parts.push(entry.emoji);
  if (entry.role) parts.push(entry.role);
  return parts.length === 0 ? entry.id : `${entry.id} (${parts.join(" ")})`;
}

/** Plain object describing an agent for the list_agents MCP tool. */
export function agentDescriptor(entry: AgentEntry) {
  return {
    id: entry.id,
    emoji: entry.emoji,
    role: entry.role,
    description: entry.description,
    whenToUse: entry.whenToUse,
    memorySearchable: Boolean(entry.qmdToken),
    collections: entry.collections,
  };
}
