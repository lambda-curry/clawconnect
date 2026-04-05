import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenClawGateway, SessionManager } from "@clawconnect/core";
import type { GatewayConfig } from "@clawconnect/core";

export function createMcpServer(config: GatewayConfig & { agentId: string }) {
  const server = new McpServer({
    name: "clawconnect",
    version: "0.0.1",
  });

  const gateway = new OpenClawGateway({ url: config.url, token: config.token });
  const sessions = new SessionManager(gateway, config.agentId);

  server.tool(
    "run_task",
    "Submit a task to OpenClaw. Returns a jobId and sessionKey immediately. Use check_task to poll for progress. Pass a sessionKey from a previous task to continue the same conversation thread.",
    {
      task: z.string().describe("The task to perform"),
      context: z.string().optional().describe("Additional context for the task"),
      sessionKey: z.string().optional().describe("Session key from a previous task to continue the same thread"),
    },
    async ({ task, context, sessionKey }) => {
      const job = sessions.submitTask({ task, context, sessionKey });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              jobId: job.jobId,
              sessionKey: job.sessionKey,
              status: "running",
              message: "Task submitted. Use check_task to poll for progress.",
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "check_task",
    "Check the status of a running OpenClaw task. Long-polls for up to 50 seconds — call repeatedly until status is not 'running'. Pass knownLogCount from the previous response to get notified as soon as new activity occurs.",
    {
      jobId: z.string().optional().describe("The jobId from run_task"),
      sessionKey: z.string().optional().describe("The sessionKey from run_task (alternative to jobId)"),
      knownLogCount: z.number().optional().describe("Number of log entries already seen — server returns early on new activity"),
    },
    async ({ jobId, sessionKey, knownLogCount }) => {
      const job = await sessions.waitForJob(jobId, knownLogCount ?? 0, sessionKey);

      if (!job) {
        return {
          content: [{ type: "text" as const, text: "Job not found. The server may have restarted." }],
          isError: true,
        };
      }

      const snapshot = sessions.buildSnapshot(job);
      const isTerminal = job.status !== "running";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              jobId: snapshot.jobId,
              sessionKey: snapshot.sessionKey,
              status: snapshot.status,
              logCount: snapshot.logs.length,
              summary: isTerminal ? snapshot.summary : undefined,
              error: snapshot.error,
              errorInfo: snapshot.errorInfo,
              artifacts: snapshot.artifacts,
              recentLogs: snapshot.logs.slice(-10).map((l) => `[${l.type}] ${l.text}`),
              continuationState: snapshot.continuationState,
            }),
          },
        ],
        ...(job.status === "error" ? { isError: true } : {}),
      };
    },
  );

  server.tool(
    "list_sessions",
    "List all active OpenClaw sessions from this server process. Shows session keys, last job status, and recommended next steps.",
    {},
    async () => {
      const list = sessions.listSessions();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              list.map((s) => ({
                sessionKey: s.sessionKey,
                lastJobId: s.lastJobId,
                lastSummary: s.lastSummary?.slice(0, 200),
                recommendedNextStep: s.recommendedNextStep,
                filesChanged: s.artifacts.filesChanged,
              })),
            ),
          },
        ],
      };
    },
  );

  return { server, gateway };
}
