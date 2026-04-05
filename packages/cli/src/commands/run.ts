import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadConfig } from "../config.ts";
import { formatJobResult, progressLine, progressDone } from "../output.ts";

const HELP = `
clawconnect run — Submit a task to OpenClaw

Usage:
  clawconnect run <task> [options]
  clawconnect run "fix the auth bug in src/middleware.ts" --wait
  echo "context" | clawconnect run "fix this" --wait --stdin

Options:
  --wait              Block until the task completes (recommended for AI assistants)
  --session <key>     Continue a previous session
  --context <text>    Additional context for the task
  --stdin             Read additional context from stdin
  --timeout <ms>      Task timeout in milliseconds (default: 600000)
  --json              Output machine-readable JSON
  --help, -h          Show this help
`.trim();

export async function runCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      wait: { type: "boolean", default: false },
      session: { type: "string" },
      context: { type: "string" },
      stdin: { type: "boolean", default: false },
      timeout: { type: "string", default: "600000" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const task = positionals.join(" ");
  if (!task) {
    console.error("Error: task is required. Usage: clawconnect run <task>");
    process.exit(1);
  }

  let context = values.context;
  if (values.stdin && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const stdinText = Buffer.concat(chunks).toString().trim();
    context = context ? `${context}\n\n${stdinText}` : stdinText;
  }

  const config = loadConfig();
  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  const job = sessions.submitTask({
    task,
    context,
    sessionKey: values.session,
  });

  if (!values.wait) {
    // Fire-and-forget: print job info and exit
    const output = values.json
      ? JSON.stringify({ jobId: job.jobId, sessionKey: job.sessionKey, status: "running" })
      : `Job submitted: ${job.jobId}\nSession: ${job.sessionKey}\n\nUse 'clawconnect status ${job.jobId.slice(0, 8)}' to check progress, or re-run with --wait.`;
    console.log(output);
    process.exit(0);
  }

  // Wait mode: block until completion, progress to stderr
  const timeoutMs = parseInt(values.timeout!, 10);
  const deadline = Date.now() + timeoutMs;
  let lastLogCount = 0;

  if (!values.json) {
    progressLine(`[clawconnect] Running task on session ${job.sessionKey.slice(-12)}...`);
  }

  while (Date.now() < deadline) {
    const updated = await sessions.waitForJob(job.jobId, lastLogCount);
    if (!updated) break;

    // Show progress on stderr
    if (!values.json && updated.logs.length > lastLogCount) {
      const newLogs = updated.logs.slice(lastLogCount);
      for (const log of newLogs) {
        progressLine(`[${log.type}] ${log.text}`);
      }
    }
    lastLogCount = updated.logs.length;

    if (updated.status !== "running") {
      progressDone();
      // Result to stdout
      console.log(formatJobResult(updated, values.json!));

      // Exit code based on status
      if (updated.status === "error") process.exit(1);
      process.exit(0);
    }
  }

  // Timeout
  progressDone();
  if (values.json) {
    console.log(JSON.stringify({ jobId: job.jobId, status: "timeout", sessionKey: job.sessionKey }));
  } else {
    console.error(`Task timed out after ${timeoutMs / 1000}s. Session: ${job.sessionKey}`);
    console.error(`Resume with: clawconnect run "continue" --session ${job.sessionKey} --wait`);
  }
  gateway.close();
  process.exit(2);
}
