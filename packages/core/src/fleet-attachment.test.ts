import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("later turns expose and continue the same attachment without a directive", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const first = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("first done", 0);

    const before = sessions.getFleetAttachment(first.sessionKey);
    // Second turn, same session, NO directive at all.
    const second = sessions.submitTask({ task: "second", sessionKey: first.sessionKey });
    const after = sessions.getFleetAttachment(second.sessionKey);
    expect(after).toEqual(before);
  });

  it("explicit replacement preserves superseded lineage", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;

    ctrl.finishChat("done", 0);
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

  it("explicit detach persists a reason and clears the current attachment", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    const original = sessions.getFleetAttachment(job.sessionKey)!;
    ctrl.finishChat("done", 0);

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

  it("needs_input reported via continue stays actionable — visible on the snapshot without forcing the job terminal", () => {
    const ctrl = fakeGateway();
    const sessions = new SessionManager(ctrl.gateway);
    const job = sessions.submitTask({
      task: "first",
      context: fleetBlock({ op: "attach", handle: "cf-foo", host: "minip3" }),
    });
    ctrl.finishChat("done", 0);

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
    const adapter = fakeFleetAdapter({ handoff: { text: "child already finished", observedAt: Date.now() } });
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
    const adapter = fakeFleetAdapter({ handoff: { text: "the child's real answer", observedAt: 12345 } });
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
    const adapter = fakeFleetAdapter({ handoff: { text: longText, observedAt: 1 } });
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
    const adapter = fakeFleetAdapter({ handoff: { text: "stable answer", observedAt: 1 } });
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
    const adapter = fakeFleetAdapter({ handoff: { text: "child's provisional answer", observedAt: 1 } });
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
