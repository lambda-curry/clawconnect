import { parseArgs } from "node:util";
import { REGISTRY_PATH, agentDescriptor } from "@clawconnect/core";
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
          ...agentDescriptor(a),
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
    const heading = [a.emoji, a.id].filter(Boolean).join(" ");
    console.log(`  ${heading}${tag}`);
    if (a.role) console.log(`    role:        ${a.role}`);
    if (a.description) console.log(`    description: ${a.description}`);
    if (a.whenToUse) console.log(`    when to use: ${a.whenToUse}`);
    console.log(`    url:         ${a.url}`);
    console.log(`    openclaw:    ${a.openclawAgentId}`);
    console.log("");
  }
}
