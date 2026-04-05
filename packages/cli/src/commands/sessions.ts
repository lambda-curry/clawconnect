import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadConfig } from "../config.ts";

export async function sessionsCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect sessions [--json]");
    process.exit(0);
  }

  const config = loadConfig();
  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  const list = sessions.listSessions();

  if (list.length === 0) {
    if (values.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log("No active sessions in this process.");
    }
    gateway.close();
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(list));
  } else {
    for (const s of list) {
      console.log(`Session: ${s.sessionKey.slice(-16)}`);
      console.log(`  Last job: ${s.lastJobId.slice(0, 8)}`);
      if (s.lastSummary) console.log(`  Summary: ${s.lastSummary.slice(0, 100)}`);
      if (s.recommendedNextStep) console.log(`  Next: ${s.recommendedNextStep}`);
      console.log("");
    }
  }

  gateway.close();
}
