import { serveStdio, type ServeStdioOptions } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, type CreateMcpServerOptions } from "./server.ts";

/** Serve one connection in either the modern or explicitly supported legacy era. */
export function serveClawConnectStdio(
  serverOptions: CreateMcpServerOptions,
  stdioOptions: Omit<ServeStdioOptions, "legacy"> = {},
) {
  return serveStdio(() => createMcpServer(serverOptions).server, {
    ...stdioOptions,
    legacy: "serve",
  });
}
