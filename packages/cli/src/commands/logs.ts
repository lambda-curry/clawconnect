import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadConfig } from "../config.ts";

export async function logsCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
      tail: { type: "string", default: "20" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect logs <job-id> [--follow] [--tail <n>] [--json]");
    process.exit(0);
  }

  const jobId = positionals[0];
  if (!jobId) {
    console.error("Error: job-id is required. Usage: clawconnect logs <job-id>");
    process.exit(1);
  }

  const config = loadConfig();
  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  const job = sessions.getJob(jobId);
  if (!job) {
    if (values.json) {
      console.log(JSON.stringify({ error: "Job not found", jobId }));
    } else {
      console.error(`Job not found: ${jobId}`);
    }
    gateway.close();
    process.exit(1);
  }

  const tailN = parseInt(values.tail!, 10);
  const logs = job.logs.slice(-tailN);

  for (const log of logs) {
    if (values.json) {
      console.log(JSON.stringify(log));
    } else {
      const ts = new Date(log.ts).toISOString().slice(11, 19);
      console.log(`${ts} [${log.type}] ${log.text}`);
    }
  }

  if (values.follow && job.status === "running") {
    let known = job.logs.length;
    while (job.status === "running") {
      const updated = await sessions.waitForJob(job.jobId, known);
      if (!updated || updated.logs.length === known) continue;
      const newLogs = updated.logs.slice(known);
      for (const log of newLogs) {
        if (values.json) {
          console.log(JSON.stringify(log));
        } else {
          const ts = new Date(log.ts).toISOString().slice(11, 19);
          console.log(`${ts} [${log.type}] ${log.text}`);
        }
      }
      known = updated.logs.length;
    }
  }

  gateway.close();
}
