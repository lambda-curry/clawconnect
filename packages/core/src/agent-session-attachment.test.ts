import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_CALL_TIMEOUT_MS,
  AgentSessionRuntimeRegistry,
  blockedDelegationNotice,
  type AgentSessionObservation,
  type AgentSessionRef,
} from "./agent-session.ts";
import { ATTACHMENT_RESULT_SUMMARY_MAX, SessionManager } from "./session.ts";
import type { OpenClawGateway, RunObservation } from "./gateway.ts";
import type { AttachmentStore } from "./attachment-store.ts";
import type { JobStore, PersistedJob } from "./job-store.ts";
import { NO_SUMMARY_SENTINEL, type AgentSessionAttachment, type GatewayEvent, type SessionAttachmentState } from "./types.ts";

/**
 * The managed, session-scoped Fleet attachment feature: attach/continue/
 * replace/detach/inspect transitions parsed from a structured directive in
 * TaskInput.context (see session-handoff.ts), persisted independently of job
 * lifecycle (see attachment-store.ts), and consulted as recovery order
 * tier 3 — ONLY after the parent's own live+transcript recovery has already
 * given up (see session.ts's tryAttachedSessionRecovery and its two call sites). See
 * docs/architecture/2026-08-02-managed-fleet-attachment-plan.md.
 */

/**
 * The runtime id every fixture in this file attaches to. ClawConnect ships no
 * runtime and has no default, so an attach directive has to name one — the
 * neutral marker always did, and the explicit directive now matches it.
 */
const RUNTIME_ID = "example-runtime";

/** Fills in the required `runtime` for attach/replace so each test states only what it is actually about. */
function directiveBlock(directive: Record<string, unknown>): string {
  const withRuntime =
    (directive.op === "attach" || directive.op === "replace") && directive.runtime === undefined
      ? { ...directive, runtime: RUNTIME_ID }
      : directive;
  return `[[clawconnect:agent-session]]${JSON.stringify(withRuntime)}[[/clawconnect:agent-session]]`;
}

/** Never settles chat() on its own — every fixture here drives completion explicitly via finishChat/failChat. */
function fakeGateway(
  opts: {
    pollTranscriptForFinalText?: () => Promise<string | undefined>;
  } = {},
) {
  const calls: {
    sessionKey: string;
    onEvent?: (e: GatewayEvent) => void;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  let pollImpl = opts.pollTranscriptForFinalText ?? (async () => undefined);

  const gateway = {
    chat(
      sessionKey: string,
      _message: string,
      _timeoutMs: number,
      onEvent?: (e: GatewayEvent) => void,
      onRunId?: (runId: string) => void,
    ) {
      onRunId?.(`run-for-${sessionKey.slice(-8)}`);
      return new Promise<string>((resolve, reject) => {
        calls.push({ sessionKey, onEvent, resolve, reject });
      });
    },
    async reconcileRun(): Promise<RunObservation> {
      return { ok: true, changed: true, trailingText: "", snapshotKey: "active", upstream: "unknown" };
    },
    pollTranscriptForFinalText: (...args: unknown[]) => pollImpl(),
    close() {},
  } as unknown as OpenClawGateway;

  return {
    gateway,
    finishChat: (text: string, call = 0) => calls[call]?.resolve(text),
    failChat: (err: Error, call = 0) => calls[call]?.reject(err),
    setPoll: (impl: () => Promise<string | undefined>) => {
      pollImpl = impl;
    },
  };
}

type FakeHandoff = { text: string; resultAt: number };

/**
 * A runtime shaped like the local-tmux example (see
 * examples/local-tmux-runtime): a liveness probe that deliberately claims NO
 * state, and a terminal handoff it will only offer once the session is gone.
 *
 * These tests are about CORE's rules — when recovery may consult an
 * attachment, whose turn an answer may belong to, which writes survive a
 * race — and the neutral seam is the only path to them now that no adapter
 * ships in core. Modelling both halves in one `inspect` is what a real
 * runtime module does, so `isLiveCalls` counts every probe and `handoffCalls`
 * counts only the ones that got as far as asking for a result.
 */
function fakeRuntime(
  opts: {
    isLive?: boolean | (() => Promise<boolean>);
    handoff?: FakeHandoff | null | (() => Promise<FakeHandoff | null>);
  } = {},
): {
  registry: AgentSessionRuntimeRegistry;
  isLiveCalls: AgentSessionRef[];
  handoffCalls: AgentSessionRef[];
  /** The signal each handoff read received — undefined means the caller forwarded none. */
  handoffSignals: (AbortSignal | undefined)[];
} {
  const isLiveCalls: AgentSessionRef[] = [];
  const handoffCalls: AgentSessionRef[] = [];
  const handoffSignals: (AbortSignal | undefined)[] = [];
  const registry = new AgentSessionRuntimeRegistry();
  registry.register({
    id: RUNTIME_ID,
    provider: "anthropic-claude-code",
    async inspect(ref, callOpts) {
      isLiveCalls.push(ref);
      const live = typeof opts.isLive === "function" ? await opts.isLive() : (opts.isLive ?? false);
      // Alive and nothing else: a liveness bit cannot tell working from
      // waiting, so claiming a state here would let the probe clobber one the
      // host stated explicitly.
      if (live) return { alive: true };
      handoffCalls.push(ref);
      handoffSignals.push(callOpts?.signal);
      const handoff = typeof opts.handoff === "function" ? await opts.handoff() : (opts.handoff ?? null);
      if (!handoff) return { alive: false };
      return { state: "completed", alive: false, finalResponse: handoff.text, lastEventAt: handoff.resultAt };
    },
  });
  return { registry, isLiveCalls, handoffCalls, handoffSignals };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Round-trips through `saved`, not just a fixed `preloaded` value — a fresh
 * SessionManager constructed over the SAME store instance (simulating a
 * restart) must see whatever the PREVIOUS instance most recently wrote, not
 * just whatever this fake was seeded with at construction.
 */
class FakeAttachmentStore implements AttachmentStore {
  saved: SessionAttachmentState[][] = [];
  constructor(private preloaded: SessionAttachmentState[] = []) {}
  load(): SessionAttachmentState[] {
    return this.saved.at(-1) ?? this.preloaded;
  }
  save(states: SessionAttachmentState[]): void {
    this.saved.push(states);
  }
  get latestSave(): SessionAttachmentState[] | undefined {
    return this.saved.at(-1);
  }
}

class FakeJobStoreForAttachments implements JobStore {
  saved: PersistedJob[][] = [];
  load(): PersistedJob[] {
    return [];
  }
  save(jobs: PersistedJob[]): void {
    this.saved.push(jobs);
  }
  get latestSave(): PersistedJob[] | undefined {
    return this.saved.at(-1);
  }
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe("Fleet attachment transitions", () => {
  it("attach creates a current attachment, visible on the job snapshot", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1", providerSessionId: "prov-1", worktree: "/w" }),
    });

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey);
    expect(attachment).toMatchObject({ handle: "cf-foo", host: "workstation-1", providerSessionId: "prov-1", worktree: "/w", status: "starting" });

    const snapshot = sessions.buildSnapshot(job);
    expect(snapshot.agentSession).toEqual(attachment);
  });

  it("the directive is stripped from the message sent to the agent", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    sessions.submitTask({
      task: "do the thing",
      context: `before ${directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" })} after`,
    });
    expect(sessions.getAgentSessionAttachment(sessions.listSessions()[0]?.sessionKey ?? "")).toBeDefined();
    // The prompt actually sent is reconstructed via job.prompt, which stores
    // the STRIPPED context — never the raw directive JSON.
    const job = sessions.getJob(sessions.listSessions()[0].lastJobId)!;
    expect(job.prompt.context).not.toContain("clawconnect:fleet");
    expect(job.prompt.context).toContain("before");
    expect(job.prompt.context).toContain("after");
  });

  it("later turns expose and continue the same attachment without a directive", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const first = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat("first done", 0);
    await wait();

    const before = sessions.getAgentSessionAttachment(first.sessionKey);
    // Second turn, same session, NO directive at all.
    const second = sessions.submitTask({ task: "second", sessionKey: first.sessionKey });
    expect(second.status).toBe("running"); // proves this is a REAL second turn, not a busy rejection
    const after = sessions.getAgentSessionAttachment(second.sessionKey);
    expect(after).toEqual(before);
  });

  it("explicit replacement preserves superseded lineage", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    const original = sessions.getAgentSessionAttachment(job.sessionKey)!;

    ctrl.finishChat("done", 0);
    await wait();
    sessions.submitTask({
      task: "replace it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "replace", handle: "cf-bar", host: "workstation-1", reason: "stale worktree" }),
    });

    const current = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(current.handle).toBe("cf-bar");
    expect(current.replacesAttachmentId).toBe(original.id);

    const lineage = sessions.getAgentSessionLineage(job.sessionKey);
    expect(lineage).toHaveLength(2);
    const superseded = lineage.find((a) => a.id === original.id)!;
    expect(superseded.status).toBe("superseded");
    expect(superseded.reason).toBe("stale worktree");
  });

  it("explicit detach persists a reason and clears the current attachment", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    const original = sessions.getAgentSessionAttachment(job.sessionKey)!;
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "detach it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "detach", reason: "task finished" }),
    });

    expect(sessions.getAgentSessionAttachment(job.sessionKey)).toBeUndefined();
    const lineage = sessions.getAgentSessionLineage(job.sessionKey);
    const detached = lineage.find((a) => a.id === original.id)!;
    expect(detached.status).toBe("detached");
    expect(detached.reason).toBe("task finished");
  });

  it("needs_input reported via continue stays actionable — visible on the snapshot without forcing the job terminal", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "check in",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", status: "needs_input" }),
    });

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    // The job this ships alongside is unaffected — the attachment's status is
    // orthogonal to whether the parent job itself is terminal.
    const latestJob = sessions.getLatestJobForSession(job.sessionKey)!;
    expect(latestJob.status).toBe("running");
  });

  it("inspect with an explicit status never starts the background isLive probe at all", async () => {
    const adapter = fakeRuntime({ isLive: true });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "inspect with explicit status",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "inspect", status: "needs_input" }),
    });

    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("needs_input");
    expect(adapter.isLiveCalls).toHaveLength(0);
  });

  it("an explicit needs_input status is never overwritten by an in-flight isLive probe from an EARLIER plain inspect", async () => {
    const { promise: isLivePromise, resolve: resolveIsLive } = deferred<boolean>();
    const adapter = fakeRuntime({ isLive: () => isLivePromise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    // A plain inspect (no explicit status) — its isLive call is now in
    // flight, deliberately held open.
    sessions.submitTask({ task: "inspect", sessionKey: job.sessionKey, context: directiveBlock({ op: "inspect" }) });
    expect(adapter.isLiveCalls).toHaveLength(1);
    ctrl.finishChat("inspect turn done", 1);
    await wait();

    // The host explicitly reports needs_input BEFORE the stale probe resolves.
    sessions.submitTask({
      task: "check in",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", status: "needs_input" }),
    });
    ctrl.finishChat("continue turn done", 2);
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("needs_input");
    // The explicit-status continue must not have ALSO started a new probe.
    expect(adapter.isLiveCalls).toHaveLength(1);

    // NOW the stale isLive resolves true ("it's running!") — after the fact.
    resolveIsLive(true);
    await wait();

    // Must still read needs_input — the callback re-reads fresh state rather
    // than trusting the "starting"/whatever it closed over before the await.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("needs_input");
  });

  it("no attachment triggers no runtime call at all (no global session scan)", () => {
    const adapter = fakeRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    sessions.submitTask({ task: "no fleet involved here" });
    ctrl.finishChat("done", 0);
    expect(adapter.isLiveCalls).toHaveLength(0);
    expect(adapter.handoffCalls).toHaveLength(0);
  });
});

