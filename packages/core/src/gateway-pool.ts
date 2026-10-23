import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { AgentSessionRuntimeRegistry } from "./agent-session.ts";
import { JsonFileAttachmentStore } from "./attachment-store.ts";
import type { StoreDegradation } from "./store-health.ts";
import { OpenClawGateway } from "./gateway.ts";
import { SessionManager } from "./session.ts";
import { JsonFileJobStore } from "./job-store.ts";
import { resolveAgent } from "./agent-registry.ts";
import type { AgentEntry, AgentRegistry } from "./agent-registry.ts";

interface PoolEntry {
  agent: AgentEntry;
  gateway: OpenClawGateway;
  sessions: SessionManager;
  principal?: HumanPrincipal;
  lastUsedAt: number;
  idleClosed: boolean;
}

export interface HumanPrincipal {
  principalId: string;
  loginEmail: string;
}

export function isValidHumanPrincipal(value: unknown): value is HumanPrincipal {
  if (!value || typeof value !== "object") return false;
  const { principalId, loginEmail } = value as HumanPrincipal;
  return (
    typeof principalId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(principalId) &&
    principalId !== "service" &&
    typeof loginEmail === "string" &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(loginEmail) &&
    loginEmail
      .split("")
      .every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

export function principalNamespace(principalId: string): string {
  return createHash("sha256").update(principalId).digest("hex");
}

export type GatewayPoolView = Pick<
  GatewayPool,
  | "forAgent"
  | "forJob"
  | "forSession"
  | "allEntries"
  | "rememberJob"
  | "storeHealth"
  | "retentionStats"
>;

export interface GatewayPoolOptions {
  /** Personal sockets without running work close after this interval. */
  principalIdleTimeoutMs?: number;
}

/**
 * Extra HTTP headers merged into every gateway WS connect, parsed once from
 * CLAWCONNECT_GATEWAY_HEADERS (JSON object). Gateways in trusted-proxy auth
 * mode (Cloudflare Access ingress) reject connects whose upgrade lacks the
 * configured identity headers — this lets the deployment admit the MCP
 * server without touching agents.json. Invalid JSON warns once and disables
 * the merge rather than blocking startup.
 */
/**
 * Sentinel client address sent alongside trusted-proxy identity headers. An
 * OpenClaw gateway that admits this service as a trusted proxy resolves the
 * client from X-Forwarded-For and rejects the upgrade as "unattributable
 * proxy-shaped traffic" (HTTP 403) when it is absent. One pooled WebSocket
 * per agent and principal serves MCP requests, so there is no single real
 * caller address to forward; TEST-NET-1 (RFC 5737) is reserved for documentation and can
 * never be a routable client, which makes it an honest "synthetic client"
 * marker in gateway logs. Service headers may override x-forwarded-for;
 * personal connections always use this sentinel.
 */
export const SYNTHETIC_CLIENT_ADDRESS = "192.0.2.1";

export function parseGatewayConnectHeaders(
  raw: string | undefined,
): Record<string, string> | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    console.warn("CLAWCONNECT_GATEWAY_HEADERS is not valid JSON — ignoring");
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.trim() && typeof value === "string") headers[key.trim().toLowerCase()] = value;
  }
  if (!Object.keys(headers).length) return undefined;
  const carriesIdentity = Object.keys(headers).some((k) => k.startsWith("cf-access-"));
  if (carriesIdentity && !headers["x-forwarded-for"]) {
    headers["x-forwarded-for"] = SYNTHETIC_CLIENT_ADDRESS;
  }
  return headers;
}

let cachedConnectHeaders: Record<string, string> | undefined | null = null;
function gatewayConnectHeaders(): Record<string, string> | undefined {
  if (cachedConnectHeaders === null) {
    cachedConnectHeaders = parseGatewayConnectHeaders(process.env.CLAWCONNECT_GATEWAY_HEADERS);
  }
  return cachedConnectHeaders;
}

