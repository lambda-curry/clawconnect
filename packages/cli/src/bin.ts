#!/usr/bin/env node
import { runCommand } from "./commands/run.ts";
import { statusCommand } from "./commands/status.ts";
import { logsCommand } from "./commands/logs.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { agentsCommand } from "./commands/agents.ts";

const HELP = `
clawconnect — Connect AI coding assistants to OpenClaw

Usage:
  clawconnect run <task> [options]            Submit a task to an OpenClaw agent
  clawconnect status <job-id> [options]       Check job status
  clawconnect logs <job-id> [options]         Show job logs
  clawconnect sessions [options]              List active sessions
  clawconnect agents                          List configured agents

Common options:
  --agent <id>   Target agent alias (default: registry default)
  --json         Output machine-readable JSON
  --help, -h     Show this help

Run 'clawconnect <command> --help' for command-specific options.

Config:
  Preferred: ~/.clawconnect/agents.json
    {
      "default": "assistant",
      "agents": [
        { "id": "assistant", "url": "...", "password": "...", "openclawAgentId": "main" }
      ]
    }
  Fallback: OPENCLAW_URL + OPENCLAW_PASSWORD (+ optional OPENCLAW_AGENT_ID, CLAWCONNECT_AGENT_ALIAS).
`.trim();

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case "run":
    await runCommand(args.slice(1));
    break;
  case "status":
    await statusCommand(args.slice(1));
    break;
  case "logs":
    await logsCommand(args.slice(1));
    break;
  case "sessions":
    await sessionsCommand(args.slice(1));
    break;
  case "agents":
    await agentsCommand(args.slice(1));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'clawconnect --help' for usage.`);
    process.exit(1);
}
