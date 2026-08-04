/**
 * Memory search backed by QMD. Each agent in the registry can carry its own
 * `qmdUrl` + `qmdToken`. When the caller has access to multiple agents (e.g.
 * `?agents=assistant,researcher` on the HTTP MCP), we run one search per *unique*
 * qmdUrl+token pair in parallel and dedupe results by file path so the
 * caller sees the union of what those agents can reach.
 *
 * QMD enforces collection access via the token; the per-agent `collections`
 * field in agents.json is only used as a user-visible hint surfaced through
 * `list_collections`.
 */
import type { AgentEntry } from "./agent-registry.ts";

export const DEFAULT_QMD_URL = "http://127.0.0.1:8790";

export interface MemorySearchHit {
  file: string;
  collection?: string;
  score: number;
  snippet: string;
  /** Which agents in the connection scope could see this hit. */
  seenBy: string[];
}

export interface MemorySearchResult {
  hits: MemorySearchHit[];
  errors: Array<{ agent: string; qmdUrl: string; message: string }>;
}

interface QmdHit {
  score: number;
  file: string;
  snippet?: string;
  body?: string;
  collection?: string;
}

/**
 * Group agents into (qmdUrl, qmdToken) buckets. Agents that share a QMD
 * endpoint + token only run one search call between them.
 */
interface SearchEndpoint {
  qmdUrl: string;
  qmdToken: string;
  agents: string[];
  /** Union of `collections` allow-lists across agents in this bucket. Used to
   * intersect with the caller's requested collections (or as the floor when
   * the caller didn't specify any). Empty array means "no allow-list — let
   * the QMD token decide". */
  allowedCollections: string[];
}

