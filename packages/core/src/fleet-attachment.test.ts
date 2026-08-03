import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_CALL_TIMEOUT_MS,
  AgentSessionRuntimeRegistry,
  blockedDelegationNotice,
  type AgentSessionObservation,
  type AgentSessionRef,
} from "./agent-session.ts";
import { FLEET_RESULT_SUMMARY_MAX, SessionManager } from "./session.ts";
import type { OpenClawGateway, RunObservation } from "./gateway.ts";
import type { FleetAdapter, FleetHandoff } from "./fleet-adapter.ts";
import type { FleetAttachmentStore } from "./fleet-attachment-store.ts";
import type { JobStore, PersistedJob } from "./job-store.ts";
import { NO_SUMMARY_SENTINEL, type FleetAttachmentRecord, type GatewayEvent, type SessionFleetState } from "./types.ts";

/**
 * The managed, session-scoped Fleet attachment feature: attach/continue/
 * replace/detach/inspect transitions parsed from a structured directive in
 * TaskInput.context (see fleet-handoff.ts), persisted independently of job
 * lifecycle (see fleet-attachment-store.ts), and consulted as recovery order
 * tier 3 — ONLY after the parent's own live+transcript recovery has already
 * given up (see session.ts's tryFleetRecovery and its two call sites). See
 * docs/architecture/2026-08-02-managed-fleet-attachment-plan.md.
 */

function fleetBlock(directive: Record<string, unknown>): string {
  return `[[clawconnect:fleet]]${JSON.stringify(directive)}[[/clawconnect:fleet]]`;
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

function fakeFleetAdapter(
  opts: {
    isLive?: boolean | ((a: FleetAttachmentRecord) => Promise<boolean>);
    handoff?: FleetHandoff | null | ((a: FleetAttachmentRecord) => Promise<FleetHandoff | null>);
  } = {},
): FleetAdapter & { isLiveCalls: FleetAttachmentRecord[]; handoffCalls: FleetAttachmentRecord[] } {
  const isLiveCalls: FleetAttachmentRecord[] = [];
  const handoffCalls: FleetAttachmentRecord[] = [];
  return {
    isLiveCalls,
    handoffCalls,
    async isLive(a) {
      isLiveCalls.push(a);
      if (typeof opts.isLive === "function") return opts.isLive(a);
      return opts.isLive ?? false;
    },
    async readTerminalHandoff(a) {
      handoffCalls.push(a);
      if (typeof opts.handoff === "function") return opts.handoff(a);
      return opts.handoff ?? null;
    },
  };
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
class FakeFleetAttachmentStore implements FleetAttachmentStore {
  saved: SessionFleetState[][] = [];
  constructor(private preloaded: SessionFleetState[] = []) {}
  load(): SessionFleetState[] {
    return this.saved.at(-1) ?? this.preloaded;
  }
  save(states: SessionFleetState[]): void {
    this.saved.push(states);
  }
  get latestSave(): SessionFleetState[] | undefined {
    return this.saved.at(-1);
  }
}

class FakeJobStoreForFleet implements JobStore {
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
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3", providerSessionId: "prov-1", worktree: "/w" }),
    });

    const attachment = sessions.getFleetAttachment(job.sessionKey);
    expect(attachment).toMatchObject({ handle: "cf-foo", host: "minip3", providerSessionId: "prov-1", worktree: "/w", status: "starting" });

    const snapshot = sessions.buildSnapshot(job);
    expect(snapshot.fleetAttachment).toEqual(attachment);
  });

  it("the directive is stripped from the message sent to the agent", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    sessions.submitTask({
      task: "do the thing",
      context: `before ${fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" })} after`,
    });
    expect(sessions.getFleetAttachment(sessions.listSessions()[0]?.sessionKey ?? "")).toBeDefined();
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
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("first done", 0);
    await wait();

    const before = sessions.getFleetAttachment(first.sessionKey);
    // Second turn, same session, NO directive at all.
    const second = sessions.submitTask({ task: "second", sessionKey: first.sessionKey });
    expect(second.status).toBe("running"); // proves this is a REAL second turn, not a busy rejection
    const after = sessions.getFleetAttachment(second.sessionKey);
    expect(after).toEqual(before);
  });

  it("explicit replacement preserves superseded lineage", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;

    ctrl.finishChat("done", 0);
    await wait();
    sessions.submitTask({
      task: "replace it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "replace", handle: "cf-bar", host: "minip3", reason: "stale worktree" }),
    });

    const current = sessions.getFleetAttachment(job.sessionKey)!;
    expect(current.handle).toBe("cf-bar");
    expect(current.replacesAttachmentId).toBe(original.id);

    const lineage = sessions.getFleetLineage(job.sessionKey);
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
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "detach it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "detach", reason: "task finished" }),
    });

    expect(sessions.getFleetAttachment(job.sessionKey)).toBeUndefined();
    const lineage = sessions.getFleetLineage(job.sessionKey);
    const detached = lineage.find((a) => a.id === original.id)!;
    expect(detached.status).toBe("detached");
    expect(detached.reason).toBe("task finished");
  });

  it("needs_input reported via continue stays actionable — visible on the snapshot without forcing the job terminal", async () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "check in",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "continue", status: "needs_input" }),
    });

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    // The job this ships alongside is unaffected — the attachment's status is
    // orthogonal to whether the parent job itself is terminal.
    const latestJob = sessions.getLatestJobForSession(job.sessionKey)!;
    expect(latestJob.status).toBe("running");
  });

  it("inspect with an explicit status never starts the background isLive probe at all", async () => {
    const adapter = fakeFleetAdapter({ isLive: true });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "inspect with explicit status",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "inspect", status: "needs_input" }),
    });

    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("needs_input");
    expect(adapter.isLiveCalls).toHaveLength(0);
  });

  it("an explicit needs_input status is never overwritten by an in-flight isLive probe from an EARLIER plain inspect", async () => {
    const { promise: isLivePromise, resolve: resolveIsLive } = deferred<boolean>();
    const adapter = fakeFleetAdapter({ isLive: () => isLivePromise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("done", 0);
    await wait();

    // A plain inspect (no explicit status) — its isLive call is now in
    // flight, deliberately held open.
    sessions.submitTask({ task: "inspect", sessionKey: job.sessionKey, context: fleetBlock({ op: "inspect" }) });
    expect(adapter.isLiveCalls).toHaveLength(1);
    ctrl.finishChat("inspect turn done", 1);
    await wait();

    // Clawdy explicitly reports needs_input BEFORE the stale probe resolves.
    sessions.submitTask({
      task: "check in",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "continue", status: "needs_input" }),
    });
    ctrl.finishChat("continue turn done", 2);
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("needs_input");
    // The explicit-status continue must not have ALSO started a new probe.
    expect(adapter.isLiveCalls).toHaveLength(1);

    // NOW the stale isLive resolves true ("it's running!") — after the fact.
    resolveIsLive(true);
    await wait();

    // Must still read needs_input — the callback re-reads fresh state rather
    // than trusting the "starting"/whatever it closed over before the await.
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("needs_input");
  });

  it("no attachment triggers no adapter call at all (no global Fleet scan)", () => {
    const adapter = fakeFleetAdapter();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    sessions.submitTask({ task: "no fleet involved here" });
    ctrl.finishChat("done", 0);
    expect(adapter.isLiveCalls).toHaveLength(0);
    expect(adapter.handoffCalls).toHaveLength(0);
  });
});