describe("Fleet attachment restart persistence", () => {
  it("attachment survives a connector restart via a fresh SessionManager over the same store", () => {
    const store = new FakeAttachmentStore();
    const ctrl = fakeGateway();
    const before = new SessionManager(ctrl.gateway, "main", undefined, store);
    const job = before.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1", providerSessionId: "prov-1" }),
    });
    const original = before.getAgentSessionAttachment(job.sessionKey)!;
    expect(store.latestSave).toBeDefined();

    // Simulate a restart: a brand new SessionManager, same underlying store.
    const after = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    expect(after.getAgentSessionAttachment(job.sessionKey)).toEqual(original);
  });

  it("old PersistedJob/SessionAttachmentState records without the new fields are still readable", () => {
    // A job-store record from before parentRunId existed.
    const legacyJobStore: JobStore = {
      load: () => [
        {
          jobId: "old-job",
          sessionKey: "agent:main:main:thread:legacy",
          startedAt: 1000,
          lastEventAt: 2000,
          pollCount: 1,
          prompt: { task: "legacy task" },
          // no parentRunId
        } as PersistedJob,
      ],
      save: () => {},
    };
    expect(() => new SessionManager(fakeGateway().gateway, "main", legacyJobStore)).not.toThrow();
    const sessions = new SessionManager(fakeGateway().gateway, "main", legacyJobStore);
    const job = sessions.resolveJob("old-job");
    expect(job).toBeDefined();
    expect(job?.parentRunId).toBeUndefined();

    // A session with no Fleet attachment at all (the common case for every
    // pre-existing record — this feature is greenfield) reads back as "no
    // attachment", not an error.
    const emptyAttachmentStore: AttachmentStore = { load: () => [], save: () => {} };
    const withEmptyAttachments = new SessionManager(fakeGateway().gateway, "main", undefined, emptyAttachmentStore);
    expect(withEmptyAttachments.getAgentSessionAttachment("agent:main:main:thread:legacy")).toBeUndefined();
  });

  it("a currentAttachmentId with no matching attachments entry never throws — reads as no current attachment", () => {
    const malformed: SessionAttachmentState = {
      sessionKey: "agent:main:main:thread:malformed-1",
      currentAttachmentId: "ghost-id",
      attachments: {}, // no entry for ghost-id
    };
    const store: AttachmentStore = { load: () => [malformed], save: () => {} };
    expect(() => new SessionManager(fakeGateway().gateway, "main", undefined, store)).not.toThrow();
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    expect(sessions.getAgentSessionAttachment(malformed.sessionKey)).toBeUndefined();
    expect(sessions.getAgentSessionLineage(malformed.sessionKey)).toEqual([]);
  });

  it("a record missing the attachments field entirely never throws, and valid lineage in a DIFFERENT session in the same load() is preserved", () => {
    const missingAttachmentsField = {
      sessionKey: "agent:main:main:thread:malformed-2",
      currentAttachmentId: "some-id",
      // attachments field entirely absent — e.g. a truncated/hand-edited file.
    } as unknown as SessionAttachmentState;
    const validRecord: AgentSessionAttachment = {
      id: "att-valid",
      runtime: "claude-fleet",
      handle: "cf-good",
      host: "workstation-1",
      attachedAt: 1000,
      status: "running",
    };
    const validState: SessionAttachmentState = {
      sessionKey: "agent:main:main:thread:valid",
      currentAttachmentId: "att-valid",
      attachments: { "att-valid": validRecord },
    };
    const store: AttachmentStore = { load: () => [missingAttachmentsField, validState], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);

    expect(() => sessions.getAgentSessionAttachment(missingAttachmentsField.sessionKey)).not.toThrow();
    expect(sessions.getAgentSessionAttachment(missingAttachmentsField.sessionKey)).toBeUndefined();
    expect(sessions.getAgentSessionLineage(missingAttachmentsField.sessionKey)).toEqual([]);

    // The OTHER session's valid record in the same store load is untouched.
    expect(sessions.getAgentSessionAttachment(validState.sessionKey)).toEqual(validRecord);
    expect(sessions.getAgentSessionLineage(validState.sessionKey)).toEqual([validRecord]);
  });

  it("a currentAttachmentId that IS resolvable, alongside other malformed entries in the same session's attachments, preserves the valid lineage", () => {
    const validRecord: AgentSessionAttachment = {
      id: "att-good",
      runtime: "claude-fleet",
      handle: "cf-good",
      host: "workstation-1",
      attachedAt: 1000,
      status: "running",
    };
    const mixed = {
      sessionKey: "agent:main:main:thread:mixed",
      currentAttachmentId: "att-good",
      attachments: {
        "att-good": validRecord,
        "att-junk": "not even an object", // a corrupted entry alongside a valid one
        "att-null": null,
      },
    } as unknown as SessionAttachmentState;
    const store: AttachmentStore = { load: () => [mixed], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);

    expect(sessions.getAgentSessionAttachment(mixed.sessionKey)).toEqual(validRecord);
    expect(sessions.getAgentSessionLineage(mixed.sessionKey)).toEqual([validRecord]);
  });

  it("buildSnapshot for a job on a session with malformed persisted fleet state never throws and simply omits agentSession", () => {
    const malformed = {
      sessionKey: "agent:main:main:thread:malformed-snapshot",
      currentAttachmentId: "ghost",
    } as unknown as SessionAttachmentState;
    const store: AttachmentStore = { load: () => [malformed], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    const job = sessions.submitTask({ task: "do the thing", sessionKey: malformed.sessionKey });

    expect(() => sessions.buildSnapshot(job)).not.toThrow();
    expect(sessions.buildSnapshot(job).agentSession).toBeUndefined();
  });

  it("parent runId is persisted immediately when chat.send's onRunId fires, before chat() resolves", () => {
    const jobStore = new FakeJobStoreForAttachments();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", jobStore);
    const job = sessions.submitTask({ task: "do the thing" });

    // chat() has NOT resolved yet — this fake gateway never settles on its
    // own — but onRunId already fired synchronously inside chat.send.
    expect(job.parentRunId).toBe(`run-for-${job.sessionKey.slice(-8)}`);
    expect(jobStore.latestSave?.find((j) => j.jobId === job.jobId)?.parentRunId).toBe(job.parentRunId);
  });
});

