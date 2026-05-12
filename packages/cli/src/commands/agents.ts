import { parseArgs } from "node:util";
import { REGISTRY_PATH } from "@clawconnect/core";
import { loadRegistry } from "../config.ts";

export async function agentsCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect agents [--json]");
    console.log("Lists OpenClaw agents configured for this CLI.");
    process.exit(0);
  }

  const registry = loadRegistry();

  if (values.json) {
    console.log(
      JSON.stringify({
        default: registry.default,
        source: registry.source,
        registryPath: REGISTRY_PATH,
        agents: registry.agents.map((a) => ({
          id: a.id,
          url: a.url,
          openclawAgentId: a.openclawAgentId,
        })),
      }),
    );
    return;
  }

  const sourceNote = registry.source === "file" ? REGISTRY_PATH : "(env fallback — OPENCLAW_URL/OPENCLAW_PASSWORD)";
  console.log(`Configured agents (source: ${sourceNote})`);
  console.log("");
  for (const a of registry.agents) {
    const tag = a.id === registry.default ? " [default]" : "";
    console.log(`  ${a.id}${tag}`);
    console.log(`    url:    ${a.url}`);
    console.log(`    agent:  ${a.openclawAgentId}`);
  }
}