describe("Fleet attachment restart persistence", () => {
  it("attachment survives a connector restart via a fresh SessionManager over the same store", () => {
    const store = new FakeFleetAttachmentStore();
    const ctrl = fakeGateway();
    const before = new SessionManager(ctrl.gateway, "main", undefined, store);
    const job = before.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3", providerSessionId: "prov-1" }),
    });
    const original = before.getFleetAttachment(job.sessionKey)!;
    expect(store.latestSave).toBeDefined();

    // Simulate a restart: a brand new SessionManager, same underlying store.
    const after = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    expect(after.getFleetAttachment(job.sessionKey)).toEqual(original);
  });

  it("old PersistedJob/SessionFleetState records without the new fields are still readable", () => {
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
    const emptyFleetStore: FleetAttachmentStore = { load: () => [], save: () => {} };
    const withEmptyFleet = new SessionManager(fakeGateway().gateway, "main", undefined, emptyFleetStore);
    expect(withEmptyFleet.getFleetAttachment("agent:main:main:thread:legacy")).toBeUndefined();
  });

  it("a currentAttachmentId with no matching attachments entry never throws — reads as no current attachment", () => {
    const malformed: SessionFleetState = {
      sessionKey: "agent:main:main:thread:malformed-1",
      currentAttachmentId: "ghost-id",
      attachments: {}, // no entry for ghost-id
    };
    const store: FleetAttachmentStore = { load: () => [malformed], save: () => {} };
    expect(() => new SessionManager(fakeGateway().gateway, "main", undefined, store)).not.toThrow();
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    expect(sessions.getFleetAttachment(malformed.sessionKey)).toBeUndefined();
    expect(sessions.getFleetLineage(malformed.sessionKey)).toEqual([]);
  });

  it("a record missing the attachments field entirely never throws, and valid lineage in a DIFFERENT session in the same load() is preserved", () => {
    const missingAttachmentsField = {
      sessionKey: "agent:main:main:thread:malformed-2",
      currentAttachmentId: "some-id",
      // attachments field entirely absent — e.g. a truncated/hand-edited file.
    } as unknown as SessionFleetState;
    const validRecord: FleetAttachmentRecord = {
      id: "att-valid",
      runtime: "claude-fleet",
      handle: "cf-good",
      host: "minip3",
      attachedAt: 1000,
      status: "running",
    };
    const validState: SessionFleetState = {
      sessionKey: "agent:main:main:thread:valid",
      currentAttachmentId: "att-valid",
      attachments: { "att-valid": validRecord },
    };
    const store: FleetAttachmentStore = { load: () => [missingAttachmentsField, validState], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);

    expect(() => sessions.getFleetAttachment(missingAttachmentsField.sessionKey)).not.toThrow();
    expect(sessions.getFleetAttachment(missingAttachmentsField.sessionKey)).toBeUndefined();
    expect(sessions.getFleetLineage(missingAttachmentsField.sessionKey)).toEqual([]);

    // The OTHER session's valid record in the same store load is untouched.
    expect(sessions.getFleetAttachment(validState.sessionKey)).toEqual(validRecord);
    expect(sessions.getFleetLineage(validState.sessionKey)).toEqual([validRecord]);
  });

  it("a currentAttachmentId that IS resolvable, alongside other malformed entries in the same session's attachments, preserves the valid lineage", () => {
    const validRecord: FleetAttachmentRecord = {
      id: "att-good",
      runtime: "claude-fleet",
      handle: "cf-good",
      host: "minip3",
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
    } as unknown as SessionFleetState;
    const store: FleetAttachmentStore = { load: () => [mixed], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);

    expect(sessions.getFleetAttachment(mixed.sessionKey)).toEqual(validRecord);
    expect(sessions.getFleetLineage(mixed.sessionKey)).toEqual([validRecord]);
  });

  it("buildSnapshot for a job on a session with malformed persisted fleet state never throws and simply omits fleetAttachment", () => {
    const malformed = {
      sessionKey: "agent:main:main:thread:malformed-snapshot",
      currentAttachmentId: "ghost",
    } as unknown as SessionFleetState;
    const store: FleetAttachmentStore = { load: () => [malformed], save: () => {} };
    const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store);
    const job = sessions.submitTask({ task: "do the thing", sessionKey: malformed.sessionKey });

    expect(() => sessions.buildSnapshot(job)).not.toThrow();
    expect(sessions.buildSnapshot(job).fleetAttachment).toBeUndefined();
  });

  it("parent runId is persisted immediately when chat.send's onRunId fires, before chat() resolves", () => {
    const jobStore = new FakeJobStoreForFleet();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", jobStore);
    const job = sessions.submitTask({ task: "do the thing" });

    // chat() has NOT resolved yet — this fake gateway never settles on its
    // own — but onRunId already fired synchronously inside chat.send.
    expect(job.parentRunId).toBe(`run-for-${job.sessionKey.slice(-8)}`);
    expect(jobStore.latestSave?.find((j) => j.jobId === job.jobId)?.parentRunId).toBe(job.parentRunId);
  });
});