function endpointsFor(agents: AgentEntry[]): SearchEndpoint[] {
  const byKey = new Map<string, SearchEndpoint>();
  for (const a of agents) {
    if (!a.qmdToken) continue;
    const qmdUrl = a.qmdUrl ?? DEFAULT_QMD_URL;
    const key = `${qmdUrl}|${a.qmdToken}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { qmdUrl, qmdToken: a.qmdToken, agents: [], allowedCollections: [] };
      byKey.set(key, entry);
    }
    entry.agents.push(a.id);
    for (const c of a.collections ?? []) {
      if (!entry.allowedCollections.includes(c)) entry.allowedCollections.push(c);
    }
  }
  return [...byKey.values()];
}

async function postQmd(
  endpoint: SearchEndpoint,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.qmdUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.qmdToken}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, message: text.slice(0, 300) };
    }
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export interface SearchMemoryOpts {
  query: string;
  limit?: number;
  collections?: string[];
  /** Hint for logging/telemetry; not sent to QMD. */
  intent?: string;
}

export async function searchMemory(
  agents: AgentEntry[],
  opts: SearchMemoryOpts,
): Promise<MemorySearchResult> {
  if (!opts.query.trim()) {
    return { hits: [], errors: [] };
  }
  const endpoints = endpointsFor(agents);
  if (endpoints.length === 0) {
    return { hits: [], errors: [] };
  }

  const limit = Math.max(1, Math.min(50, opts.limit ?? 8));

  const calls = endpoints.map(async (ep) => {
    const primary = ep.agents[0];
    const body: Record<string, unknown> = { query: opts.query, limit, agent: primary };
    // Compose the effective collections filter:
    // - If the caller specified collections, intersect with this endpoint's
    //   per-agent allow-list (if any). Out-of-allow-list collections are
    //   silently dropped for this endpoint.
    // - Otherwise, use the endpoint's allow-list as-is so an agent like Hank
    //   that's restricted to ["hank-memory"] can't pull from shared LC
    //   collections via QMD's shared-visibility rule.
    if (opts.collections && opts.collections.length > 0) {
      const effective = ep.allowedCollections.length > 0
        ? opts.collections.filter((c) => ep.allowedCollections.includes(c))
        : opts.collections;
      if (effective.length === 0) {
        // Caller asked for collections this endpoint can't reach. Skip.
        return { ep, res: { ok: true as const, data: [] } };
      }
      body.collections = effective;
    } else if (ep.allowedCollections.length > 0) {
      body.collections = ep.allowedCollections;
    }
    const res = await postQmd(ep, "/query", body);
    return { ep, res };
  });

  const settled = await Promise.all(calls);

  const byFile = new Map<string, MemorySearchHit>();
  const errors: MemorySearchResult["errors"] = [];

  for (const { ep, res } of settled) {
    if (!res.ok) {
      errors.push({
        agent: ep.agents.join("+"),
        qmdUrl: ep.qmdUrl,
        message: `${res.status}: ${res.message}`,
      });
      continue;
    }
    const arr = Array.isArray(res.data) ? (res.data as QmdHit[]) : [];
    for (const raw of arr) {
      const file = raw.file;
      if (!file) continue;
      const snippet = (raw.snippet ?? "").slice(0, 500);
      const collection = raw.collection ?? extractCollectionFromFile(file);
      const existing = byFile.get(file);
      if (existing) {
        if (raw.score > existing.score) existing.score = raw.score;
        for (const a of ep.agents) {
          if (!existing.seenBy.includes(a)) existing.seenBy.push(a);
        }
      } else {
        byFile.set(file, {
          file,
          collection,
          score: raw.score,
          snippet,
          seenBy: [...ep.agents],
        });
      }
    }
  }

  const hits = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits, errors };
}

function extractCollectionFromFile(file: string): string | undefined {
  // Files come as `qmd://<collection>/<id>.md`
  const m = file.match(/^qmd:\/\/([^/]+)\//);
  return m ? m[1] : undefined;
}

export interface GetMemoryResult {
  file: string;
  found: boolean;
  body?: string;
  collection?: string;
  errors: Array<{ agent: string; qmdUrl: string; message: string }>;
}

export async function getMemory(agents: AgentEntry[], file: string): Promise<GetMemoryResult> {
  if (!file.startsWith("qmd://")) {
    return { file, found: false, errors: [{ agent: "-", qmdUrl: "-", message: "file must start with qmd://" }] };
  }
  const collection = extractCollectionFromFile(file);
  // Optional per-agent collection allow-list: if the file's collection isn't
  // in any endpoint's allow-list, hide it (same protection as search).
  const endpoints = endpointsFor(agents);
  const eligibleEndpoints = endpoints.filter(
    (ep) => ep.allowedCollections.length === 0 || (collection && ep.allowedCollections.includes(collection)),
  );
  if (eligibleEndpoints.length === 0) {
    return { file, found: false, collection, errors: [{ agent: "-", qmdUrl: "-", message: "collection not in any allow-list for this connection" }] };
  }
  const errors: GetMemoryResult["errors"] = [];

  for (const ep of eligibleEndpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      // QMD `/get/<docId>` accepts a URL-encoded full `qmd://` URI as docId
      // and parses out the collection + id internally.
      const res = await fetch(`${ep.qmdUrl}/get/${encodeURIComponent(file)}`, {
        headers: { Authorization: `Bearer ${ep.qmdToken}` },
        signal: ctrl.signal,
      });
      if (res.ok) {
        const text = await res.text();
        return { file, found: true, body: text, collection, errors: [] };
      }
      errors.push({
        agent: ep.agents.join("+"),
        qmdUrl: ep.qmdUrl,
        message: `${res.status}: ${(await res.text()).slice(0, 200)}`,
      });
    } catch (err) {
      errors.push({ agent: ep.agents.join("+"), qmdUrl: ep.qmdUrl, message: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  return { file, found: false, collection, errors };
}

export interface CollectionListing {
  collection: string;
  agents: string[];
}

/**
 * The collections the caller can see, derived from the `collections` field
 * on each allowed agent. Each entry includes the agent ids that grant access
 * so the caller AI can reason about provenance.
 */
export function listCollections(agents: AgentEntry[]): CollectionListing[] {
  const byCollection = new Map<string, Set<string>>();
  for (const a of agents) {
    for (const c of a.collections ?? []) {
      if (!byCollection.has(c)) byCollection.set(c, new Set());
      byCollection.get(c)!.add(a.id);
    }
  }
  return [...byCollection.entries()]
    .map(([collection, agentsSet]) => ({ collection, agents: [...agentsSet].sort() }))
    .sort((a, b) => a.collection.localeCompare(b.collection));
}