export class GatewayPool {
  private entries = new Map<string, PoolEntry>();
  private jobIndex = new Map<string, string>();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private readonly idleTimeoutMs: number;
  /**
   * Every store that answered a load with "I could not read this".
   *
   * Kept because the alternative is a stderr line nobody reads: a failed load
   * rehydrates nothing, and until this existed the only in-band evidence that
   * a restart had silently orphaned every in-flight job was the absence of
   * jobs — which is indistinguishable from there having been none. Surfaced
   * by get_connection_info, the tool a supervisor already calls when
   * something looks inconsistent. Never cleared: a degraded load is a fact
   * about this process's lifetime, not a current condition.
   */
  private degradations = new Map<string, StoreDegradation[]>();

  /**
   * When set, each agent's SessionManager gets its own file
   * (`<jobStoreDir>/<agentId>.json` on the service path, beneath a principal
   * namespace for personal callers) so an in-flight job survives a process
   * restart — see job-store.ts. Omit to keep the pool fully in-memory
   * (e.g. the stdio MCP server, or tests).
   *
   * `attachmentStoreDir` defaults to `jobStoreDir` (a sibling `<agentId>.attachments.json`
   * file in the same directory) since both exist for the same "survive a
   * restart" reason and a deployment that configures one almost always wants
   * the other too. Pass an explicit path only to put them somewhere else.
   *
   * `runtimes` is the host's managed-agent-session runtime table (see
   * agent-session.ts). It is shared across every agent's SessionManager on
   * purpose — a runtime is a property of the deployment, not of an OpenClaw
   * agent — and omitting it means no attachment has anything to ask, which is
   * the default install: every MCP tool behaves identically without one.
   */
  constructor(
    private readonly registry: AgentRegistry,
    private readonly jobStoreDir?: string,
    private readonly attachmentStoreDir: string | undefined = jobStoreDir,
    private readonly runtimes?: AgentSessionRuntimeRegistry,
    options: GatewayPoolOptions = {},
  ) {
    const timeout = options.principalIdleTimeoutMs ?? 5 * 60_000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("Invalid principal idle timeout");
    this.idleTimeoutMs = timeout;
    this.idleTimer = setInterval(() => this.closeIdle(), Math.min(timeout, 60_000));
    this.idleTimer.unref?.();
  }

  private key(agentId: string, principal?: HumanPrincipal): string {
    return JSON.stringify([agentId, principal?.principalId ?? "service"]);
  }

  private storeDir(root: string, principal?: HumanPrincipal): string {
    return principal ? join(root, "principals", principalNamespace(principal.principalId)) : root;
  }

  private preservePrincipal(principal: HumanPrincipal): void {
    const roots = new Set([this.jobStoreDir, this.attachmentStoreDir]);
    for (const root of roots) {
      if (!root) continue;
      const dir = this.storeDir(root, principal);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "principal.json");
      if (existsSync(path)) {
        const stored = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (
          !isValidHumanPrincipal(stored) ||
          stored.principalId !== principal.principalId ||
          stored.loginEmail !== principal.loginEmail
        ) {
          throw new Error("Principal binding conflicts with persisted identity");
        }
      } else {
        writeFileSync(`${path}.tmp`, JSON.stringify(principal), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      }
    }
  }

  private closeIdle(): void {
    for (const entry of this.entries.values()) {
      if (
        !entry.principal ||
        entry.idleClosed ||
        Date.now() - entry.lastUsedAt < this.idleTimeoutMs
      )
        continue;
      if (entry.sessions.hasRunningJobs()) continue;
      entry.gateway.close();
      entry.idleClosed = true;
    }
  }

  private touch(entry: PoolEntry): PoolEntry {
    entry.lastUsedAt = Date.now();
    entry.idleClosed = false;
    return entry;
  }