describe("Fleet-adapter recovery order (tier 3, after parent live+transcript recovery gives up)", () => {
  it("child completion does not prematurely finish an active parent — the adapter is never consulted while the job is running", async () => {
    const adapter = fakeFleetAdapter({ handoff: { text: "child already finished", resultAt: Date.now() } });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    await wait();
    expect(job.status).toBe("running");
    expect(adapter.handoffCalls).toHaveLength(0);
  });

  it("empty parent final + completed attached child recovers the child result with resultSource=fleet-transcript", async () => {
    // The handoff form computes resultAt lazily, at ADAPTER-CALL time — well
    // after job.startedAt — matching the real timing (the child produces its
    // answer sometime after the parent turn began, never before).
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "the child's real answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const recovered = sessions.getJob(job.jobId)!;
    expect(recovered.status).toBe("completed");
    expect(recovered.summary).toBe("the child's real answer");
    expect(recovered.resultSource).toBe("fleet-transcript");
    expect(recovered.terminalReason).toBe("fleet-transcript-recovery");

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary).toBe("the child's real answer");
    expect(attachment.lastResult?.outputRef).toBe("cf-foo");
  });

  it("output is capped, with the durable transcript reference preserved on the attachment", async () => {
    const longText = "x".repeat(FLEET_RESULT_SUMMARY_MAX + 500);
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: longText, resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3", worktree: "/w" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    // The job's own summary is never capped (matches every other terminal
    // path in this file) — only the attachment's lastResult preview is.
    expect(sessions.getJob(job.jobId)?.summary).toBe(longText);
    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary?.length).toBe(FLEET_RESULT_SUMMARY_MAX);
    expect(attachment.lastResult?.summary?.endsWith("…")).toBe(true);
    expect(attachment.lastResult?.outputRef).toBe("cf-foo:/w");
  });

  it("a still-live / not-yet-trusted child does not get synthesized into a fake completion", async () => {
    const adapter = fakeFleetAdapter({ handoff: null });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
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

  it("repeated recovery is idempotent — calling the fallback again with the same handoff doesn't change the outcome or duplicate lineage", async () => {
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "stable answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
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
    expect(secondOutcome.resultSource).toBe("fleet-transcript");
    expect(sessions.getFleetLineage(job.sessionKey)).toHaveLength(1);
  });

  it("late parent final safely replaces the provisional Fleet result", async () => {
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "child's provisional answer", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(job.jobId)?.resultSource).toBe("fleet-transcript");

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
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "stale output from ages ago", resultAt: staleResultAt }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const result = sessions.getJob(job.jobId)!;
    expect(result.status).toBe("completed_no_summary");
    expect(result.resultSource).toBe("parent");
    expect(result.summary).not.toBe("stale output from ages ago");
  });

  it("an attachment left current from an EARLIER delegated turn does not answer a LATER, unrelated turn on the same session", async () => {
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "answer to the FIRST delegated task", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);

    // Turn 1: attaches and delegates. Its own recovery correctly succeeds.
    const turn1 = sessions.submitTask({
      task: "delegate this to Fleet",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(turn1.jobId)?.resultSource).toBe("fleet-transcript");

    // Turn 2: a completely different, unrelated task on the SAME session.
    // Clawdy sends NO directive — the attachment is still "current" for
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
    // The adapter genuinely has fresh, well-formed output — this is NOT a
    // "nothing trustworthy yet" case. The guard must be the attachment's own
    // Clawdy-reported status, not merely the absence of output.
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "here is some output, but I have a question", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3", status: "needs_input" }),
    });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const result = sessions.getJob(job.jobId)!;
    expect(result.status).toBe("completed_no_summary");
    expect(result.resultSource).toBe("parent");
    expect(result.summary).not.toContain("here is some output");

    // The attachment itself stays needs_input — visible/actionable, not
    // silently overwritten by the fact that output text existed.
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("needs_input");
  });

  it("a failed child's leftover transcript text is never treated as a trusted answer", async () => {
    const adapter = fakeFleetAdapter({ handoff: async () => ({ text: "partial output before it crashed", resultAt: Date.now() }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3", status: "failed" }),
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
    const adapter = fakeFleetAdapter({ isLive: () => isLivePromise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;
    ctrl.finishChat("done", 0);
    await wait();

    // Kick off an inspect — its isLive call is now in flight, deliberately
    // held open via the unresolved deferred promise. Finish ITS chat turn
    // immediately so the busy guard doesn't block the next submission below
    // (submitTask always dispatches a real turn — a directive alone doesn't
    // exempt it from the one-job-per-session guard).
    sessions.submitTask({ task: "inspect", sessionKey: job.sessionKey, context: fleetBlock({ op: "inspect" }) });
    expect(adapter.isLiveCalls).toHaveLength(1);
    ctrl.finishChat("inspect turn done", 1);
    await wait();

    // Detach BEFORE the in-flight isLive resolves.
    sessions.submitTask({ task: "detach", sessionKey: job.sessionKey, context: fleetBlock({ op: "detach", reason: "operator stopped it" }) });
    ctrl.finishChat("detach turn done", 2);
    expect(sessions.getFleetAttachment(job.sessionKey)).toBeUndefined();

    // NOW the stale isLive resolves true ("it's running!") — after the fact.
    resolveIsLive(true);
    await wait();

    // The detached record must stay detached — not resurrected to "running".
    const lineage = sessions.getFleetLineage(job.sessionKey);
    const detachedRecord = lineage.find((a) => a.id === original.id)!;
    expect(detachedRecord.status).toBe("detached");
    expect(detachedRecord.reason).toBe("operator stopped it");
    expect(sessions.getFleetAttachment(job.sessionKey)).toBeUndefined();
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
    const { promise: secondHandoffPromise, resolve: resolveSecondHandoff } = deferred<FleetHandoff | null>();
    const adapter = fakeFleetAdapter({
      handoff: () => {
        handoffCallCount += 1;
        return handoffCallCount === 1 ? Promise.resolve(null) : secondHandoffPromise;
      },
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();
    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    expect(handoffCallCount).toBe(1);

    // Trigger a lazy recheck — its tryFleetRecovery call is the SECOND
    // handoff call, now in flight and deliberately held open.
    const waitPromise = sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    await wait();
    expect(handoffCallCount).toBe(2);

    // Replace the attachment WHILE that second adapter call is in flight —
    // job1 is terminal now, so the busy guard does not block this submit.
    sessions.submitTask({
      task: "replace mid-flight",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "replace", handle: "cf-bar", host: "minip3", reason: "operator swap" }),
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
    const supersededRecord = sessions.getFleetLineage(job.sessionKey).find((a) => a.id === original.id)!;
    expect(supersededRecord.status).toBe("superseded");
    expect(supersededRecord.lastResult).toBeUndefined();

    // The new (replaced) attachment is untouched by the stale write too.
    const current = sessions.getFleetAttachment(job.sessionKey)!;
    expect(current.handle).toBe("cf-bar");
    expect(current.lastResult).toBeUndefined();
  });

  it("a delayed handoff from an older turn is discarded when the same attachment continues into needs_input", async () => {
    let handoffCallCount = 0;
    const { promise: handoffPromise, resolve: resolveHandoff } = deferred<FleetHandoff | null>();
    const adapter = fakeFleetAdapter({
      handoff: () => {
        handoffCallCount += 1;
        return handoffCallCount === 1 ? Promise.resolve(null) : handoffPromise;
      },
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
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
      context: fleetBlock({ op: "continue", status: "needs_input" }),
    });
    ctrl.finishChat("continue turn done", 1);

    const currentBeforeResolution = sessions.getFleetAttachment(job.sessionKey)!;
    expect(currentBeforeResolution.status).toBe("needs_input");
    expect(currentBeforeResolution.delegatedTurnId).not.toBe(job.jobId);
    expect(currentBeforeResolution.lastResult).toBeUndefined();

    // The old handoff resolves after the newer generation is actionable.
    resolveHandoff({ text: "stale answer from the old generation", resultAt: Date.now() });
    await waitPromise;
    await wait();

    const current = sessions.getFleetAttachment(job.sessionKey)!;
    expect(current.status).toBe("needs_input");
    expect(current.lastResult).toBeUndefined();
    expect(sessions.getJob(job.jobId)?.summary).not.toBe("stale answer from the old generation");
  });
});

/**
 * The generic runtime bridge: the SAME session-scoped attachment machinery
 * above, driven by a host-registered runtime instead of the built-in tmux
 * adapter. ClawConnect learns nothing about T3 here — the fake below is
 * standing in for a host that owns T3's CLI, pairing, and project model
 * entirely on its own side of the callback boundary.
 */

function agentSessionMarker(obj: Record<string, unknown>): string {
  return `<agent-session>${JSON.stringify(obj)}</agent-session>`;
}

const T3_MARKER = agentSessionMarker({
  runtime: "t3-fleet",
  provider: "anthropic-claude-code",
  sessionId: "thr-abc123",
  host: "minip3",
  state: "running",
  metadata: { t3ProjectId: "proj-1", turnId: "turn-1" },
});

type FakeRuntime = {
  registry: AgentSessionRuntimeRegistry;
  inspectCalls: AgentSessionRef[];
  continueCalls: { ref: AgentSessionRef; prompt?: string }[];
  detachCalls: { ref: AgentSessionRef; reason?: string }[];
};

function fakeT3Runtime(
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
    id: "t3-fleet",
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
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship the thing", context: `Delegated.\n${T3_MARKER}` });

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment).toMatchObject({
      runtime: "t3-fleet",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      host: "minip3",
      status: "running",
      metadata: { t3ProjectId: "proj-1", turnId: "turn-1" },
      delegatedTurnId: job.jobId,
    });
    // It rides on the existing snapshot key — one projection, not a second one
    // that could drift from it.
    expect(sessions.buildSnapshot(job).fleetAttachment?.handle).toBe("thr-abc123");
  });

  it("never lets the raw marker reach the agent's prompt", () => {
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship the thing", context: `Before.\n${T3_MARKER}\nAfter.` });
    expect(sessions.getJob(job.jobId)?.prompt.context).toBe("Before.\n\nAfter.");
  });

  it("re-stating the same session on a later turn refreshes it instead of growing the lineage", async () => {
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const first = sessions.submitTask({ task: "start", context: T3_MARKER });
    const attachedAt = sessions.getFleetAttachment(first.sessionKey)!.attachedAt;
    ctrl.finishChat("first turn done", 0);
    await wait();

    // Clawdy passes the runtime's marker through on EVERY turn; a second
    // lineage record per turn would be noise, and superseding a live
    // attachment with a copy of itself would be a lie about what happened.
    const second = sessions.submitTask({
      task: "keep going",
      sessionKey: first.sessionKey,
      context: agentSessionMarker({
        runtime: "t3-fleet",
        sessionId: "thr-abc123",
        state: "needs_input",
        remoteUrl: "https://t3.example/threads/abc123",
        metadata: { turnId: "turn-2" },
      }),
    });

    expect(sessions.getFleetLineage(first.sessionKey)).toHaveLength(1);
    const attachment = sessions.getFleetAttachment(first.sessionKey)!;
    expect(attachment.attachedAt).toBe(attachedAt);
    expect(attachment.status).toBe("needs_input");
    expect(attachment.remoteUrl).toBe("https://t3.example/threads/abc123");
    // Merged, not replaced: turn-1's project id is still known.
    expect(attachment.metadata).toEqual({ t3ProjectId: "proj-1", turnId: "turn-2" });
    // Re-stating it IS the new turn delegating to it.
    expect(attachment.delegatedTurnId).toBe(second.jobId);
  });

  it("a different session on the same runtime still replaces, preserving lineage", async () => {
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "start", context: T3_MARKER });
    ctrl.finishChat("first turn done", 0);
    await wait();
    sessions.submitTask({
      task: "start over",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "replace", runtime: "t3-fleet", sessionId: "thr-second", host: "minip3", reason: "wrong project" }),
    });

    const lineage = sessions.getFleetLineage(job.sessionKey);
    expect(lineage).toHaveLength(2);
    const superseded = lineage.find((r) => r.handle === "thr-abc123")!;
    expect(superseded.status).toBe("superseded");
    expect(superseded.reason).toBe("wrong project");
    const current = sessions.getFleetAttachment(job.sessionKey)!;
    expect(current.handle).toBe("thr-second");
    expect(current.replacesAttachmentId).toBe(superseded.id);
  });

  it("survives a connector restart with runtime, provider, and metadata intact", () => {
    const store = new FakeFleetAttachmentStore();
    const t3 = fakeT3Runtime();
    const first = fakeGateway();
    const sessionsA = new SessionManager(first.gateway, "main", undefined, store, undefined, t3.registry);
    const job = sessionsA.submitTask({ task: "ship it", context: T3_MARKER });

    // A brand-new manager over the same store, as after a process restart.
    const second = fakeGateway();
    const sessionsB = new SessionManager(second.gateway, "main", undefined, store, undefined, t3.registry);
    expect(sessionsB.getFleetAttachment(job.sessionKey)).toMatchObject({
      runtime: "t3-fleet",
      provider: "anthropic-claude-code",
      handle: "thr-abc123",
      metadata: { t3ProjectId: "proj-1" },
      delegatedTurnId: job.jobId,
    });
  });

  it("dispatches inspect to exactly the one attachment — never a scan, and never for a session with none", async () => {
    const t3 = fakeT3Runtime({
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
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);

    // A session that never attached must not produce a single runtime call.
    const unattached = sessions.submitTask({ task: "unrelated work" });
    await wait();
    expect(t3.inspectCalls).toHaveLength(0);
    ctrl.finishChat("done", 0);
    await wait();

    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat("done", 1);
    await wait();
    await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });

    expect(t3.inspectCalls).toHaveLength(1);
    // The neutral ref, not ClawConnect's record: no lineage id, no turn token.
    expect(t3.inspectCalls[0]).toEqual({
      runtime: "t3-fleet",
      provider: "anthropic-claude-code",
      sessionId: "thr-abc123",
      providerSessionId: undefined,
      host: "minip3",
      remoteUrl: undefined,
      metadata: { t3ProjectId: "proj-1", turnId: "turn-1" },
      lastKnownState: "running",
    });
    expect(unattached.sessionKey).not.toBe(job.sessionKey);

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_permission");
    expect(attachment.alive).toBe(true);
    expect(attachment.latestResponse).toBe("may I run the migration?");
    expect(attachment.lastEventAt).toBe(Date.parse("2026-08-03T12:05:00.000Z"));
    expect(attachment.providerSessionId).toBe("prov-9");
    expect(attachment.metadata).toEqual({ t3ProjectId: "proj-1", turnId: "turn-2" });
    // A blocked session's partial text is never promoted to a turn result.
    expect(attachment.lastResult).toBeUndefined();
  });

  it("delivers a follow-up turn through the runtime's continue callback", async () => {
    const t3 = fakeT3Runtime({ onContinue: async () => ({ state: "running", latestResponse: "on it" }) });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "nudge it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "continue", prompt: "also update the docs" }),
    });
    await wait();

    expect(t3.continueCalls).toEqual([
      { ref: expect.objectContaining({ runtime: "t3-fleet", sessionId: "thr-abc123" }), prompt: "also update the docs" },
    ]);
    expect(sessions.getFleetAttachment(job.sessionKey)?.latestResponse).toBe("on it");
  });

  it("reports a precise unsupported_operation instead of failing the task", async () => {
    const t3 = fakeT3Runtime(); // inspect only — no continue callback registered
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    const nudge = sessions.submitTask({
      task: "nudge it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "continue", prompt: "also update the docs" }),
    });
    await wait();

    // The TASK is unaffected — a delegation that cannot be driven is not a
    // reason for the turn itself to fail.
    expect(nudge.status).toBe("running");
    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.error).toMatchObject({ code: "unsupported_operation" });
    // A failed ask teaches nothing about the session, so what we last knew survives.
    expect(attachment.status).toBe("running");
  });

  it("reports unknown_runtime for a runtime this build was never taught, and keeps the attachment readable", async () => {
    const ctrl = fakeGateway();
    // No registry at all: a t3-fleet attachment written by a build that had
    // one must still round-trip, not be dropped.
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    expect(sessions.getFleetAttachment(job.sessionKey)?.runtime).toBe("t3-fleet");

    const status = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(status?.state).toBe("unavailable");
    expect(status?.error?.code).toBe("unknown_runtime");
    expect(status?.detail).toContain("Last reported state: running.");
    // Still exactly what the marker said — an unanswerable read changed nothing.
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("running");
  });

  it("returns undefined rather than reaching for anything when nothing is attached", async () => {
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "no delegation here" });
    expect(await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" })).toBeUndefined();
    expect(t3.inspectCalls).toHaveLength(0);
  });

  it("recovers a completed turn's final response through the runtime, marked provisional", async () => {
    const t3 = fakeT3Runtime({
      inspect: async () => ({
        state: "completed",
        finalResponse: "the T3 session's real answer",
        lastEventAt: Date.now(),
        termination: { reason: "completed" },
      }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });

    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    const recovered = sessions.getJob(job.jobId)!;
    expect(recovered.status).toBe("completed");
    expect(recovered.summary).toBe("the T3 session's real answer");
    // NOT "fleet-transcript": that value is a specific claim about provenance
    // (a Claude Code transcript read off disk) that an arbitrary runtime's
    // reply does not support. See ResultSource.
    expect(recovered.resultSource).toBe("agent-session");
    expect(recovered.terminalReason).toBe("agent-session-recovery");
    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.lastResult?.summary).toBe("the T3 session's real answer");
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
      const t3 = fakeT3Runtime({
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
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
      const job = sessions.submitTask({
        task: "ship it",
        // The marker itself reports the blocked state, which is exactly how a
        // runtime announces "I'm waiting on a human" at delegation time.
        context: agentSessionMarker({ runtime: "t3-fleet", sessionId: "thr-abc123", host: "minip3", state: blocked }),
      });
      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await wait();

      const settled = sessions.getJob(job.jobId)!;
      expect(settled.status, blocked).toBe("completed_no_summary");
      expect(settled.resultSource, blocked).toBe("parent");
      // The attachment stays actionable, which is the whole point.
      expect(sessions.getFleetAttachment(job.sessionKey)?.status, blocked).toBe(blocked);
      expect(sessions.getFleetAttachment(job.sessionKey)?.lastResult, blocked).toBeUndefined();

      // …and the JOB says so too, rather than reading as an ordinary turn that
      // simply had nothing to report: same status (no new JobStatus, so every
      // existing consumer keeps working), different terminalReason and summary.
      expect(settled.terminalReason, blocked).toBe(`delegate-blocked:${blocked}`);
      expect(settled.summary, blocked).not.toBe(NO_SUMMARY_SENTINEL);
      expect(settled.summary, blocked).toContain("t3-fleet/thr-abc123");
      expect(settled.summary, blocked).toContain(
        blocked === "needs_permission" ? "waiting for permission" : "waiting for input",
      );
      const snapshot = sessions.buildSnapshot(settled);
      expect(blockedDelegationNotice(snapshot), blocked).toBe(settled.summary);
    }
  });

  it("leaves an ordinary empty turn exactly as it was — sentinel summary, unchanged reason", async () => {
    const t3 = fakeT3Runtime({ inspect: async () => ({ state: "running" }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
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
    const t3 = fakeT3Runtime({ inspect: async () => ({ state }) });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
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
    expect(settled.summary).toContain("t3-fleet/thr-abc123");
    // Idempotent: polling again neither re-labels nor re-logs.
    const version = settled.outcomeVersion;
    await sessions.waitForJob(job.jobId, 0, undefined, "wait", 1);
    expect(sessions.getJob(job.jobId)?.outcomeVersion).toBe(version);
  });

  it("does not blame this turn for a block on a delegation an EARLIER turn owned", async () => {
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const t3 = fakeT3Runtime({ inspect: async () => ({ state: "needs_input" }) });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const turn1 = sessions.submitTask({
      task: "delegate it",
      context: agentSessionMarker({ runtime: "t3-fleet", sessionId: "thr-abc123", host: "minip3", state: "needs_input" }),
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
    const t3 = fakeT3Runtime({
      inspect: async () => ({ state: "completed", finalResponse: "an answer from who knows when" }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
    expect(sessions.getFleetAttachment(job.sessionKey)?.lastResult).toBeUndefined();
  });

  it("refuses a result that predates the turn it would be answering", async () => {
    const t3 = fakeT3Runtime({
      inspect: async () => ({ state: "completed", finalResponse: "an answer from a previous delegation", lastEventAt: 1_000 }),
    });
    const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
    await wait();

    expect(sessions.getJob(job.jobId)?.status).toBe("completed_no_summary");
  });

  it("drops a read that resolves after the attachment was re-delegated to a newer turn", async () => {
    const gate = deferred<AgentSessionObservation>();
    const t3 = fakeT3Runtime({ inspect: () => gate.promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });

    // A read for THIS turn goes out and hangs.
    const inFlight = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    await wait();
    ctrl.finishChat("first turn done", 0);
    await wait();

    // A newer turn claims the same attachment while that read is outstanding.
    const newer = sessions.submitTask({
      task: "keep going",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "continue", status: "needs_input" }),
    });
    expect(sessions.getFleetAttachment(job.sessionKey)?.delegatedTurnId).toBe(newer.jobId);

    gate.resolve({ state: "completed", finalResponse: "answer for the OLD turn", lastEventAt: Date.now() });
    const status = await inFlight;

    // The answer is still reported to the caller who asked...
    expect(status?.state).toBe("completed");
    // ...but it is not allowed to become durable state for a turn that never
    // asked for it.
    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.lastResult).toBeUndefined();
  });

  it("never lets an older read overtake a newer one on the same attachment and turn", async () => {
    const gates = [deferred<AgentSessionObservation>(), deferred<AgentSessionObservation>()];
    let call = 0;
    const t3 = fakeT3Runtime({ inspect: () => gates[call++].promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });

    const older = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    const newer = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });

    // The NEWER read lands first, then the older one straggles in behind it.
    gates[1].resolve({ state: "needs_input", latestResponse: "current state" });
    await newer;
    gates[0].resolve({ state: "running", latestResponse: "state from a moment ago" });
    await older;

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.latestResponse).toBe("current state");
  });

  it("never lets an in-flight passive read overwrite a status stated after it went out", async () => {
    // `inspect` is a passive refresh: it deliberately does NOT re-stamp the
    // delegated turn, so the delegation check cannot catch this one. The
    // observation token is what makes an explicitly stated status durable
    // against a read that was already outstanding when it was stated.
    const gate = deferred<AgentSessionObservation>();
    const t3 = fakeT3Runtime({ inspect: () => gate.promise });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });

    const inFlight = sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    await wait();
    ctrl.finishChat("first turn done", 0);
    await wait();

    // Clawdy sees the session block and says so, on the same delegation.
    sessions.submitTask({
      task: "just looking",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "inspect", status: "needs_input" }),
    });
    expect(sessions.getFleetAttachment(job.sessionKey)?.delegatedTurnId).toBe(job.jobId);

    gate.resolve({ state: "running", latestResponse: "still chugging" });
    await inFlight;

    const attachment = sessions.getFleetAttachment(job.sessionKey)!;
    expect(attachment.status).toBe("needs_input");
    expect(attachment.latestResponse).toBeUndefined();
  });

  it("asks the runtime to stop the session only when the detach says so, and detaches locally either way", async () => {
    const quiet = fakeT3Runtime({ withDetach: true });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, quiet.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "stop tracking it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "detach", reason: "handed back to me" }),
    });
    await wait();
    expect(quiet.detachCalls).toHaveLength(0);
    expect(sessions.getFleetAttachment(job.sessionKey)).toBeUndefined();
    expect(sessions.getFleetLineage(job.sessionKey)[0]).toMatchObject({ status: "detached", reason: "handed back to me" });
  });

  it("dispatches an opt-in runtime stop, and a runtime that throws cannot wedge the conversation", async () => {
    const t3 = fakeT3Runtime({
      onDetach: async () => {
        throw new Error("T3 endpoint unreachable");
      },
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    ctrl.finishChat("done", 0);
    await wait();

    sessions.submitTask({
      task: "kill it",
      sessionKey: job.sessionKey,
      context: fleetBlock({ op: "detach", reason: "abandoned", stopRuntime: true }),
    });
    await wait();

    expect(t3.detachCalls).toEqual([{ ref: expect.objectContaining({ sessionId: "thr-abc123" }), reason: "abandoned" }]);
    // The local detach is the durable decision; a runtime that is down must
    // not be able to hold the conversation hostage.
    expect(sessions.getFleetAttachment(job.sessionKey)).toBeUndefined();
  });

  it("keeps claude-fleet on the built-in adapter, and reports precisely what that adapter cannot do", async () => {
    const adapter = fakeFleetAdapter({ isLive: true });
    const ctrl = fakeGateway();
    // A registry is present but knows nothing about claude-fleet — the
    // explicit tmux fallback still answers for it.
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter, fakeT3Runtime().registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });

    const inspected = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(adapter.isLiveCalls.map((a) => a.handle)).toEqual(["cf-foo"]);
    // Liveness only: the adapter deliberately claims no state, so a bare tmux
    // bit can only promote the uninformative initial "starting".
    expect(inspected?.state).toBe("unknown");
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("running");

    const nudged = await sessions.runAgentSessionOp(job.sessionKey, { op: "continue", prompt: "keep going" });
    expect(nudged?.error).toMatchObject({ code: "unsupported_operation" });
  });

  it("lets a host-registered claude-fleet runtime win over the built-in adapter", async () => {
    const adapter = fakeFleetAdapter({ isLive: true });
    const registry = new AgentSessionRuntimeRegistry();
    const seen: AgentSessionRef[] = [];
    registry.register({
      id: "claude-fleet",
      provider: "anthropic-claude-code",
      inspect: async (ref) => {
        seen.push(ref);
        return { state: "idle" };
      },
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, adapter, registry);
    const job = sessions.submitTask({
      task: "do the thing",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });

    await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(seen.map((r) => r.sessionId)).toEqual(["cf-foo"]);
    expect(adapter.isLiveCalls).toHaveLength(0);
    expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("idle");
  });

  /**
   * The observation token is durable (it lives on the record) while its
   * counter is in-memory. A process that restarts at zero mints tokens the
   * compare-and-set is bound to refuse, so every observation — and every
   * recovery that depends on one landing — silently does nothing.
   */
  describe("after a restart, the observation token resumes above what was persisted", () => {
    function persistedState(sessionKey: string, overrides: Partial<FleetAttachmentRecord> = {}): SessionFleetState {
      const record: FleetAttachmentRecord = {
        id: "att-1",
        runtime: "t3-fleet",
        provider: "anthropic-claude-code",
        handle: "thr-abc123",
        host: "minip3",
        attachedAt: 1_000,
        status: "running",
        observationToken: 42,
        ...overrides,
      };
      return { sessionKey, currentAttachmentId: record.id, attachments: { [record.id]: record } };
    }

    it("lets the first post-restart observation land instead of refusing it", async () => {
      const t3 = fakeT3Runtime({ inspect: async () => ({ state: "needs_input", latestResponse: "which branch?" }) });
      const store = new FakeFleetAttachmentStore([persistedState("sess-restart")]);
      const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store, undefined, t3.registry);

      await sessions.runAgentSessionOp("sess-restart", { op: "inspect" });

      const attachment = sessions.getFleetAttachment("sess-restart")!;
      expect(attachment.status).toBe("needs_input");
      expect(attachment.latestResponse).toBe("which branch?");
      // Strictly above the persisted high-water mark, so the CAS still orders
      // reads correctly across the restart boundary.
      expect(attachment.observationToken).toBeGreaterThan(42);
    });

    it("resumes above a SUPERSEDED record's token too — lineage carries the high-water mark", async () => {
      const current: FleetAttachmentRecord = {
        id: "att-current",
        runtime: "t3-fleet",
        handle: "thr-abc123",
        attachedAt: 2_000,
        status: "running",
        observationToken: 3,
      };
      const superseded: FleetAttachmentRecord = {
        id: "att-old",
        runtime: "t3-fleet",
        handle: "thr-older",
        attachedAt: 1_000,
        status: "superseded",
        observationToken: 99,
      };
      const store = new FakeFleetAttachmentStore([
        {
          sessionKey: "sess-lineage",
          currentAttachmentId: current.id,
          attachments: { [current.id]: current, [superseded.id]: superseded },
        },
      ]);
      const t3 = fakeT3Runtime({ inspect: async () => ({ state: "idle" }) });
      const sessions = new SessionManager(fakeGateway().gateway, "main", undefined, store, undefined, t3.registry);

      await sessions.runAgentSessionOp("sess-lineage", { op: "inspect" });
      expect(sessions.getFleetAttachment("sess-lineage")?.observationToken).toBeGreaterThan(99);
    });

    it("recovers a delegated turn's result after a restart, which a stale token would silently block", async () => {
      const t3 = fakeT3Runtime({
        inspect: async () => ({
          state: "completed",
          finalResponse: "the answer, produced after the connector restarted",
          lastEventAt: Date.now(),
        }),
      });
      const store = new FakeFleetAttachmentStore([persistedState("sess-restart")]);
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, store, undefined, t3.registry);

      // The new turn re-states the attachment (Clawdy passes the marker every
      // turn), which is what delegates it to THIS job. No `state` in the
      // marker, so nothing re-stamps the token on the way in.
      const job = sessions.submitTask({
        task: "keep going",
        sessionKey: "sess-restart",
        context: agentSessionMarker({ runtime: "t3-fleet", sessionId: "thr-abc123", host: "minip3" }),
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
      const t3 = fakeT3Runtime({ inspect: () => new Promise<never>(() => {}) });
      const ctrl = fakeGateway({ pollTranscriptForFinalText: async () => undefined });
      const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
      const job = sessions.submitTask({ task: "ship it", context: T3_MARKER });

      ctrl.finishChat(NO_SUMMARY_SENTINEL, 0);
      await vi.advanceTimersByTimeAsync(10);
      // Recovery is out at the runtime and has nothing back yet.
      expect(sessions.getJob(job.jobId)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(AGENT_SESSION_CALL_TIMEOUT_MS + 100);

      const settled = sessions.getJob(job.jobId)!;
      expect(settled.status).toBe("completed_no_summary");
      expect(settled.terminalReason).toBe("late-recovery-exhausted");
      // The read failed; the SESSION's last known state is untouched by that.
      expect(sessions.getFleetAttachment(job.sessionKey)?.status).toBe("running");
      expect(sessions.getFleetAttachment(job.sessionKey)?.error).toMatchObject({ code: "inspect_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not present a prior turn's finished result as the current turn's state", async () => {
    const t3 = fakeT3Runtime({
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
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const turn1 = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    await sessions.runAgentSessionOp(turn1.sessionKey, { op: "inspect" });

    const afterTurn1 = sessions.getFleetAttachment(turn1.sessionKey)!;
    expect(afterTurn1.lastResult?.summary).toBe("turn one's answer");
    expect(afterTurn1.status).toBe("completed");
    ctrl.finishChat("turn one done", 0);
    await wait();

    // A NEW turn claims the same session — the marker names it again, with no
    // state of its own to assert.
    const turn2 = sessions.submitTask({
      task: "now do the next thing",
      sessionKey: turn1.sessionKey,
      context: agentSessionMarker({ runtime: "t3-fleet", sessionId: "thr-abc123", host: "minip3" }),
    });

    const attachment = sessions.getFleetAttachment(turn1.sessionKey)!;
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
    expect(attachment.runtime).toBe("t3-fleet");
    expect(attachment.handle).toBe("thr-abc123");
    expect(attachment.metadata).toEqual({ t3ProjectId: "proj-1", turnId: "turn-1" });
    expect(sessions.getFleetLineage(turn1.sessionKey)).toHaveLength(1);
  });

  it("clears a prior turn's outcome on a continue from a later turn, keeping a stated status", async () => {
    const t3 = fakeT3Runtime({
      inspect: async () => ({ state: "idle", finalResponse: "turn one's answer", lastEventAt: Date.now() }),
    });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const turn1 = sessions.submitTask({ task: "ship it", context: T3_MARKER });
    await sessions.runAgentSessionOp(turn1.sessionKey, { op: "inspect" });
    expect(sessions.getFleetAttachment(turn1.sessionKey)?.lastResult).toBeDefined();
    ctrl.finishChat("turn one done", 0);
    await wait();

    const turn2 = sessions.submitTask({
      task: "keep going",
      sessionKey: turn1.sessionKey,
      context: fleetBlock({ op: "continue", status: "running" }),
    });

    const attachment = sessions.getFleetAttachment(turn1.sessionKey)!;
    expect(attachment.delegatedTurnId).toBe(turn2.jobId);
    expect(attachment.lastResult).toBeUndefined();
    // A status the directive states outranks the reset's "starting".
    expect(attachment.status).toBe("running");
  });

  it("takes the provider from the registered runtime, not from what the marker claimed", async () => {
    const t3 = fakeT3Runtime({ inspect: async () => ({ state: "running" }) });
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    const job = sessions.submitTask({
      task: "ship it",
      context: agentSessionMarker({
        runtime: "t3-fleet",
        provider: "some-other-model",
        sessionId: "thr-abc123",
        host: "minip3",
      }),
    });

    const status = await sessions.runAgentSessionOp(job.sessionKey, { op: "inspect" });
    expect(t3.inspectCalls[0].provider).toBe("anthropic-claude-code");
    expect(status?.provider).toBe("anthropic-claude-code");
    // The record heals to what the runtime says, so every later snapshot is right too.
    expect(sessions.getFleetAttachment(job.sessionKey)?.provider).toBe("anthropic-claude-code");
  });

  it("exposes registered runtimes for wiring assertions without exposing any session", () => {
    const t3 = fakeT3Runtime();
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway, "main", undefined, undefined, undefined, t3.registry);
    expect(sessions.hasAgentSessionRuntime("t3-fleet")).toBe(true);
    expect(sessions.hasAgentSessionRuntime("some-other-runtime")).toBe(false);
    expect(new SessionManager(fakeGateway().gateway).hasAgentSessionRuntime("t3-fleet")).toBe(false);
  });
});
