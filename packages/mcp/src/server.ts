import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  GatewayPool,
  buildCapabilities,
  buildCheckTaskStructuredContent,
  blockedDelegation,
  blockedDelegationNotice,
} from "@clawconnect/core";
import type {
  AgentRegistry,
  AgentSessionRuntimeRegistry,
  Capability,
  CapabilityResult,
  CheckMode,
  CheckTaskResult,
  ContinuationState,
  JobSnapshot,
} from "@clawconnect/core";

/**
 * The stdio transport.
 *
 * It declares no tools of its own. Every tool, its schema, its policy, and
 * its authorization live in core's capability registry
 * (packages/core/src/capability.ts); this file's remaining job is to project
 * that registry onto an McpServer and to render the model-facing TEXT, which
 * is the one thing that legitimately differs per client — an agentic stdio
 * client wants the rich polling payload below, while a UI client wants one
 * short line.
 */

type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type ProviderConfig = {
  /** Default check mode: "wait" blocks until terminal/timeout, "poll" returns on new logs. */
  defaultCheckMode?: CheckMode;
  /** Extra _meta to attach to tool definitions, keyed by tool name. */
  toolMeta?: Record<string, Record<string, unknown>>;
  /**
   * Per-capability model-facing text. Keyed by capability name; receives the
   * capability's structuredContent. Returning undefined falls back to the
   * capability's own text.
   */
  renderText?: Record<string, (structuredContent: unknown) => string | undefined>;
};

// ── Model-facing text (stdio flavour) ───────────────────────────────────────

/**
 * check_task's structuredContent IS the snapshot plus isTerminal/isError (see
 * buildCheckTaskStructuredContent), so a CheckTaskResult can be reconstituted
 * from it exactly. That keeps this renderer — which the contract tests assert
 * byte-for-byte — working off the same payload every transport sends, rather
 * than needing a second channel back to the domain result.
 */
function asCheckTaskResult(structuredContent: unknown): CheckTaskResult | undefined {
  if (!structuredContent || typeof structuredContent !== "object") return undefined;
  const { isTerminal, isError, ...snapshot } = structuredContent as Record<string, unknown>;
  if (typeof isTerminal !== "boolean") return undefined;
  return {
    found: true,
    snapshot: snapshot as unknown as JobSnapshot,
    isTerminal,
    isError: Boolean(isError),
    continuePolling: !isTerminal,
  };
}

/** Exported for the contract tests — driving a real running job through the
 *  in-memory transport would need a live gateway, and the model-facing text
 *  (not just structuredContent) is the thing under test. */