describe("attached-session recovery order (tier 3, after parent live+transcript recovery gives up)", () => {
  it("child completion does not prematurely finish an active parent — the runtime is never consulted while the job is running", async () => {
    const adapter = fakeRuntime({ handoff: { text: "child already finished", resultAt: Date.now() } });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    await wait();
    expect(job.status).toBe("running");
    expect(adapter.handoffCalls).toHaveLength(0);
  });

  it("empty parent final + completed attached child recovers the child result with resultSource=agent-session", async () => {
    // The handoff form computes resultAt lazily, at ADAPTER-CALL time — well
    // after job.startedAt — matching the real timing (the child produces its
    // answer sometime after the parent turn began, never before).
    const adapter = fakeRuntime({ handoff: async () => ({ text: "the child's real answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const recovered = sessions.getJob(job.jobId)!;
    expect(recovered.status).toBe("completed");
    expect(recovered.summary).toBe("the child's real answer");
    expect(recovered.resultSource).toBe("agent-session");
    expect(recovered.terminalReason).toBe("agent-session-recovery");

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary).toBe("the child's real answer");
    expect(attachment.lastResult?.outputRef).toBe("cf-foo");
  });

  it("output is capped, with the durable transcript reference preserved on the attachment", async () => {
    const longText = "x".repeat(ATTACHMENT_RESULT_SUMMARY_MAX + 500);
    const adapter = fakeRuntime({ handoff: async () => ({ text: longText, resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1", worktree: "/w" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    // The job's own summary is never capped (matches every other terminal
    // path in this file) — only the attachment's lastResult preview is.
    expect(sessions.getJob(job.jobId)?.summary).toBe(longText);
    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary?.length).toBe(ATTACHMENT_RESULT_SUMMARY_MAX);
    expect(attachment.lastResult?.summary?.endsWith("…")).toBe(true);
    expect(attachment.lastResult?.outputRef).toBe("cf-foo:/w");
  });

  it("a still-live / not-yet-trusted child does not get synthesized into a fake completion", async () => {
    const adapter = fakeRuntime({ handoff: null });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    // Unchanged from today's pre-existing behavior: no attachment could
    // rescue it, so it settles exactly where it always did.
    const stillGivenUp = sessions.getJob(job.jobId)!;
    expect(stillGivenUp.status).toBe("completed_no_summary");
    expect(stillGivenUp.resultSource).toBe("parent");
    expect(adapter.handoffCalls.length).toBeGreaterThan(0);
  });

  /**
   * The registered-runtime path has always forwarded the recovery deadline's
   * signal; the legacy claude-fleet fallback dropped it, so a timed-out read
   * left its local tmux and file work running with nobody waiting on it.
   */
  it("forwards the recovery deadline's abort signal into the runtime, and fires it on timeout", async () => {
    vi.useFakeTimers();
    try {
      const adapter = fakeRuntime({ handoff: () => new Promise<FakeHandoff | null>(() => {}) });
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
      const job = sessions.submitTask({
        task: "do the thing",
        context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
      });
      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await vi.advanceTimersByTimeAsync(1);

      const signal = adapter.handoffSignals.at(-1);
      expect(signal, "the fallback read must receive the deadline's signal").toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(AGENT_SESSION_CALL_TIMEOUT_MS + 1);
      expect(signal!.aborted).toBe(true);
      // And the job still settles rather than hanging on the abandoned read.
      expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeated recovery is idempotent — calling the fallback again with the same handoff doesn't change the outcome or duplicate lineage", async () => {
    const adapter = fakeRuntime({ handoff: async () => ({ text: "stable answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    const firstOutcome = sessions.getJob(job.jobId)!;
    expect(firstOutcome.status).toBe("completed");

    // A second lazy recheck (still no parent transcript) — job is now
    // "completed" (not completed_no_summary), so the fallback does not fire
    // again; the outcome is left exactly as it was.
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    const secondOutcome = sessions.getJob(job.jobId)!;
    expect(secondOutcome.summary).toBe(firstOutcome.summary);
    expect(secondOutcome.resultSource).toBe("agent-session");
    expect(sessions.getAgentSessionLineage(job.sessionKey)).toHaveLength(1);
  });

  it("late parent final safely replaces the provisional delegated result", async () => {
    const adapter = fakeRuntime({ handoff: async () => ({ text: "child's provisional answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(job.jobId)?.resultSource).toBe("agent-session");

    // Now the REAL parent transcript finally has the answer.
    ctrl.setPoll(async () => "the real parent answer, arrived late");
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);

    const finalJob = sessions.getJob(job.jobId)!;
    expect(finalJob.summary).toBe("the real parent answer, arrived late");
    expect(finalJob.resultSource).toBe("parent");
    expect(finalJob.terminalReason).toBe("lazy-recheck-transcript");
  });
});

describe("Independent-review blocker fixes: delegated-turn boundary + stale-result rejection", () => {
  it("a stale child result — its own timestamp predates this turn even starting — is rejected, not treated as this turn's answer", async () => {
    // resultAt is BEFORE the test even runs (let alone before job.startedAt),
    // simulating leftover output from a much earlier delegation.
    const staleResultAt = Date.now() - 60_000;
    const adapter = fakeRuntime({ handoff: async () => ({ text: "stale output from ages ago", resultAt: staleResultAt }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const result = sessions.getJob(job.jobId)!;
    expect(result.status).toBe("completed_no_summary");
    expect(result.resultSource).toBe("parent");
    expect(result.summary).not.toBe("stale output from ages ago");
  });

  it("an attachment left current from an EARLIER delegated turn does not answer a LATER, unrelated turn on the same session", async () => {
    const adapter = fakeRuntime({ handoff: async () => ({ text: "answer to the FIRST delegated task", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);

    // Turn 1: attaches and delegates. Its own recovery correctly succeeds.
    const turn1 = sessions.submitTask({
      task: "delegate this to Fleet",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(turn1.jobId)?.resultSource).toBe("agent-session");

    // Turn 2: a completely different, unrelated task on the SAME session.
    // The host sends NO directive — the attachment is still "current" for
    // exposure purposes, but was never delegated to THIS turn.
    const turn2 = sessions.submitTask({ task: "unrelated: what's 2+2", sessionKey: turn1.sessionKey });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 1);
    await wait();

    const turn2Result = sessions.getJob(turn2.jobId)!;
    expect(turn2Result.status).toBe("completed_no_summary");
    expect(turn2Result.summary).not.toBe("answer to the FIRST delegated task");
    expect(turn2Result.resultSource).toBe("parent");
  });

  it("needs_input stays actionable — a fresh, valid handoff with real output text is still refused while status is needs_input", async () => {
    // The runtime genuinely has fresh, well-formed output — this is NOT a
    // "nothing trustworthy yet" case. The guard must be the attachment's own
    // the host-reported status, not merely the absence of output.
    const adapter = fakeRuntime({ handoff: async () => ({ text: "here is some output, but I have a question", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1", status: "needs_input" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const result = sessions.getJob(job.jobId)!;
    expect(result.status).toBe("completed_no_summary");
    expect(result.resultSource).toBe("parent");
    expect(result.summary).not.toContain("here is some output");

    // The attachment itself stays needs_input — visible/actionable, not
    // silently overwritten by the fact that output text existed.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("needs_input");
  });

  it("a failed child's leftover transcript text is never treated as a trusted answer", async () => {
    const adapter = fakeRuntime({ handoff: async () => ({ text: "partial output before it crashed", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1", status: "failed" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const result = sessions.getJob(job.jobId)!;
    expect(result.status).toBe("completed_no_summary");
    expect(result.resultSource).toBe("parent");
  });
});

describe("Independent-review blocker fixes: detach/replace races (identity compare-and-set)", () => {
  it("an async inspect liveness result that resolves AFTER a detach does not resurrect the detached record", async () => {
    const { promise: isLivePromise, resolve: resolveIsLive } = deferred<boolean>();
    const adapter = fakeRuntime({ isLive: () => isLivePromise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "first",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    const original = sessions.getAgentSessionAttachment(job.sessionKey)!;
    ctrl.finishChat("done", 0);
    await wait();

    // Kick off an inspect — its isLive call is now in flight, deliberately
    // held open via the unresolved deferred promise. Finish ITS chat turn
    // immediately so the busy guard doesn't block the next submission below
    // (submitTask always dispatches a real turn — a directive alone doesn't
    // exempt it from the one-job-per-session guard).
    sessions.submitTask({ task: "inspect", sessionKey: job.sessionKey, context: directiveBlock({ op: "inspect" }) });
    expect(adapter.isLiveCalls).toHaveLength(1);
    ctrl.finishChat("inspect turn done", 1);
    await wait();

    // Detach BEFORE the in-flight isLive resolves.
    sessions.submitTask({ task: "detach", sessionKey: job.sessionKey, context: directiveBlock({ op: "detach", reason: "operator stopped it" }) });
    ctrl.finishChat("detach turn done", 2);
    expect(sessions.getAgentSessionAttachment(job.sessionKey)).toBeUndefined();

    // NOW the stale isLive resolves true ("it's running!") — after the fact.
    resolveIsLive(true);
    await wait();

    // The detached record must stay detached — not resurrected to "running".
    const lineage = sessions.getAgentSessionLineage(job.sessionKey);
    const detachedRecord = lineage.find((a) => a.id === original.id)!;
    expect(detachedRecord.status).toBe("detached");
    expect(detachedRecord.reason).toBe("operator stopped it");
    expect(sessions.getAgentSessionAttachment(job.sessionKey)).toBeUndefined();
  });

  it("a recovery handoff that resolves AFTER a replace does not complete the job with the stale attachment's output, and does not corrupt the superseded record", async () => {
    // First adapter call (from the initial give-up in recoverLateFinalText)
    // finds nothing, settling the job to completed_no_summary — same as
    // today's pre-existing behavior. The busy guard only blocks a NEW
    // submission while a job is `running`, so the race this test targets is
    // the SECOND consult: a lazy recheck (maybeRecoverTerminalJob) triggered
    // once the job is already terminal, which a replace CAN legitimately
    // race against.
    let handoffCallCount = 0;
    const { promise: secondHandoffPromise, resolve: resolveSecondHandoff } = deferred<FakeHandoff | null>();
    const adapter = fakeRuntime({
      handoff: () => {
        handoffCallCount += 1;
        return handoffCallCount === 1 ? Promise.resolve(null) : secondHandoffPromise;
      },
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });
    const original = sessions.getAgentSessionAttachment(job.sessionKey)!;

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    expect(handoffCallCount).toBe(1);

    // Trigger a lazy recheck — its tryAttachedSessionRecovery call is the SECOND
    // handoff call, now in flight and deliberately held open.
    const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    await wait();
    expect(handoffCallCount).toBe(2);

    // Replace the attachment WHILE that second adapter call is in flight —
    // job1 is terminal now, so the busy guard does not block this submit.
    sessions.submitTask({
      task: "replace mid-flight",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "replace", handle: "cf-bar", host: "workstation-1", reason: "operator swap" }),
    });
    ctrl.finishChat("replace turn done", 1);

    // NOW the stale handoff resolves, carrying the OLD (now-superseded) attachment's answer.
    resolveSecondHandoff({ text: "stale answer for the superseded attachment", resultAt: Date.now() });
    await waitPromise;
    await wait();

    // The job must NOT be completed via the stale, now-orphaned handoff.
    const finalJob = sessions.getJob(job.jobId)!;
    expect(finalJob.status).toBe("completed_no_summary");
    expect(finalJob.summary).not.toBe("stale answer for the superseded attachment");

    // The superseded record's lineage must not be corrupted by the stale write.
    const supersededRecord = sessions.getAgentSessionLineage(job.sessionKey).find((a) => a.id === original.id)!;
    expect(supersededRecord.status).toBe("superseded");
    expect(supersededRecord.lastResult).toBeUndefined();

    // The new (replaced) attachment is untouched by the stale write too.
    const current = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(current.handle).toBe("cf-bar");
    expect(current.lastResult).toBeUndefined();
  });

  it("a delayed handoff from an older turn is discarded when the same attachment continues into needs_input", async () => {
    let handoffCallCount = 0;
    const { promise: handoffPromise, resolve: resolveHandoff } = deferred<FakeHandoff | null>();
    const adapter = fakeRuntime({
      handoff: () => {
        handoffCallCount += 1;
        return handoffCallCount === 1 ? Promise.resolve(null) : handoffPromise;
      },
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter.registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", handle: "cf-foo", host: "workstation-1" }),
    });

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    expect(handoffCallCount).toBe(1);

    // Start a lazy recheck for the original generation and hold its handoff
    // open while the same attachment is claimed by a newer continuation.
    const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    await wait();
    expect(handoffCallCount).toBe(2);

    sessions.submitTask({
      task: "continue with a question",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", status: "needs_input" }),
    });
    ctrl.finishChat("continue turn done", 1);

    const currentBeforeResolution = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(currentBeforeResolution.status).toBe("needs_input");
    expect(currentBeforeResolution.delegatedTurnId).not.toBe(job.jobId);
    expect(currentBeforeResolution.lastResult).toBeUndefined();

    // The old handoff resolves after the newer generation is actionable.
    resolveHandoff({ text: "stale answer from the old generation", resultAt: Date.now() });
    await waitPromise;
    await wait();

    const current = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(current.status).toBe("needs_input");
    expect(current.lastResult).toBeUndefined();
    expect(sessions.getJob(job.jobId)?.summary).not.toBe("stale answer from the old generation");
  });
});

/**
 * The generic runtime bridge: the SAME session-scoped attachment machinery
 * above, driven by a host-registered runtime instead of the built-in tmux
 * adapter. ClawConnect learns nothing about the runtime here — the fake below is
 * standing in for a host that owns its CLI, pairing, and project model
 * entirely on its own side of the callback boundary.
 */

function agentSessionMarker(obj: Record<string, unknown>): string {
  return `<agent-session>${JSON.stringify(obj)}</agent-session>`;
}

const RUNTIME_MARKER = agentSessionMarker({
  runtime: "example-runtime",
  provider: "anthropic-claude-code",
  sessionId: "thr-abc123",
  host: "workstation-1",
  state: "running",
  metadata: { runtimeProjectId: "proj-1", turnId: "turn-1" },
});

type FakeRuntime = {
  registry: AgentSessionRuntimeRegistry;
  inspectCalls: AgentSessionRef[];
  continueCalls: { ref: AgentSessionRef; prompt?: string }[];
  detachCalls: { ref: AgentSessionRef; reason?: string }[];
};

function fakeHostRuntime(
  opts: {
    inspect?: (ref: AgentSessionRef) => Promise<AgentSessionObservation | null>;
    onContinue?: (prompt?: string) => Promise<AgentSessionObservation | null>;
    onDetach?: (reason?: string) => Promise<AgentSessionObservation | null>;
    withContinue?: boolean;
    withDetach?: boolean;
  } = {},
): FakeRuntime {
  const inspectCalls: AgentSessionRef[] = [];
  const continueCalls: { ref: AgentSessionRef; prompt?: string }[] = [];
  const detachCalls: { ref: AgentSessionRef; reason?: string }[] = [];
  const registry = new AgentSessionRuntimeRegistry();
  registry.register({
    id: "example-runtime",
    provider: "anthropic-claude-code",
    async inspect(ref) {
      inspectCalls.push(ref);
      return opts.inspect ? opts.inspect(ref) : { state: "running" };
    },
    ...(opts.onContinue || opts.withContinue
      ? {
          async continue(ref: AgentSessionRef, request: { prompt?: string }) {
            continueCalls.push({ ref, prompt: request.prompt });
            return opts.onContinue ? opts.onContinue(request.prompt) : { state: "running" };
          },
        }
      : {}),
    ...(opts.onDetach || opts.withDetach
      ? {
          async detach(ref: AgentSessionRef, request: { reason?: string }) {
            detachCalls.push({ ref, reason: request.reason });
            return opts.onDetach ? opts.onDetach(request.reason) : { state: "dead" };
          },
        }
      : {}),
  });
  return { registry, inspectCalls, continueCalls, detachCalls };
}

describe("managed agent sessions on a host-registered runtime", () => {
  it("attaches straight from the runtime's own neutral marker, with no directive dialect", () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship the thing", context: `Delegated.\n${RUNTIME_MARKER}` });

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment).toMatchObject({
      runtime: "example-runtime",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      host: "workstation-1",
      status: "running",
      metadata: { runtimeProjectId: "proj-1", turnId: "turn-1" },
      delegatedTurnId: job.jobId,
    });
    // It rides on the existing snapshot key — one projection, not a second one
    // that could drift from it.
    expect(sessions.buildSnapshot(job).agentSession?.handle).toBe("thr-abc123");
  });

  it("never lets the raw marker reach the agent's prompt", () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship the thing", context: `Before.\n${RUNTIME_MARKER}\nAfter.` });
    expect(sessions.getJob(job.jobId)?.prompt.context).toBe("Before.\n\nAfter.");
  });

  it("re-stating the same session on a later turn refreshes it instead of growing the lineage", async () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const first = sessions.submitTask({ task: "start", context: RUNTIME_MARKER });
    const attachedAt = sessions.getAgentSessionAttachment(first.sessionKey)!.attachedAt;
    ctrl.finishChat("first turn done", 0);
    await wait();

    // The host passes the runtime's marker through on EVERY turn; a second
    // lineage record per turn would be noise, and superseding a live
    // attachment with a copy of itself would be a lie about what happened.
    const second = sessions.submitTask({
      task: "keep going",
      sessionKey: first.sessionKey,
      context: agentSessionMarker({
        runtime: "example-runtime",
        sessionId: "thr-abc123",
        state: "needs_input",
        remoteUrl: "https://runtime.example/threads/abc123",
        metadata: { turnId: "turn-2" },
      }),
    });

    expect(sessions.getAgentSessionLineage(first.sessionKey)).toHaveLength(1);
    const attachment = sessions.getAgentSessionAttachment(first.sessionKey)!;
    expect(attachment.attachedAt).toBe(attachedAt);
    expect(attachment.status).toBe("needs_input");
    expect(attachment.remoteUrl).toBe("https://runtime.example/threads/abc123");
    // Merged, not replaced: turn-1's project id is still known.
    expect(attachment.metadata).toEqual({ runtimeProjectId: "proj-1", turnId: "turn-2" });
    // Re-stating it IS the new turn delegating to it.
    expect(attachment.delegatedTurnId).toBe(second.jobId);
  });

  it("a different session on the same runtime still replaces, preserving lineage", async () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "start", context: RUNTIME_MARKER });
    ctrl.finishChat("first turn done", 0);
    await wait();
    sessions.submitTask({
      task: "start over",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "replace", runtime: "example-runtime", sessionId: "thr-second", host: "workstation-1", reason: "wrong project" }),
    });

    const lineage = sessions.getAgentSessionLineage(job.sessionKey);
    expect(lineage).toHaveLength(2);
    const superseded = lineage.find((r) => r.handle === "thr-abc123")!;
    expect(superseded.status).toBe("superseded");
    expect(superseded.reason).toBe("wrong project");
    const current = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(current.handle).toBe("thr-second");
    expect(current.replacesAttachmentId).toBe(superseded.id);
  });

  it("survives a connector restart with runtime, provider, and metadata intact", () => {
    const store = new FakeAttachmentStore();
    const hostRuntime = fakeHostRuntime();
    const first = fakeGateway();
    const sessionsA = new SessionManager(first.gateway, "main", undefined, store, hostRuntime.registry);
    const job = sessionsA.submitTask({ task: "ship it", context: RUNTIME_MARKER });

    // A brand-new manager over the same store, as after a process restart.
    const second = fakeGateway();
    const sessionsB = new SessionManager(second.gateway, "main", undefined, store, hostRuntime.registry);
    expect(sessionsB.getAgentSessionAttachment(job.sessionKey)).toMatchObject({
      runtime: "example-runtime",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      metadata: { runtimeProjectId: "proj-1" },
      delegatedTurnId: job.jobId,
    });
  });

  it("dispatches inspect to exactly the one attachment — never a scan, and never for a session with none", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({
        state: "needs_permission",
        alive: true,
        latestResponse: "may I run the migration?",
        lastEventAt: "2026-08-03T12:05:00.000Z",
        providerSessionId: "prov-9",
        metadata: { turnId: "turn-2" },
      }),
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);

    // A session that never attached must not produce a single runtime call.
    const unattached = sessions.submitTask({ task: "unrelated work" });
    await wait();
    expect(hostRuntime.inspectCalls).toHaveLength(0);
    ctrl.finishChat("done", 0);
    await wait();

    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat("done", 1);
    await wait();
    await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });

    expect(hostRuntime.inspectCalls).toHaveLength(1);
    // The neutral ref, not ClawConnect's record: no lineage id, no turn token.
    expect(hostRuntime.inspectCalls[0]).toEqual({
      runtime: "example-runtime",
      provider: "anthropic-claude-code",
      sessionId: "thr-abc123",
      providerSessionId: undefined,
      host: "workstation-1",
      remoteUrl: undefined,
      metadata: { runtimeProjectId: "proj-1", turnId: "turn-1" },
      lastKnownState: "running",
    });
    expect(unattached.sessionKey).not.toBe(job.sessionKey);

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_permission");
    expect(attachment.alive).toBe(true);
    expect(attachment.latestResponse).toBe("may I run the migration?");
    expect(attachment.lastEventAt).toBe(Date.parse("2026-08-03T12:05:00.000Z"));
    expect(attachment.providerSessionId).toBe("prov-9");
    expect(attachment.metadata).toEqual({ runtimeProjectId: "proj-1", turnId: "turn-2" });
    // A blocked session's partial text is never promoted to a turn result.
    expect(attachment.lastResult).toBeUndefined();
  });

  it("delivers a follow-up turn through the runtime's continue callback", async () => {
    const hostRuntime = fakeHostRuntime({ onContinue: async () => ({ state: "running", latestResponse: "on it" }) });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "nudge it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", prompt: "also update the docs" }),
    });
    await wait();

    expect(hostRuntime.continueCalls).toEqual([
      { ref: expect.objectContaining({ runtime: "example-runtime", sessionId: "thr-abc123" }), prompt: "also update the docs" },
    ]);
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.latestResponse).toBe("on it");
  });

  it("reports a precise unsupported_operation instead of failing the task", async () => {
    const hostRuntime = fakeHostRuntime(); // inspect only — no continue callback registered
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    const nudge = sessions.submitTask({
      task: "nudge it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", prompt: "also update the docs" }),
    });
    await wait();

    // The TASK is unaffected — a delegation that cannot be driven is not a
    // reason for the turn itself to fail.
    expect(nudge.status).toBe("running");
    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.error).toMatchObject({ code: "unsupported_operation" });
    // A failed ask teaches nothing about the session, so what we last knew survives.
    expect(attachment.status).toBe("running");
  });

  it("reports unknown_runtime for a runtime this build was never taught, and keeps the attachment readable", async () => {
    const ctrl = fakeGateway();
    // No registry at all: a example-runtime attachment written by a build that had
    // one must still round-trip, not be dropped.
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.runtime).toBe("example-runtime");

    const status = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(status?.state).toBe("unavailable");
    expect(status?.error?.code).toBe("unknown_runtime");
    expect(status?.detail).toContain("Last reported state: running.");
    // Still exactly what the marker said — an unanswerable read changed nothing.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("running");
  });

  it("returns undefined rather than reaching for anything when nothing is attached", async () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "no delegation here" });
    expect(await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" })).toBeUndefined();
    expect(hostRuntime.inspectCalls).toHaveLength(0);
  });

  it("recovers a completed turn's final response through the runtime, marked provisional", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({
        state: "completed",
        finalResponse: "the managed session's real answer",
        lastEventAt: Date.now(),
        termination: { reason: "completed" },
      }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const recovered = sessions.getJob(job.jobId)!;
    expect(recovered.status).toBe("completed");
    expect(recovered.summary).toBe("the managed session's real answer");
    // The only delegated provenance value there is. Core does not restate a
    // particular runtime's evidentiary claim — the record already names WHICH
    // runtime answered, which is more precise. See ResultSource.
    expect(recovered.resultSource).toBe("agent-session");
    expect(recovered.terminalReason).toBe("agent-session-recovery");
    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary).toBe("the managed session's real answer");
    expect(attachment.lastResult?.outputRef).toBe("thr-abc123");
    expect(attachment.termination).toMatchObject({ reason: "completed" });

    // Provisional: the real parent transcript still wins when it shows up.
    ctrl.setPoll(async () => "the real parent answer, arrived late");
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    expect(sessions.getJob(job.jobId)?.summary).toBe("the real parent answer, arrived late");
    expect(sessions.getJob(job.jobId)?.resultSource).toBe("parent");
  });

  it("never completes a parent from a session that is waiting on a human", async () => {
    for (const blocked of ["needs_input", "needs_permission"]) {
      const hostRuntime = fakeHostRuntime({
        inspect: async () => ({
          state: blocked,
          // Text is present and readable — the point is that being blocked
          // beats having something quotable.
          latestResponse: "should I force-push?",
          finalResponse: "should I force-push?",
          lastEventAt: Date.now(),
        }),
      });
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
      const job = sessions.submitTask({
        task: "ship it",
        // The marker itself reports the blocked state, which is exactly how a
        // runtime announces "I'm waiting on a human" at delegation time.
        context: agentSessionMarker({ runtime: "example-runtime", sessionId: "thr-abc123", host: "workstation-1", state: blocked }),
      });
      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await wait();

      const settled = sessions.getJob(job.jobId)!;
      expect(settled.status, blocked).toBe("completed_no_summary");
      expect(settled.resultSource, blocked).toBe("parent");
      // The attachment stays actionable, which is the whole point.
      expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status, blocked).toBe(blocked);
      expect(sessions.getAgentSessionAttachment(job.sessionKey)?.lastResult, blocked).toBeUndefined();

      // …and the JOB says so too, rather than reading as an ordinary turn that
      // simply had nothing to report: same status (no new JobStatus, so every
      // existing consumer keeps working), different terminalReason and summary.
      expect(settled.terminalReason, blocked).toBe(`delegate-blocked:${blocked}`);
      expect(settled.summary, blocked).not.toBe(NO_SUMMARY_SENTINEL);
      expect(settled.summary, blocked).toContain("example-runtime/thr-abc123");
      expect(settled.summary, blocked).toContain(
        blocked === "needs_permission" ? "waiting for permission" : "waiting for input",
      );
      const snapshot = sessions.buildSnapshot(settled);
      expect(blockedDelegationNotice(snapshot), blocked).toBe(settled.summary);
    }
  });

  it("leaves an ordinary empty turn exactly as it was — sentinel summary, unchanged reason", async () => {
    const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state: "running" }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const settled = sessions.getJob(job.jobId)!;
    expect(settled.status).toBe("completed_no_summary");
    expect(settled.summary).toBe(NO_SUMMARY_SENTINEL);
    expect(settled.terminalReason).toBe("late-recovery-exhausted");
    expect(blockedDelegationNotice(sessions.buildSnapshot(settled))).toBeUndefined();
  });

  it("relabels a terminal turn when a later poll is what discovers the block", async () => {
    let state = "running";
    const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    // Nothing was blocked when the turn gave up.
    expect(sessions.getJob(job.jobId)?.terminalReason).toBe("late-recovery-exhausted");

    // The session asks a question afterwards; the next poll is what sees it.
    state = "needs_input";
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);

    const settled = sessions.getJob(job.jobId)!;
    expect(settled.status).toBe("completed_no_summary");
    expect(settled.terminalReason).toBe("delegate-blocked:needs_input");
    expect(settled.summary).toContain("example-runtime/thr-abc123");
    // Idempotent: polling again neither re-labels nor re-logs.
    const version = settled.outcomeVersion;
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    expect(sessions.getJob(job.jobId)?.outcomeVersion).toBe(version);
  });

  it("does not blame this turn for a block on a delegation an EARLIER turn owned", async () => {
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state: "needs_input" }) });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const turn1 = sessions.submitTask({
      task: "delegate it",
      context: agentSessionMarker({ runtime: "example-runtime", sessionId: "thr-abc123", host: "workstation-1", state: "needs_input" }),
    });
    ctrl.finishChat("handed off", 0);
    await wait();

    // A later turn on the same session that never claimed the attachment.
    const turn2 = sessions.submitTask({ task: "something unrelated", sessionKey: turn1.sessionKey });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 1);
    await wait();

    const settled = sessions.getJob(turn2.jobId)!;
    expect(settled.terminalReason).toBe("late-recovery-exhausted");
    expect(settled.summary).toBe(NO_SUMMARY_SENTINEL);
    expect(blockedDelegationNotice(sessions.buildSnapshot(settled))).toBeUndefined();
  });

  it("refuses a result it cannot date — an undatable answer is not proof of this turn", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({ state: "completed", finalResponse: "an answer from who knows when" }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.lastResult).toBeUndefined();
  });

  it("refuses a result that predates the turn it would be answering", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({ state: "completed", finalResponse: "an answer from a previous delegation", lastEventAt: 1_000 }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
  });

  it("drops a read that resolves after the attachment was re-delegated to a newer turn", async () => {
    const gate = deferred<AgentSessionObservation>();
    const hostRuntime = fakeHostRuntime({ inspect: () => gate.promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });

    // A read for THIS turn goes out and hangs.
    const inFlight = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    await wait();
    ctrl.finishChat("first turn done", 0);
    await wait();

    // A newer turn claims the same attachment while that read is outstanding.
    const newer = sessions.submitTask({
      task: "keep going",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "continue", status: "needs_input" }),
    });
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.delegatedTurnId).toBe(newer.jobId);

    gate.resolve({ state: "completed", finalResponse: "answer for the OLD turn", lastEventAt: Date.now() });
    const status = await inFlight;

    // The answer is still reported to the caller who asked...
    expect(status?.state).toBe("completed");
    // ...but it is not allowed to become durable state for a turn that never
    // asked for it.
    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.lastResult).toBeUndefined();
  });

  it("never lets an older read overtake a newer one on the same attachment and turn", async () => {
    const gates = [deferred<AgentSessionObservation>(), deferred<AgentSessionObservation>()];
    let call = 0;
    const hostRuntime = fakeHostRuntime({ inspect: () => gates[call++].promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });

    const older = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    const newer = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });

    // The NEWER read lands first, then the older one straggles in behind it.
    gates[1].resolve({ state: "needs_input", latestResponse: "current state" });
    await newer;
    gates[0].resolve({ state: "running", latestResponse: "state from a moment ago" });
    await older;

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.latestResponse).toBe("current state");
  });

  it("never lets an in-flight passive read overwrite a status stated after it went out", async () => {
    // `inspect` is a passive refresh: it deliberately does NOT re-stamp the
    // delegated turn, so the delegation check cannot catch this one. The
    // observation token is what makes an explicitly stated status durable
    // against a read that was already outstanding when it was stated.
    const gate = deferred<AgentSessionObservation>();
    const hostRuntime = fakeHostRuntime({ inspect: () => gate.promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });

    const inFlight = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    await wait();
    ctrl.finishChat("first turn done", 0);
    await wait();

    // The host sees the session block and says so, on the same delegation.
    sessions.submitTask({
      task: "just looking",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "inspect", status: "needs_input" }),
    });
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.delegatedTurnId).toBe(job.jobId);

    gate.resolve({ state: "running", latestResponse: "still chugging" });
    await inFlight;

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.latestResponse).toBeUndefined();
  });

  it("still takes a token for a stated status that REPEATS the stored one, so an older read cannot overtake it", async () => {
    // The status field looks identical before and after this report, which is
    // exactly why it is dangerous: the report is still the newest thing anyone
    // has said about the session, and the read that went out before it is
    // still older. Advancing the token only when the VALUE changed left the
    // record's freshness mark behind the report, so the older read passed the
    // compare-and-set and replaced a state the host had just re-affirmed.
    const gate = deferred<AgentSessionObservation>();
    const hostRuntime = fakeHostRuntime({ inspect: () => gate.promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("running");

    const inFlight = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    await wait();
    ctrl.finishChat("first turn done", 0);
    await wait();
    const before = sessions.getAgentSessionAttachment(job.sessionKey)!;

    // The host re-states exactly what the record already says.
    sessions.submitTask({
      task: "just looking",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "inspect", status: "running" }),
    });
    const restated = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(restated.status).toBe("running");
    expect(restated.observationToken ?? 0).toBeGreaterThan(before.observationToken ?? 0);
    expect(restated.lastObservedAt).toBeGreaterThanOrEqual(restated.attachedAt);

    // The older read straggles in behind it, disagreeing.
    gate.resolve({ state: "needs_input", latestResponse: "state from before the report" });
    await inFlight;

    const attachment = sessions.getAgentSessionAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("running");
    expect(attachment.latestResponse).toBeUndefined();
  });

  it("asks the runtime to stop the session only when the detach says so, and detaches locally either way", async () => {
    const quiet = fakeHostRuntime({ withDetach: true });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, quiet.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "stop tracking it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "detach", reason: "handed back to me" }),
    });
    await wait();
    expect(quiet.detachCalls).toHaveLength(0);
    expect(sessions.getAgentSessionAttachment(job.sessionKey)).toBeUndefined();
    expect(sessions.getAgentSessionLineage(job.sessionKey)[0]).toMatchObject({ status: "detached", reason: "handed back to me" });
  });

  it("dispatches an opt-in runtime stop, and a runtime that throws cannot wedge the conversation", async () => {
    const hostRuntime = fakeHostRuntime({
      onDetach: async () => {
        throw new Error("runtime endpoint unreachable");
      },
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "kill it",
      sessionKey: job.sessionKey,
      context: directiveBlock({ op: "detach", reason: "abandoned", stopRuntime: true }),
    });
    await wait();

    expect(hostRuntime.detachCalls).toEqual([{ ref: expect.objectContaining({ sessionId: "thr-abc123" }), reason: "abandoned" }]);
    // The local detach is the durable decision; a runtime that is down must
    // not be able to hold the conversation hostage.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)).toBeUndefined();
  });

  /**
   * The counterpart of the two tests deleted here on 2026-08-18, which
   * asserted that claude-fleet fell back to a built-in tmux adapter and that a
   * host-registered runtime beat it. There is no built-in adapter to beat any
   * more: an id nobody registered has nobody to ask, and says so precisely
   * rather than failing.
   */
  it("an attachment naming a runtime nobody registered reports unknown_runtime, not an error", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, fakeHostRuntime().registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: directiveBlock({ op: "attach", runtime: "nobody-registered-this", handle: "cf-foo", host: "workstation-1" }),
    });

    const inspected = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(inspected?.error).toMatchObject({ code: "unknown_runtime" });
    // The record itself is untouched — a read that could not happen says
    // nothing about the session.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.runtime).toBe("nobody-registered-this");
  });

  /**
   * The observation token is durable (it lives on the record) while its
   * counter is in-memory. A process that restarts at zero mints tokens the
   * compare-and-set is bound to refuse, so every observation — and every
   * recovery that depends on one landing — silently does nothing.
   */
  describe("after a restart, the observation token resumes above what was persisted", () => {
    function persistedState(sessionKey: string, overrides: Partial<AgentSessionAttachment> = {}): SessionAttachmentState {
      const record: AgentSessionAttachment = {
        id: "att-1",
        runtime: "example-runtime",
        provider: "anthropic-claude-code",
        handle: "thr-abc123",
        host: "workstation-1",
        attachedAt: 1_000,
        status: "running",
        observationToken: 42,
        ...overrides,
      };
      return { sessionKey, currentAttachmentId: record.id, attachments: { [record.id]: record } };
    }

    it("lets the first post-restart observation land instead of refusing it", async () => {
      const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state: "needs_input", latestResponse: "which branch?" }) });
      const store = new FakeAttachmentStore([persistedState("sess-restart")]);
      const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store, hostRuntime.registry);

      await sessions.runAgentSessionOp("sess-restart", { op: "inspect" });

      const attachment = sessions.getAgentSessionAttachment("sess-restart")!;
      expect(attachment.status).toBe("needs_input");
      expect(attachment.latestResponse).toBe("which branch?");
      // Strictly above the persisted high-water mark, so the CAS still orders
      // reads correctly across the restart boundary.
      expect(attachment.observationToken).toBeGreaterThan(42);
    });

    it("resumes above a SUPERSEDED record's token too — lineage carries the high-water mark", async () => {
      const current: AgentSessionAttachment = {
        id: "att-current",
        runtime: "example-runtime",
        handle: "thr-abc123",
        attachedAt: 2_000,
        status: "running",
        observationToken: 3,
      };
      const superseded: AgentSessionAttachment = {
        id: "att-old",
        runtime: "example-runtime",
        handle: "thr-older",
        attachedAt: 1_000,
        status: "superseded",
        observationToken: 99,
      };
      const store = new FakeAttachmentStore([
        {
          sessionKey: "sess-lineage",
          currentAttachmentId: current.id,
          attachments: { [current.id]: current, [superseded.id]: superseded },
        },
      ]);
      const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state: "idle" }) });
      const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store, hostRuntime.registry);

      await sessions.runAgentSessionOp("sess-lineage", { op: "inspect" });
      expect(sessions.getAgentSessionAttachment("sess-lineage")?.observationToken).toBeGreaterThan(99);
    });

    it("recovers a delegated turn's result after a restart, which a stale token would silently block", async () => {
      const hostRuntime = fakeHostRuntime({
        inspect: async () => ({
          state: "completed",
          finalResponse: "the answer, produced after the connector restarted",
          lastEventAt: Date.now(),
        }),
      });
      const store = new FakeAttachmentStore([persistedState("sess-restart")]);
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, store, hostRuntime.registry);

      // The new turn re-states the attachment (the host passes the marker every
      // turn), which is what delegates it to THIS job. No `state` in the
      // marker, so nothing re-stamps the token on the way in.
      const job = sessions.submitTask({
        task: "keep going",
        sessionKey: "sess-restart",
        context: agentSessionMarker({ runtime: "example-runtime", sessionId: "thr-abc123", host: "workstation-1" }),
      });
      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await wait();

      const recovered = sessions.getJob(job.jobId)!;
      expect(recovered.status).toBe("completed");
      expect(recovered.summary).toBe("the answer, produced after the connector restarted");
      expect(recovered.resultSource).toBe("agent-session");
    });
  });

  it("abandons a runtime that never answers instead of wedging the turn out of ever finishing", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves, and never rejects — the shape a hung HTTP call takes.
      const hostRuntime = fakeHostRuntime({ inspect: () => new Promise<never>(() => {}) });
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
      const job = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });

      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await vi.advanceTimersByTimeAsync(10);
      // Recovery is out at the runtime and has nothing back yet.
      expect(sessions.getJob(job.jobId)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(AGENT_SESSION_CALL_TIMEOUT_MS + 100);

      const settled = sessions.getJob(job.jobId)!;
      expect(settled.status).toBe("completed_no_summary");
      expect(settled.terminalReason).toBe("late-recovery-exhausted");
      // The read failed; the SESSION's last known state is untouched by that.
      expect(sessions.getAgentSessionAttachment(job.sessionKey)?.status).toBe("running");
      expect(sessions.getAgentSessionAttachment(job.sessionKey)?.error).toMatchObject({ code: "inspect_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not present a prior turn's finished result as the current turn's state", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({
        state: "completed",
        finalResponse: "turn one's answer",
        latestResponse: "turn one's answer",
        alive: false,
        lastEventAt: Date.now(),
        termination: { reason: "completed" },
      }),
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const turn1 = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    await sessions.runAgentSessionOp(turn1.sessionKey, { op: "inspect" });

    const afterTurn1 = sessions.getAgentSessionAttachment(turn1.sessionKey)!;
    expect(afterTurn1.lastResult?.summary).toBe("turn one's answer");
    expect(afterTurn1.status).toBe("completed");
    ctrl.finishChat("turn one done", 0);
    await wait();

    // A NEW turn claims the same session — the marker names it again, with no
    // state of its own to assert.
    const turn2 = sessions.submitTask({
      task: "now do the next thing",
      sessionKey: turn1.sessionKey,
      context: agentSessionMarker({ runtime: "example-runtime", sessionId: "thr-abc123", host: "workstation-1" }),
    });

    const attachment = sessions.getAgentSessionAttachment(turn1.sessionKey)!;
    expect(attachment.delegatedTurnId).toBe(turn2.jobId);
    // Everything that described turn one's OUTCOME is gone…
    expect(attachment.lastResult).toBeUndefined();
    expect(attachment.termination).toBeUndefined();
    expect(attachment.latestResponse).toBeUndefined();
    expect(attachment.alive).toBeUndefined();
    expect(attachment.status).toBe("starting");
    // …while the session's identity and lineage are exactly as they were.
    expect(attachment.id).toBe(afterTurn1.id);
    expect(attachment.attachedAt).toBe(afterTurn1.attachedAt);
    expect(attachment.runtime).toBe("example-runtime");
    expect(attachment.handle).toBe("thr-abc123");
    expect(attachment.metadata).toEqual({ runtimeProjectId: "proj-1", turnId: "turn-1" });
    expect(sessions.getAgentSessionLineage(turn1.sessionKey)).toHaveLength(1);
  });

  it("clears a prior turn's outcome on a continue from a later turn, keeping a stated status", async () => {
    const hostRuntime = fakeHostRuntime({
      inspect: async () => ({ state: "idle", finalResponse: "turn one's answer", lastEventAt: Date.now() }),
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const turn1 = sessions.submitTask({ task: "ship it", context: RUNTIME_MARKER });
    await sessions.runAgentSessionOp(turn1.sessionKey, { op: "inspect" });
    expect(sessions.getAgentSessionAttachment(turn1.sessionKey)?.lastResult).toBeDefined();
    ctrl.finishChat("turn one done", 0);
    await wait();

    const turn2 = sessions.submitTask({
      task: "keep going",
      sessionKey: turn1.sessionKey,
      context: directiveBlock({ op: "continue", status: "running" }),
    });

    const attachment = sessions.getAgentSessionAttachment(turn1.sessionKey)!;
    expect(attachment.delegatedTurnId).toBe(turn2.jobId);
    expect(attachment.lastResult).toBeUndefined();
    // A status the directive states outranks the reset's "starting".
    expect(attachment.status).toBe("running");
  });

  it("takes the provider from the registered runtime, not from what the marker claimed", async () => {
    const hostRuntime = fakeHostRuntime({ inspect: async () => ({ state: "running" }) });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    const job = sessions.submitTask({
      task: "ship it",
      context: agentSessionMarker({
        runtime: "example-runtime",
        provider: "some-other-model",
        sessionId: "thr-abc123",
        host: "workstation-1",
      }),
    });

    const status = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(hostRuntime.inspectCalls[0].provider).toBe("anthropic-claude-code");
    expect(status?.provider).toBe("anthropic-claude-code");
    // The record heals to what the runtime says, so every later snapshot is right too.
    expect(sessions.getAgentSessionAttachment(job.sessionKey)?.provider).toBe("anthropic-claude-code");
  });

  it("exposes registered runtimes for wiring assertions without exposing any session", () => {
    const hostRuntime = fakeHostRuntime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, hostRuntime.registry);
    expect(sessions.hasAgentSessionRuntime("example-runtime")).toBe(true);
    expect(sessions.hasAgentSessionRuntime("some-other-runtime")).toBe(false);
    expect(new SessionManager(fakeGateway().gateway).hasAgentSessionRuntime("example-runtime")).toBe(false);
  });
});
