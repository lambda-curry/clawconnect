import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadAgent } from "../config.ts";
import { formatJobStatus } from "../output.ts";

export async function statusCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect status <job-id> [--agent <id>] [--json]");
    process.exit(0);
  }

  const jobId = positionals[0];
  if (!jobId) {
    console.error("Error: job-id is required. Usage: clawconnect status <job-id>");
    process.exit(1);
  }

  const { agent } = loadAgent(values.agent);
  const gateway = new OpenClawGateway({ url: agent.url, token: agent.password });
  const sessions = new SessionManager(gateway, agent.openclawAgentId);

  const job = sessions.getJob(jobId);
  if (!job) {
    if (values.json) {
      console.log(JSON.stringify({ error: "Job not found", jobId, agent: agent.id }));
    } else {
      console.error(`Job not found on agent "${agent.id}": ${jobId}`);
      console.error("Note: the CLI currently only tracks jobs from the current process.");
    }
    gateway.close();
    process.exit(1);
  }

  console.log(formatJobStatus(job, values.json!));
  gateway.close();
}
