import { createHash } from "node:crypto";

/**
 * Build identity — what a client needs to answer "is the code I'm talking to
 * the code I think it is?"
 *
 * This exists because it once could not be answered. The deployed connector
 * ran three commits that existed on no remote and no merged branch for a day,
 * serving live traffic, and nothing in the MCP surface said so: `serverInfo`
 * reported a hardcoded "0.1.0" from every era and every transport, so a stale
 * client and a current one were indistinguishable. Every field here is either
 * derived or supplied at deploy time, so none of them can drift into a
 * comfortable lie the way a hand-edited version string does.
 */

/**
 * The one place the human-facing version is written. A constant, deliberately:
 * it names a release, and a release is a decision rather than something to be
 * derived. Everything else on this page is derived precisely BECAUSE it must
 * not depend on someone remembering to edit it.
 */
export const SERVER_VERSION = "0.2.0";

/**
 * Commit the running code was built from.
 *
 * Set `CLAWCONNECT_BUILD_SHA` at deploy time — that is the only source that
 * still means something once the code is a bundled binary with no repository
 * around it. Absent, we say "unknown" rather than guessing: a build identity
 * that invents a plausible value is worse than one that admits it has none,
 * because the whole point is catching the case where two things disagree.
 */
export function buildSha(): string {
  return process.env.CLAWCONNECT_BUILD_SHA?.trim() || "unknown";
}

/**
 * A fingerprint of the tool catalog itself, derived from the declarations the
 * server would hand out right now.
 *
 * This is the field that actually catches a stale client. A version string
 * says what the SERVER is; this says what the server's TOOL SURFACE is, which
 * is the thing a client caches and can hold a stale copy of. Two connections
 * reporting the same `serverVersion` but different `toolsetVersion` have
 * different catalogs — which is exactly the failure mode where the backend is
 * healthy and the client is working from an older snapshot.
 *
 * Derived rather than declared, so it cannot go stale: change a description,
 * add a parameter, remove a tool, and it changes on its own. Scope-sensitive
 * by construction — a connection narrowed to fewer agents genuinely has a
 * different surface, and should say so.
 */
export function toolsetVersion(
  declarations: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
    outputSchema?: unknown;
  }>,
): string {
  // Sorted by name so the fingerprint tracks the catalog's CONTENT, not the
  // order it happened to be built in — otherwise reordering a registration
  // would read as a surface change to every connected client.
  const canonical = [...declarations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      outputSchema: d.outputSchema ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}
