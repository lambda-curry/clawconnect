import { loadAgentRegistry, resolveAgent } from "@clawconnect/core";
import type { AgentEntry, AgentRegistry } from "@clawconnect/core";

export function loadRegistry(): AgentRegistry {
  try {
    return loadAgentRegistry();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error(
      `Create ~/.clawconnect/agents.json (recommended) or set OPENCLAW_URL + OPENCLAW_PASSWORD.`,
    );
    process.exit(3);
  }
}

export function loadAgent(idOrUndefined?: string): { registry: AgentRegistry; agent: AgentEntry } {
  const registry = loadRegistry();
  try {
    return { registry, agent: resolveAgent(registry, idOrUndefined) };
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(3);
  }
}