  forPrincipal(principal?: HumanPrincipal): GatewayPoolView {
    if (principal && !isValidHumanPrincipal(principal))
      throw new Error("Invalid principal binding");
    if (
      principal &&
      [...this.entries.values()].some(
        (entry) =>
          entry.principal?.principalId === principal.principalId &&
          entry.principal.loginEmail !== principal.loginEmail,
      )
    ) {
      throw new Error("Principal binding changed");
    }
    const owner = principal
      ? Object.freeze({
          principalId: principal.principalId,
          loginEmail: principal.loginEmail,
        })
      : undefined;
    return {
      forAgent: (id) => this.forAgent(id, owner),
      forJob: (id) => this.forJob(id, owner),
      forSession: (key) => this.forSession(key, owner),
      allEntries: () => this.allEntries(owner),
      rememberJob: (id, agent) => this.rememberJob(id, agent, owner),
      storeHealth: () => this.storeHealth(owner),
      retentionStats: () => this.retentionStatsFor(this.allEntries(owner)),
    };
  }

  /** Stores that failed a load this process lifetime. Empty is the healthy answer. See `degradations`. */
  storeHealth(principal?: HumanPrincipal): StoreDegradation[] {
    return [...(this.degradations.get(principal?.principalId ?? "service") ?? [])];
  }

  list(): AgentEntry[] {
    return [...this.registry.agents];
  }

  defaultAgentId(): string {
    return this.registry.default;
  }

