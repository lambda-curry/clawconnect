import { join } from "node:path";
import type { AgentSessionRuntimeRegistry } from "./agent-session.ts";
import type { FleetAdapter } from "./fleet-adapter.ts";
import { JsonFileFleetAttachmentStore } from "./fleet-attachment-store.ts";
import { OpenClawGateway } from "./gateway.ts";
import { SessionManager } from "./session.ts";
import { JsonFileJobStore } from "./job-store.ts";
import { resolveAgent } from "./agent-registry.ts";
import type { AgentEntry, AgentRegistry } from "./agent-registry.ts";

interface PoolEntry {
  agent: AgentEntry;
  gateway: OpenClawGateway;
  sessions: SessionManager;
}

export class GatewayPool {
  private entries = new Map<string, PoolEntry>();
  private jobIndex = new Map<string, string>();

  /**
   * When set, each agent's SessionManager gets its own file
   * (`<jobStoreDir>/<agentId>.json`) so an in-flight job survives a process
   * restart — see job-store.ts. Omit to keep the pool fully in-memory
   * (e.g. the stdio MCP server, or tests).
   *
   * `fleetStoreDir` defaults to `jobStoreDir` (a sibling `<agentId>.fleet.json`
   * file in the same directory) since both exist for the same "survive a
   * restart" reason and a deployment that configures one almost always wants
   * the other too. Pass an explicit path only to put them somewhere else.
   *
   * `runtimes` is the host's managed-agent-session runtime table (see
   * agent-session.ts). It is shared across every agent's SessionManager on
   * purpose — a runtime is a property of the deployment, not of an OpenClaw
   * agent — and omitting it leaves claude-fleet as the only reachable runtime.
   */
  constructor(
    private readonly registry: AgentRegistry,
    private readonly jobStoreDir?: string,
    private readonly fleetAdapter?: FleetAdapter,
    private readonly fleetStoreDir: string | undefined = jobStoreDir,
    private readonly runtimes?: AgentSessionRuntimeRegistry,
  ) {}

  list(): AgentEntry[] {
    return [...this.registry.agents];
  }

  defaultAgentId(): string {
    return this.registry.default;
  }

  private getOrCreate(agentId: string): PoolEntry {
    const existing = this.entries.get(agentId);
    if (existing) return existing;
    const agent = resolveAgent(this.registry, agentId);
    const gateway = new OpenClawGateway({ url: agent.url, token: agent.password });
    const store = this.jobStoreDir ? new JsonFileJobStore(join(this.jobStoreDir, `${agent.id}.json`)) : undefined;
    const fleetStore = this.fleetStoreDir
      ? new JsonFileFleetAttachmentStore(join(this.fleetStoreDir, `${agent.id}.fleet.json`))
      : undefined;
    const sessions = new SessionManager(
      gateway,
      agent.openclawAgentId,
      store,
      fleetStore,
      this.fleetAdapter,
      this.runtimes,
    );
    const entry: PoolEntry = { agent, gateway, sessions };
    this.entries.set(agent.id, entry);
    return entry;
  }

  forAgent(idOrUndefined?: string): PoolEntry {
    const agent = resolveAgent(this.registry, idOrUndefined);
    return this.getOrCreate(agent.id);
  }

  /**
   * Eagerly instantiate every configured agent's pool entry (and, when
   * jobStoreDir is set, reload its persisted jobs) instead of waiting for
   * the first request that happens to touch each one. Cheap: constructing a
   * SessionManager/OpenClawGateway never opens a live connection on its own
   * (see OpenClawGateway.connect) — this just makes sure a restart doesn't
   * leave some agents' in-flight jobs unrecovered simply because no request
   * for that agent has arrived yet.
   */
  warmAll(): void {
    for (const agent of this.registry.agents) this.getOrCreate(agent.id);
  }

  rememberJob(jobId: string, agentId: string): void {
    this.jobIndex.set(jobId, agentId);
  }

  forJob(jobId: string): PoolEntry | undefined {
    const agentId = this.jobIndex.get(jobId);
    if (!agentId) return undefined;
    return this.entries.get(agentId);
  }

  forSession(sessionKey: string): PoolEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.sessions.getSessionState(sessionKey)) return entry;
    }
    return undefined;
  }

  allEntries(): PoolEntry[] {
    return [...this.entries.values()];
  }

  closeAll(): void {
    for (const entry of this.entries.values()) entry.gateway.close();
    this.entries.clear();
    this.jobIndex.clear();
  }
}
