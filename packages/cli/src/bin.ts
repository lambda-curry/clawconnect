#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runCommand } from "./commands/run.ts";
import { statusCommand } from "./commands/status.ts";
import { logsCommand } from "./commands/logs.ts";
import { sessionsCommand } from "./commands/sessions.ts";

const HELP = `
clawconnect — Connect AI coding assistants to OpenClaw

Usage:
  clawconnect run <task> [options]    Submit a task to OpenClaw
  clawconnect status <job-id>         Check job status
  clawconnect logs <job-id>           Show job logs
  clawconnect sessions                List active sessions

Options:
  --json         Output machine-readable JSON
  --help, -h     Show this help

Run 'clawconnect <command> --help' for command-specific options.

Config:
  Set OPENCLAW_URL and OPENCLAW_PASSWORD as environment variables,
  or create ~/.clawconnect/config.json with { "url": "...", "token": "..." }
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
  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'clawconnect --help' for usage.`);
    process.exit(1);
}