  private getOrCreate(agentId: string, principal?: HumanPrincipal): PoolEntry {
    if (principal && !isValidHumanPrincipal(principal))
      throw new Error("Invalid principal binding");
    principal = principal
      ? Object.freeze({
          principalId: principal.principalId,
          loginEmail: principal.loginEmail,
        })
      : undefined;
    const key = this.key(agentId, principal);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.principal?.loginEmail !== principal?.loginEmail)
        throw new Error("Principal binding changed");
      return this.touch(existing);
    }
    if (principal) this.preservePrincipal(principal);
    const agent = resolveAgent(this.registry, agentId);
    const gateway = new OpenClawGateway({
      url: agent.url,
      token: agent.password,
      headers: principal
        ? {
            ...gatewayConnectHeaders(),
            "cf-access-authenticated-user-email": principal.loginEmail,
            "cf-access-jwt-assertion": "private-network",
            "x-forwarded-for": SYNTHETIC_CLIENT_ADDRESS,
          }
        : gatewayConnectHeaders(),
    });
    const onDegraded = (degradation: StoreDegradation) => {
      const owner = principal?.principalId ?? "service";
      const entries = this.degradations.get(owner) ?? [];
      entries.push(degradation);
      this.degradations.set(owner, entries);
    };
    const store = this.jobStoreDir
      ? new JsonFileJobStore(
          join(this.storeDir(this.jobStoreDir, principal), `${agent.id}.json`),
          onDegraded,
        )
      : undefined;
    const attachmentStore = this.attachmentStoreDir
      ? new JsonFileAttachmentStore(
          join(this.storeDir(this.attachmentStoreDir, principal), `${agent.id}.attachments.json`),
          onDegraded,
        )
      : undefined;
    const sessions = new SessionManager(
      gateway,
      agent.openclawAgentId,
      store,
      attachmentStore,
      this.runtimes,
      (jobId) => this.jobIndex.delete(this.key(jobId, principal)),
    );
    const entry: PoolEntry = {
      agent,
      gateway,
      sessions,
      principal,
      lastUsedAt: Date.now(),
      idleClosed: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  forAgent(idOrUndefined?: string, principal?: HumanPrincipal): PoolEntry {
    const agent = resolveAgent(this.registry, idOrUndefined);
    return this.getOrCreate(agent.id, principal);
  }

  /**
   * Recover service files and each validated personal namespace eagerly.
   * Rehydration can open transcript subscriptions, so the original principal's
   * gateway must be constructed before its SessionManager loads any records.
   * A missing or invalid personal binding is never interpreted as service work.
   */
  warmAll(): void {
    for (const agent of this.registry.agents) this.getOrCreate(agent.id);
    for (const root of new Set([this.jobStoreDir, this.attachmentStoreDir])) {
      if (!root || !existsSync(join(root, "principals"))) continue;
      for (const dir of readdirSync(join(root, "principals"), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        try {
          const principal: unknown = JSON.parse(
            readFileSync(join(root, "principals", dir.name, "principal.json"), "utf8"),
          );
          if (
            !isValidHumanPrincipal(principal) ||
            principalNamespace(principal.principalId) !== dir.name
          ) {
            throw new Error("Invalid persisted principal");
          }
          for (const agent of this.registry.agents) this.getOrCreate(agent.id, principal);
        } catch {
          // Never interpret an unreadable personal namespace as service work.
          console.warn(
            "[gateway-pool] personal recovery skipped: invalid or unreadable principal binding",
          );
        }
      }
    }
  }

  rememberJob(jobId: string, agentId: string, principal?: HumanPrincipal): void {
    const agentKey = this.key(agentId, principal);
    if (this.entries.get(agentKey)?.sessions.getJob(jobId)) {
      this.jobIndex.set(this.key(jobId, principal), agentKey);
    }
  }

  forJob(jobId: string, principal?: HumanPrincipal): PoolEntry | undefined {
    const jobKey = this.key(jobId, principal);
    const agentKey = this.jobIndex.get(jobKey);
    if (!agentKey) return undefined;
    const entry = this.entries.get(agentKey);
    if (!entry?.sessions.getJob(jobId)) {
      this.jobIndex.delete(jobKey);
      return undefined;
    }
    return this.touch(entry);
  }

  forSession(sessionKey: string, principal?: HumanPrincipal): PoolEntry | undefined {
    for (const entry of this.allEntries(principal)) {
      if (entry.sessions.getLatestJobForSession(sessionKey)) return entry;
    }
    return undefined;
  }

  allEntries(principal?: HumanPrincipal): PoolEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.principal?.principalId === principal?.principalId)
      .map((entry) => this.touch(entry));
  }

  allPrincipalEntries(): PoolEntry[] {
    return [...this.entries.values()];
  }

  retentionStats() {
    return this.retentionStatsFor(this.allPrincipalEntries());
  }

  private retentionStatsFor(entries: PoolEntry[]) {
    const agents = entries.map((entry) => entry.sessions.retentionStats());
    const retained = {
      jobs: 0,
      finishedJobs: 0,
      logEntries: 0,
      logTextChars: 0,
      logBytes: 0,
      latestJobIndex: 0,
      sessionStates: 0,
      historySessions: 0,
      historyEntries: 0,
      provisionalOutcomes: 0,
      recheckSettled: 0,
      cancelRequested: 0,
      cancelInFlight: 0,
      upstreamRunIds: 0,
      reconcilers: 0,
      attachmentSessions: 0,
      attachments: 0,
    };
    for (const stats of agents) {
      for (const key of Object.keys(retained) as (keyof typeof retained)[])
        retained[key] += stats[key];
    }
    const gateway = {
      pendingTranscriptWork: 0,
      pendingTranscriptBytes: 0,
      transcriptReplayMessages: 0,
      transcriptReplayBytes: 0,
      transcriptSeenIds: 0,
      transcriptLimitFailures: 0,
      transcriptWatches: 0,
      pendingRpcs: 0,
      subscribers: 0,
      transcriptPausedWatches: 0,
      transcriptSkippedEvents: 0,
      transcriptSkippedSequences: 0,
    };
    for (const entry of entries) {
      const stats = entry.gateway.diagnostics();
      for (const key of Object.keys(gateway) as (keyof typeof gateway)[])
        gateway[key] += stats[key];
    }
    const entryKeys = new Set(entries.map((entry) => this.key(entry.agent.id, entry.principal)));
    const starts = agents.flatMap((stats) =>
      stats.oldestJobStartedAt === undefined ? [] : [stats.oldestJobStartedAt],
    );
    return {
      ...retained,
      gateway,
      jobRoutingIndex: [...this.jobIndex.values()].filter((key) => entryKeys.has(key)).length,
      ...(starts.length ? { oldestJobStartedAt: Math.min(...starts) } : {}),
    };
  }

  closeAll(): void {
    clearInterval(this.idleTimer);
    for (const entry of this.entries.values()) {
      entry.sessions.close();
      entry.gateway.close();
    }
    this.entries.clear();
    this.jobIndex.clear();
  }
}
