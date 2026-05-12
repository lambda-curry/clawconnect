import { OpenClawGateway } from "./gateway.ts";
import { SessionManager } from "./session.ts";
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

  constructor(private readonly registry: AgentRegistry) {}

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
    const sessions = new SessionManager(gateway, agent.openclawAgentId);
    const entry: PoolEntry = { agent, gateway, sessions };
    this.entries.set(agent.id, entry);
    return entry;
  }

  forAgent(idOrUndefined?: string): PoolEntry {
    const agent = resolveAgent(this.registry, idOrUndefined);
    return this.getOrCreate(agent.id);
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
