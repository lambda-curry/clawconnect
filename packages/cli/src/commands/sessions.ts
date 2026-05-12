import { parseArgs } from "node:util";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import { loadAgent } from "../config.ts";

export async function sessionsCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log("Usage: clawconnect sessions [--agent <id>] [--json]");
    process.exit(0);
  }

  const { agent } = loadAgent(values.agent);
  const gateway = new OpenClawGateway({ url: agent.url, token: agent.password });
  const sessions = new SessionManager(gateway, agent.openclawAgentId);

  const list = sessions.listSessions();

  if (list.length === 0) {
    if (values.json) {
      console.log(JSON.stringify([]));
    } else {
      console.log(`No active sessions in this process for agent "${agent.id}".`);
    }
    gateway.close();
    return;
  }

  if (values.json) {
    console.log(JSON.stringify(list.map((s) => ({ ...s, agent: agent.id }))));
  } else {
    for (const s of list) {
      console.log(`Session: ${s.sessionKey.slice(-16)} (agent: ${agent.id})`);
      console.log(`  Last job: ${s.lastJobId.slice(0, 8)}`);
      if (s.lastSummary) console.log(`  Summary: ${s.lastSummary.slice(0, 100)}`);
      if (s.recommendedNextStep) console.log(`  Next: ${s.recommendedNextStep}`);
      console.log("");
    }
  }

  gateway.close();
}