export function defaultFormatCheckTask(result: CheckTaskResult): McpToolResponse {
  if (!result.found) {
    return {
      content: [{ type: "text" as const, text: "Job not found. The server may have restarted." }],
      isError: true,
    };
  }

  const { snapshot, isTerminal, isError, continuePolling } = result;
  // structuredContent is always the full snapshot — client-neutral, shared
  // with every other transport. Only the TEXT content stays minimal while
  // running, to save tokens during polling.
  const structuredContent = buildCheckTaskStructuredContent(result);

  if (!isTerminal) {
    // A still-running turn whose delegated session is already waiting on a
    // human: the default hint tells the model to keep polling, which here is
    // advice to wait forever. The notice replaces it, and the delegated
    // session rides along so the model can go answer it.
    const blocked = blockedDelegation(snapshot);
    const payload = {
      status: "running",
      jobId: snapshot.jobId,
      sessionKey: snapshot.sessionKey,
      agent: snapshot.agent,
      elapsedSeconds: Math.round((Date.now() - snapshot.startedAt) / 1000),
      // logCursor, not the returned-entry count: `logs` is a bounded
      // projection, so its length is exactly the number a caller must NOT
      // send back as knownLogCount. logEventCount is the server-side total,
      // for awareness only — it is not a cursor either.
      logCursor: snapshot.logCursor,
      logEventCount: snapshot.logEventCount,
      pollCount: snapshot.pollCount,
      recovery: snapshot.recovery,
      continuePolling,
      retryAfterMs: snapshot.retryAfterMs,
      nextAction: snapshot.nextAction,
      hint: blocked
        ? `${blocked.notice} Pass knownLogCount=${snapshot.logCursor} when you do call check_task again.`
        : snapshot.recovery
          ? `Task is recovering late transcript final text. Call check_task again to continue waiting; pass knownLogCount=${snapshot.logCursor}.`
          : `Task is actively running (this is a non-terminal timeout, not an error). Call check_task again with the same jobId to continue waiting; pass knownLogCount=${snapshot.logCursor} to resume the log window.`,
      // Same key and same type as the terminal branch below, so a client does
      // not have to branch on job phase to read a blocked delegation.
      ...(blocked
        ? { blockedDelegation: blocked.notice, delegatedSession: snapshot.agentSession }
        : {}),
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent,
    };
  }

  // Terminal: deliver the full payload. A turn whose delegated session is
  // waiting on a human is terminal for the JOB but not for the WORK — without
  // this it reads as an ordinary finished task with nothing to say, and the
  // block goes unnoticed until someone opens the session by hand.
  const blockedNotice = blockedDelegationNotice(snapshot);
  const payload = {
    jobId: snapshot.jobId,
    sessionKey: snapshot.sessionKey,
    agent: snapshot.agent,
    status: snapshot.status,
    recovery: snapshot.recovery,
    summary: snapshot.summary,
    error: snapshot.error,
    errorInfo: snapshot.errorInfo,
    artifacts: snapshot.artifacts,
    continuationState: snapshot.continuationState,
    pollCount: snapshot.pollCount,
    continuePolling,
    retryAfterMs: snapshot.retryAfterMs,
    nextAction: snapshot.nextAction,
    ...(blockedNotice
      ? {
          blockedDelegation: blockedNotice,
          delegatedSession: snapshot.agentSession,
          terminalReason: snapshot.terminalReason,
        }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * list_sessions' text stays a trimmed projection rather than the full
 * structuredContent: an agentic client polls this, and returning every
 * session's complete artifacts on every call is exactly the unbounded growth
 * the row previews elsewhere exist to avoid.
 */
function stdioListSessionsText(structuredContent: unknown): string | undefined {
  const sessions = (structuredContent as { sessions?: ContinuationState[] } | undefined)?.sessions;
  if (!sessions) return undefined;
  return JSON.stringify(
    sessions.map((s) => ({
      agent: s.agent,
      sessionKey: s.sessionKey,
      lastJobId: s.lastJobId,
      lastSummary: s.lastSummary?.slice(0, 200),
      recommendedNextStep: s.recommendedNextStep,
      filesChanged: s.artifacts.filesChanged,
    })),
  );
}

const STDIO_TEXT: Record<string, (sc: unknown) => string | undefined> = {
  check_task: (sc) => {
    const result = asCheckTaskResult(sc);
    return result ? defaultFormatCheckTask(result).content[0].text : undefined;
  },
  list_sessions: stdioListSessionsText,
};

// ── Server factory ──────────────────────────────────────────────────────────

export interface CreateMcpServerOptions {
  registry: AgentRegistry;
  provider?: ProviderConfig;
  /**
   * Managed-agent-session runtimes this host can drive (see agent-session.ts
   * in core). Omitted — the default install — no attachment has anything to
   * ask, and any attachment reads back as a precise unknown_runtime result.
   */
  agentSessionRuntimes?: AgentSessionRuntimeRegistry;
  /**
   * Directory for per-agent attachment-lineage files (`<agentId>.attachments.json`,
   * see attachment-store.ts). Attachment lineage is durable state the
   * managed-session model depends on — which conversation is delegated to
   * which session, and its replacement history — so a stdio server that
   * restarts (the host reconnects, the machine sleeps) otherwise loses every
   * attachment even though the underlying runtime session is still alive.
   *
   * Deliberately NOT defaulted here: this factory is also what tests and
   * embedders construct, and a default would have them writing files as a side
   * effect of construction. The shipped `clawconnect-mcp` bin passes one (see
   * bin.ts) — that is the deployed path this exists for.
   */
  attachmentStoreDir?: string;
  /**
   * Protocol era for the serving unit, as the SDK classified it — passed
   * through from McpRequestContext.era by whoever constructs the server
   * (see stdio.ts). Defaults to the legacy era with no version claim: that
   * is what an embedder constructing this factory directly gets, and
   * claiming a revision we were not told is the defect get_connection_info
   * exists to prevent.
   */
  protocol?: { era: "legacy" | "modern"; version?: string };
}

/**
 * Register one capability on an McpServer. Shared by every transport: the
 * declaration is CONVERTED, never restated, and the handler is the
 * capability's own — so a transport cannot skip an authorization check by
 * forgetting to copy one, which is exactly how three copies of those checks
 * came to exist.
 */
export function registerCapability(
  server: McpServer,
  capability: Capability,
  opts: {
    meta?: Record<string, unknown>;
    renderText?: (structuredContent: unknown) => string | undefined;
  } = {},
): void {
  server.registerTool(
    capability.name,
    {
      description: capability.description,
      inputSchema: fromJsonSchema<Record<string, unknown>>(capability.inputSchema as never),
      ...(capability.outputSchema
        ? { outputSchema: fromJsonSchema(capability.outputSchema as never) }
        : {}),
      annotations: capability.annotations,
      ...(opts.meta ? { _meta: opts.meta } : {}),
    },
    async (args: Record<string, unknown>, ctx: { mcpReq?: { signal?: AbortSignal } }) => {
      const result: CapabilityResult = await capability.handler(args ?? {}, {
        signal: ctx?.mcpReq?.signal,
      });
      const text =
        opts.renderText?.(result.structuredContent) ??
        result.text ??
        JSON.stringify(result.structuredContent ?? {});
      return {
        content: [{ type: "text" as const, text }],
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}

export function createMcpServer(config: CreateMcpServerOptions) {
  const server = new McpServer(
    { name: "ClawConnect", version: "0.1.0" },
    {
      // Advertised by legacy initialize and the modern discovery path without
      // relying on connection-scoped instructions or context.
      instructions:
        "Use run_task to delegate work, then check_task until continuePolling is false.",
    },
  );

  const pool = new GatewayPool(
    config.registry,
    undefined,
    config.attachmentStoreDir,
    config.agentSessionRuntimes,
  );
  // Rehydrate every configured agent's persisted attachment lineage now, not
  // lazily on the first request that happens to touch one — an agent nobody
  // has queried since the restart would otherwise look unattached.
  if (config.attachmentStoreDir) pool.warmAll();

  const provider = config.provider ?? {};

  // stdio has no per-connection narrowing: one process, one operator, every
  // configured agent. It still gets a real Scope object, so it runs the same
  // authorization code the HTTP transport does rather than running none.
  const allowedIds = config.registry.agents.map((a) => a.id);

  const capabilities = buildCapabilities({
    pool,
    registry: config.registry,
    scope: { allowedIds, defaultId: config.registry.default, serverName: "ClawConnect" },
    // stdio authenticates at the process boundary, not per message, so there
    // is no credential to derive a name from. A model-supplied senderName is
    // therefore honoured here — the same rule as an anonymous HTTP connection.
    identity: { user: null },
    defaultCheckMode: provider.defaultCheckMode ?? "wait",
    protocol: () => config.protocol ?? { era: "legacy" },
  });

  for (const capability of capabilities) {
    registerCapability(server, capability, {
      meta: provider.toolMeta?.[capability.name],
      renderText: provider.renderText?.[capability.name] ?? STDIO_TEXT[capability.name],
    });
  }

  return { server, pool };
}
