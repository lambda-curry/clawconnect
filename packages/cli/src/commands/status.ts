import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadConfig } from "../config.ts";
import { formatJobStatus } from "../output.ts";

export async function statusCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect status <job-id> [--json]");
    process.exit(0);
  }

  const jobId = positionals[0];
  if (!jobId) {
    console.error("Error: job-id is required. Usage: clawconnect status <job-id>");
    process.exit(1);
  }

  const config = loadConfig();
  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  // Note: since the CLI is a fresh process, we can only check jobs that were
  // submitted in this process. For cross-process job tracking, we'd need
  // persistent storage. For now, this command is useful within the same process
  // or when piped from `run` output.
  const job = sessions.getJob(jobId);
  if (!job) {
    if (values.json) {
      console.log(JSON.stringify({ error: "Job not found", jobId }));
    } else {
      console.error(`Job not found: ${jobId}`);
      console.error("Note: the CLI currently only tracks jobs from the current process.");
    }
    gateway.close();
    process.exit(1);
  }

  console.log(formatJobStatus(job, values.json!));
  gateway.close();
}
