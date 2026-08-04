import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSessionRuntimeRegistry } from "./agent-session.ts";

/**
 * The one wiring step that makes the callback seam REACHABLE in a shipped
 * binary, without teaching ClawConnect anything about any particular runtime.
 *
 * `createApp`/`createMcpServer` already accept an
 * `AgentSessionRuntimeRegistry` — but ClawConnect's own entrypoints are what
 * production runs, and an entrypoint that can never be handed a registry makes
 * the option decorative. The smallest maintainable path that closes that gap
 * without inventing a transport, a plugin API, or a second runtime engine: an
 * operator names ES modules to load, exactly the way they already name the
 * agents.json registry, and each module registers its own runtimes.
 *
 * Everything runtime-specific — a CLI, pairing, a project model, credentials,
 * an HTTP client — lives inside that module, on the host's side of the
 * boundary. A host's own runtime bridge is one such module; ClawConnect neither
 * ships it nor knows it exists.
 *
 * A module exports either `registerAgentSessionRuntimes(registry)` or a
 * default function of the same shape, and calls `registry.register({...})` for
 * each runtime it can answer for:
 *
 *   export function registerAgentSessionRuntimes(registry) {
 *     registry.register({ id: "example-runtime", provider: "…", inspect, continue, detach });
 *   }
 *
 * Trust: the specifiers come from the deployment's own environment, the same
 * trust level as `~/.clawconnect/agents.json` — this is operator
 * configuration, never anything a caller or an agent can influence.
 */
export const RUNTIME_MODULES_ENV = "CLAWCONNECT_AGENT_SESSION_RUNTIME_MODULES";

export type AgentSessionRuntimeRegistrar = (registry: AgentSessionRuntimeRegistry) => void | Promise<void>;

function splitSpecifiers(spec: string): string[] {
  return spec
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A path-ish specifier is resolved against `baseDir` and imported as a file URL; anything else is a bare package name. */
function toImportSpecifier(specifier: string, baseDir: string): string {
  if (specifier.startsWith("file:")) return specifier;
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith(".")) return pathToFileURL(resolve(baseDir, specifier)).href;
  return specifier;
}

/**
 * Loads every configured runtime module and returns the registry they
 * registered into — or undefined when nothing was configured or nothing
 * registered, which is exactly the "claude-fleet is the only reachable
 * runtime" default the factories already document.
 *
 * Never throws. A module that is missing, fails to import, exports no
 * registrar, or throws while registering is logged and skipped: a broken
 * integration must not stop the connector from starting, because every task
 * that does not involve a delegation still works.
 */
export async function loadAgentSessionRuntimes(
  spec: string | undefined = process.env[RUNTIME_MODULES_ENV],
  opts: { baseDir?: string; log?: (message: string) => void } = {},
): Promise<AgentSessionRuntimeRegistry | undefined> {
  const specifiers = spec ? splitSpecifiers(spec) : [];
  if (specifiers.length === 0) return undefined;
  const log = opts.log ?? ((message: string) => console.error(message));
  const baseDir = opts.baseDir ?? process.cwd();
  const registry = new AgentSessionRuntimeRegistry();

  for (const specifier of specifiers) {
    try {
      const mod = (await import(toImportSpecifier(specifier, baseDir))) as {
        registerAgentSessionRuntimes?: AgentSessionRuntimeRegistrar;
        default?: AgentSessionRuntimeRegistrar;
      };
      const register = mod.registerAgentSessionRuntimes ?? mod.default;
      if (typeof register !== "function") {
        log(
          `[agent-session] "${specifier}" exports no registerAgentSessionRuntimes (or default) function — skipped`,
        );
        continue;
      }
      await register(registry);
    } catch (err) {
      log(`[agent-session] failed to load runtime module "${specifier}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ids = registry.ids();
  if (ids.length === 0) {
    log(`[agent-session] ${RUNTIME_MODULES_ENV} was set but no runtime registered — claude-fleet stays the only reachable runtime`);
    return undefined;
  }
  log(`[agent-session] registered runtime(s): ${ids.join(", ")}`);
  return registry;
}
