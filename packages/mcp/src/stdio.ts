import { serveStdio, type ServeStdioOptions } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, type CreateMcpServerOptions } from "./server.ts";

/**
 * Serve one stdio connection in whichever era its opening exchange selected.
 *
 * A 2026-07-28 `server/discover` probe picks the modern per-request-envelope
 * era; a claim-less opening (`initialize`) falls back to the 2025 era and
 * stays pinned to it for the connection's lifetime. The era comes from the
 * SDK's own classification rather than from anything we assume, and is handed
 * to the capability layer so get_connection_info reports what is actually in
 * use.
 */
export function serveClawConnectStdio(
  serverOptions: CreateMcpServerOptions,
  stdioOptions: Omit<ServeStdioOptions, "legacy"> = {},
) {
  return serveStdio(
    (ctx) =>
      createMcpServer({
        ...serverOptions,
        // stdio carries no protocol-version header, so the revision stays
        // unclaimed for a legacy connection; the era is known either way.
        protocol: { era: ctx.era, ...(ctx.era === "modern" ? { version: "2026-07-28" } : {}) },
      }).server,
    { ...stdioOptions, legacy: "serve" },
  );
}
