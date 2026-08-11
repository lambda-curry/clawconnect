import { describe, expect, it, vi } from "vitest";
import { buildWidgetHtml } from "../../scripts/build-widget.mjs";

/**
 * Assembled-widget flow tests (shell.html + inlined state.js). state.test.ts
 * covers the pure decisions in isolation and references.test.ts covers the
 * seam where state.js is inlined; neither runs the shell's actual glue,
 * which is where the bugs below lived.
 *
 * This file replaces the pre-simplification version, which drove a
 * compact -> Task Center -> compact round trip. The fullscreen Task Center
 * surface was removed as part of the task-update reliability work (bounded
 * log windows / cursor semantics / client ring buffer); two of its fixes
 * were not Task-Center-specific and are ported forward here instead:
 *
 *  - Session registration (bridge.onMountData/adoptMountData): the mount
 *    payload can land after boot (ChatGPT populates window.openai globals
 *    asynchronously), so reading it once at parse time is a race. Without
 *    the openai:set_globals listener the card never learns its own session.
 *  - reconcileTaskList's retainSessionKeys bound: the card always reads
 *    list_tasks(view:"all") now (a task must not vanish from the read the
 *    instant it finishes), so retention across reads has to be bounded to
 *    the sessions this card actually knows about, or it accumulates every
 *    conversation's tasks for its whole lifetime and shouldPoll never settles.
 *
 * The host here is a stub, not a real browser: enough DOM to run el()/
 * render() and enough window.openai (plus a real addEventListener so
 * openai:set_globals can actually be dispatched) to answer callTool and
 * simulate a late mount.
 */

type Json = Record<string, unknown>;

// ── Minimal DOM ────────────────────────────────────────────────────────────
class El {
  tagName: string;
  text: string | null;
  className = "";
  children: El[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tagName: string, text: string | null = null) {
    this.tagName = tagName;
    this.text = text;
  }

  append(...nodes: (El | string)[]): void {
    for (const node of nodes) this.children.push(typeof node === "string" ? new El("#text", node) : node);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  setAttribute(key: string, value: string): void {
    this.attrs.set(key, String(value));
  }

  getAttribute(key: string): string | null {
    return this.attrs.get(key) ?? null;
  }

  get classList(): { add: (name: string) => void } {
    return {
      add: (name: string) => {
        this.className = `${this.className} ${name}`.trim();
      },
    };
  }

  set textContent(value: string) {
    this.children = [new El("#text", String(value))];
  }

  set innerHTML(value: string) {
    this.children = value ? [new El("#html", String(value))] : [];
  }

  focus(): void {}
}

function walk(node: El, visit: (node: El) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function withClass(root: El, name: string): El[] {
  const found: El[] = [];
  walk(root, (node) => {
    if (node.className.split(/\s+/).includes(name)) found.push(node);
  });
  return found;
}

function textOf(node: El): string {
  let out = "";
  walk(node, (n) => {
    if (n.text !== null) out += n.text;
  });
  return out;
}

function click(node: El): void {
  for (const fn of node.listeners.get("click") ?? []) fn({ stopPropagation() {}, preventDefault() {} });
}

function findTabButton(root: El, label: string): El {
  const match = withClass(root, "cc-card-tab").find((n) => textOf(n) === label);
  if (!match) throw new Error(`no tab button labelled "${label}"`);
  return match;
}

// ── A window stub with a REAL event registry — needed to simulate
// openai:set_globals firing after boot (the late-mount-data race). ─────────
class WindowStub {
  openai: unknown;
  parent = undefined;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(openai: unknown) {
    this.openai = openai;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({});
  }
}

// ── Fixture world ────────────────────────────────────────────────────────
const TASK_ID = "t1";
const SESSION_KEY = "sess-1";

type Task = {
  taskId: string;
  jobId: string;
  sessionKey: string;
  agent: string;
  status: string;
  lastEventAt: number;
  summary?: string;
};

function createHost(opts: { mountedOnBoot?: boolean; knownSessionKeys?: string[]; world: { tasks: Task[] } } = { world: { tasks: [] } }) {
  const calls: { name: string; args: Json }[] = [];
  let cursor = 0;
  const allEvents: Json[] = [];
  const mountPayload = { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY };

  const host = {
    calls,
    displayMode: "inline",
    theme: "light" as const,
    toolOutput: opts.mountedOnBoot ? { structuredContent: mountPayload } : null,
    widgetState: opts.knownSessionKeys ? { mounted: null, knownSessionKeys: opts.knownSessionKeys } : null,
    setWidgetState(value: unknown) {
      host.widgetState = value as typeof host.widgetState;
    },
    followUps: [] as { prompt: string }[],
    sendFollowUpMessage(args: { prompt: string }) {
      host.followUps.push(args);
    },
    // Test control, not part of window.openai's real surface.
    pushEvent(text: string) {
      cursor += 1;
      allEvents.push({ ts: cursor, type: "lifecycle", text, seq: cursor });
    },
    completeTask(status: string) {
      const t = opts.world.tasks.find((t) => t.taskId === TASK_ID);
      if (t) t.status = status;
    },
    mountPayload,
    callTool(name: string, args: Json): Promise<Json> {
      calls.push({ name, args });
      if (name === "list_tasks") {
        return Promise.resolve({ structuredContent: { tasks: opts.world.tasks } });
      }
      if (name === "get_task") {
        if (args.detail === "prompt") {
          return Promise.resolve({ structuredContent: { taskId: args.taskId, prompt: { task: "do the thing" } } });
        }
        const task = opts.world.tasks.find((t) => t.taskId === args.taskId);
        if (!task) return Promise.resolve({ structuredContent: { taskId: args.taskId, status: "error", error: "Task not found." } });
        const known = typeof args.knownLogCount === "number" ? args.knownLogCount : 0;
        const updates = task.taskId === TASK_ID ? allEvents.filter((e) => (e.seq as number) > known) : [];
        return Promise.resolve({ structuredContent: { ...task, updates, logCursor: cursor } });
      }
      if (name === "get_session") {
        return Promise.resolve({ structuredContent: { tasks: opts.world.tasks.filter((t) => t.sessionKey === args.sessionId) } });
      }
      return Promise.resolve({});
    },
  };
  return host;
}

const SCRIPT = (() => {
  const html = buildWidgetHtml();
  return html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
})();

function mount(host: ReturnType<typeof createHost>) {
  const root = new El("div");
  root.setAttribute("id", "root");
  const documentStub = {
    documentElement: new El("html"),
    visibilityState: "visible",
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => new El("#text", text),
    getElementById: (id: string) => {
      let found: El | null = null;
      walk(root, (node) => {
        if (node.getAttribute("id") === id) found = node;
      });
      return id === "root" ? root : found;
    },
    addEventListener: () => {},
  };
  const windowStub = new WindowStub(host);

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    "window",
    "document",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "queueMicrotask",
    "matchMedia",
    "console",
    SCRIPT,
  ) as (...args: unknown[]) => void;
  run(
    windowStub,
    documentStub,
    (fn: () => void, ms?: number) => setTimeout(fn, ms),
    (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    (fn: () => void, ms?: number) => setInterval(fn, ms),
    (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
    queueMicrotask,
    () => ({ matches: false }),
    console,
  );
  return { root, windowStub };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

const rowTitles = (root: El) => withClass(root, "cc-row").map((row) => textOf(withClass(row, "cc-title")[0]));
const rowUpdateLines = (root: El) => withClass(root, "cc-update").map(textOf);
const lastGetTaskArgs = (host: ReturnType<typeof createHost>) =>
  [...host.calls].reverse().find((c) => c.name === "get_task" && c.args.detail !== "prompt")?.args;

describe("session registration: the mount payload can land after boot", () => {
  it("registers the session and starts polling once openai:set_globals delivers the mount payload", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: false, world }); // toolOutput is null at boot — the race
    const { root, windowStub } = mount(host);
    await settle();

    // Nothing to show yet — the card never learned its session.
    expect(rowTitles(root)).toEqual([]);

    // ChatGPT populates its globals asynchronously; the payload becomes
    // readable and announces itself.
    host.toolOutput = { structuredContent: host.mountPayload };
    windowStub.dispatch("openai:set_globals");
    await settle();

    expect(rowTitles(root)).toEqual(["assistant is working…"]);
    expect(host.calls.some((c) => c.name === "get_task" && c.args.taskId === TASK_ID)).toBe(true);
  });
});

describe("canonical store: retention and its bound", () => {
  it("keeps a known session's task visible after it drops out of the read", async () => {
    const A1 = { taskId: "a1", jobId: "a1", sessionKey: "sess-a", agent: "assistant", status: "running", lastEventAt: 1_000 };
    const B1 = { taskId: "b1", jobId: "b1", sessionKey: "sess-b", agent: "scout", status: "running", lastEventAt: 2_000 };
    const world = { tasks: [A1, B1] };
    const host = createHost({ knownSessionKeys: ["sess-a", "sess-b"], world });
    vi.useFakeTimers();
    try {
      const { root } = mount(host);
      await settle();
      expect(rowTitles(root)).toContain("scout is working…");

      world.tasks = [A1]; // b1 disappears from the read entirely
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();

      expect(rowTitles(root)).toContain("scout is working…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain a session the card does not know about", async () => {
    const A1 = { taskId: "a1", jobId: "a1", sessionKey: "sess-a", agent: "assistant", status: "running", lastEventAt: 1_000 };
    const C1 = { taskId: "c1", jobId: "c1", sessionKey: "sess-c", agent: "archivist", status: "done", lastEventAt: 500, summary: "Old work" };
    const world = { tasks: [A1, C1] };
    // Only sess-a is known; sess-c is out of scope from the start.
    const host = createHost({ knownSessionKeys: ["sess-a"], world });
    vi.useFakeTimers();
    try {
      const { root } = mount(host);
      await settle();
      expect(rowTitles(root)).toEqual(["assistant is working…"]);

      world.tasks = [A1];
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();

      // sess-c was never retained — nothing to leak once it's gone from the read.
      expect(rowTitles(root)).toEqual(["assistant is working…"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ring buffer accumulates check_task/get_task's bounded per-poll delta", () => {
  it("shows accumulated recent activity across polls, not just the latest poll's delta", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      host.pushEvent("step one");
      const { root } = mount(host);
      await settle();

      expect(rowUpdateLines(root)).toEqual(["•step one"]);

      // Next poll's delta is just one NEW event — the server no longer resends
      // "step one". A naive "derive fresh from this snapshot" implementation
      // would lose it; the ring buffer must not.
      host.pushEvent("step two");
      // > pollIntervalMs("active") to trigger the next poll, plus the cosmetic
      // render-debounce window (same status group both times) before the DOM
      // actually updates.
      await vi.advanceTimersByTimeAsync(4_000);
      await settle();

      // deriveTimeline renders most-recent-first.
      expect(rowUpdateLines(root)).toEqual(["•step two", "•step one"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the prior logCursor back as knownLogCount on the next get_task call — no re-fetch of already-seen events", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      host.pushEvent("step one");
      mount(host);
      await settle();
      expect(lastGetTaskArgs(host)?.knownLogCount).toBe(0); // initial read

      host.pushEvent("step two");
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(lastGetTaskArgs(host)?.knownLogCount).toBe(1); // resumes from the cursor the prior read returned
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("render cadence: lifecycle/terminal changes are immediate, cosmetic-only activity debounces", () => {
  it("a cosmetic-only poll (same status group) does not repaint until the debounce window elapses", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      host.pushEvent("step one");
      const { root } = mount(host);
      await settle();
      expect(rowUpdateLines(root)).toEqual(["•step one"]);

      host.pushEvent("step two");
      // Advance only far enough to trigger the poll itself, not the render debounce after it.
      await vi.advanceTimersByTimeAsync(2_600);
      await settle();
      expect(rowUpdateLines(root)).toEqual(["•step one"]); // not yet — debounced

      await vi.advanceTimersByTimeAsync(1_100); // clears the debounce window
      await settle();
      expect(rowUpdateLines(root)).toEqual(["•step two", "•step one"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a terminal transition is reflected right away, without waiting out the cosmetic debounce window", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      host.pushEvent("working");
      const { root } = mount(host);
      await settle();
      expect(withClass(root, "cc-pill--active")).toHaveLength(1);

      host.completeTask("completed");
      await vi.advanceTimersByTimeAsync(3_000); // next poll cycle picks up the terminal status
      await settle();

      // No extra wait for the (1s) cosmetic debounce — a status-group change renders immediately.
      expect(withClass(root, "cc-pill--completed")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Continue in ChatGPT button on needs_attention / completed / failed", () => {
  it("queues a button on transition, sends only on click, and does not re-queue the same group", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      const { root } = mount(host);
      await settle();
      expect(host.followUps).toHaveLength(0);
      expect(withClass(root, "cc-btn").filter((n) => textOf(n) === "Continue in ChatGPT")).toHaveLength(0);

      host.completeTask("needs-human");
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      // Queued for a user gesture — no auto sendFollowUpMessage.
      expect(host.followUps).toHaveLength(0);
      const notify = withClass(root, "cc-btn").find((n) => textOf(n) === "Continue in ChatGPT");
      expect(notify).toBeTruthy();

      click(notify!);
      await settle();
      expect(host.followUps).toHaveLength(1);
      expect(host.followUps[0]?.prompt).toContain("needs attention");
      expect(host.followUps[0]?.prompt).toContain(TASK_ID);
      expect(withClass(root, "cc-btn").filter((n) => textOf(n) === "Continue in ChatGPT")).toHaveLength(0);

      // Still needs-human on the next poll — no second button.
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(host.followUps).toHaveLength(1);
      expect(withClass(root, "cc-btn").filter((n) => textOf(n) === "Continue in ChatGPT")).toHaveLength(0);

      host.completeTask("completed");
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(host.followUps).toHaveLength(1);
      const notifyDone = withClass(root, "cc-btn").find((n) => textOf(n) === "Continue in ChatGPT");
      expect(notifyDone).toBeTruthy();
      click(notifyDone!);
      await settle();
      expect(host.followUps).toHaveLength(2);
      expect(host.followUps[1]?.prompt).toContain("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer Notify when mounting onto an already-completed task", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "completed", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { root } = mount(host);
    await settle();
    expect(host.followUps).toHaveLength(0);
    expect(withClass(root, "cc-btn").filter((n) => textOf(n) === "Continue in ChatGPT")).toHaveLength(0);
  });
});

describe("original request stays out of recurring heartbeats — fetched lazily on demand", () => {
  it("the initial mount and subsequent poll cycles never call get_task(detail:\"prompt\")", async () => {
    vi.useFakeTimers();
    try {
      const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
      const host = createHost({ mountedOnBoot: true, world });
      host.pushEvent("step one");
      mount(host);
      await settle();

      host.pushEvent("step two");
      await vi.advanceTimersByTimeAsync(4_000);
      await settle();

      const promptCalls = host.calls.filter((c) => c.name === "get_task" && c.args.detail === "prompt");
      expect(promptCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting the Request tab fetches the prompt exactly once, even when re-selected before the first fetch resolves", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { root } = mount(host);
    await settle();
    expect(host.calls.filter((c) => c.name === "get_task" && c.args.detail === "prompt")).toHaveLength(0);

    const requestTab = findTabButton(root, "Request");
    click(requestTab);
    click(requestTab); // rapid re-click before the first fetch resolves — must not double-fetch
    await settle();

    const promptCalls = host.calls.filter((c) => c.name === "get_task" && c.args.detail === "prompt");
    expect(promptCalls).toHaveLength(1);
    expect(withClass(root, "cc-prompt-body").length).toBeGreaterThan(0);
    expect(textOf(withClass(root, "cc-prompt-body")[0])).toContain("do the thing");
  });

  it("switching away and back to Request does not re-fetch an already-loaded prompt", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { root } = mount(host);
    await settle();

    click(findTabButton(root, "Request"));
    await settle();
    click(findTabButton(root, "Response"));
    click(findTabButton(root, "Request"));
    await settle();

    expect(host.calls.filter((c) => c.name === "get_task" && c.args.detail === "prompt")).toHaveLength(1);
  });
});

describe("no fullscreen/Task Center affordance in the assembled widget", () => {
  it("never renders an 'Open Task Center' control, and the widget stays functional without one", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { root } = mount(host);
    await settle();
    const found = withClass(root, "cc-card-tab").some((n) => textOf(n).includes("⛶") || n.getAttribute("aria-label") === "Open Task Center");
    expect(found).toBe(false);
    expect(rowTitles(root)).toEqual(["assistant is working…"]);
  });
});

describe("a dead chat stream is not a dead task", () => {
  it("renders the recovery notice as reassurance, above the rows and outside any task's pill", async () => {
    const base: Task = { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 };
    const host = createHost({ mountedOnBoot: true, world: { tasks: [base] } });
    const inner = host.callTool;
    host.callTool = (name: string, args: Json): Promise<Json> => {
      if (name === "get_task" && args.detail !== "prompt") {
        // The server says: the originating reply ended before the answer
        // arrived, and it is recovering the job — which is still running.
        return Promise.resolve({ structuredContent: { ...base, recovery: { reason: "no_live_final_text" }, updates: [], logCursor: 0 } });
      }
      return inner(name, args);
    };

    const { root } = mount(host);
    await settle();

    const notice = withClass(root, "cc-note").map(textOf).join(" ");
    expect(notice).toContain("still running");
    // The task keeps its own status; the notice must not have demoted it.
    expect(withClass(root, "cc-pill").map(textOf).join(" ")).toContain("Running");
    expect(rowTitles(root)).toEqual(["assistant is working…"]);
  });

  it("shows no notice at all when the stream is healthy", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { root } = mount(host);
    await settle();
    expect(withClass(root, "cc-note")).toHaveLength(0);
  });
});

describe("resume signals", () => {
  it("reconciles when the network comes back, which backgrounds nothing and fires no other signal", async () => {
    // A dropped connection raises no visibilitychange/focus/pageshow, so
    // without an `online` listener the card sits on whatever the failed poll
    // left — and pollIntervalMs backs off to 30s on repeated failures, so it
    // can stay wrong for a long time after connectivity returns.
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "completed", lastEventAt: 0, summary: "done" }] };
    const host = createHost({ mountedOnBoot: true, world });
    const { windowStub } = mount(host);
    await settle();

    // Terminal work — pollIntervalMs returns null, so nothing is scheduled and
    // no further read happens on its own.
    const readsAfterBoot = host.calls.filter((c) => c.name === "list_tasks").length;
    await settle();
    expect(host.calls.filter((c) => c.name === "list_tasks")).toHaveLength(readsAfterBoot);

    windowStub.dispatch("online");
    await settle();

    expect(host.calls.filter((c) => c.name === "list_tasks").length).toBeGreaterThan(readsAfterBoot);
  });
});

describe("concurrent refreshes: only the newest read may write", () => {
  /**
   * A resume signal sets reconcileRequested, which deliberately bypasses
   * refresh()'s pollInFlight guard — and refreshOnInteraction routes an
   * ordinary click into that same path — so two refreshes really can be in
   * flight at once. Whichever resolves LAST would otherwise win, and that is
   * the OLDER one precisely when the first read is the slow one, which is the
   * case a resume signal exists to rescue. The visible symptom is a task that
   * just finished flipping back to "Running".
   */
  it("keeps the newer snapshot when a superseded refresh's response lands last", async () => {
    const generation: Record<number, Task> = {
      1: { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 1_000, summary: "older read" },
      2: { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "completed", lastEventAt: 2_000, summary: "newer read" },
    };
    const host = createHost({ mountedOnBoot: true, world: { tasks: [generation[1]] } });

    // Hold each list_tasks open so the two refreshes can be interleaved by
    // hand. get_task/get_session answer for `answering`: refresh() issues them
    // immediately after its own list read resolves, and the releases below are
    // sequenced with settle() between, so that is always the generation just
    // released.
    const release: (() => void)[] = [];
    let answering = 1;
    host.callTool = (name: string, args: Json): Promise<Json> => {
      host.calls.push({ name, args });
      if (name === "list_tasks") {
        const nth = release.length + 1;
        return new Promise<Json>((resolve) => {
          release.push(() => resolve({ structuredContent: { tasks: [generation[nth]] } }));
        });
      }
      if (name === "get_task") return Promise.resolve({ structuredContent: { ...generation[answering], updates: [], logCursor: 0 } });
      if (name === "get_session") return Promise.resolve({ structuredContent: { tasks: [generation[answering]] } });
      return Promise.resolve({});
    };

    const { root, windowStub } = mount(host);
    await settle();
    expect(release).toHaveLength(1); // the boot refresh is parked on its list read

    windowStub.dispatch("focus"); // a resume signal, mid-flight — the second refresh
    await settle();
    expect(release).toHaveLength(2);

    answering = 2;
    release[1]!(); // the newer refresh resolves first...
    await settle();
    expect(rowTitles(root)).toEqual(["newer read"]);

    answering = 1;
    release[0]!(); // ...and the superseded one lands after it
    await settle();

    expect(rowTitles(root)).toEqual(["newer read"]);
    expect(withClass(root, "cc-pill").map(textOf).join(" ")).toContain("Completed");
  });

  it("re-arms polling after a superseded refresh finishes last", async () => {
    // The stale refresh must leave pollInFlight and the poll timer to the
    // refresh that superseded it — if it cleared them itself the card would
    // either wedge on a stuck in-flight flag or double-schedule.
    const running = (summary: string, lastEventAt: number): Task => ({
      taskId: TASK_ID,
      jobId: TASK_ID,
      sessionKey: SESSION_KEY,
      agent: "assistant",
      status: "running",
      lastEventAt,
      summary,
    });
    const generation: Record<number, Task> = { 1: running("older read", 1_000), 2: running("newer read", 2_000) };
    const host = createHost({ mountedOnBoot: true, world: { tasks: [generation[1]] } });

    const release: (() => void)[] = [];
    let answering = 1;
    host.callTool = (name: string, args: Json): Promise<Json> => {
      host.calls.push({ name, args });
      if (name === "list_tasks") {
        const nth = release.length + 1;
        return new Promise<Json>((resolve) => {
          release.push(() => resolve({ structuredContent: { tasks: [generation[Math.min(nth, 2)]] } }));
        });
      }
      if (name === "get_task") return Promise.resolve({ structuredContent: { ...generation[answering], updates: [], logCursor: 0 } });
      if (name === "get_session") return Promise.resolve({ structuredContent: { tasks: [generation[answering]] } });
      return Promise.resolve({});
    };

    vi.useFakeTimers();
    try {
      const { root, windowStub } = mount(host);
      await settle();
      windowStub.dispatch("focus");
      await settle();
      expect(release).toHaveLength(2);

      answering = 2;
      release[1]!();
      await settle();
      answering = 1;
      release[0]!(); // superseded, lands last
      await settle();

      // The next scheduled poll must still fire — proof pollInFlight was
      // released by the newer refresh and scheduleNext() actually re-armed.
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(release.length).toBeGreaterThanOrEqual(3);

      answering = 2;
      release[2]!();
      await vi.advanceTimersByTimeAsync(1_100); // flush the cosmetic render debounce
      await settle();
      expect(rowTitles(root)).toEqual(["newer read"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a delegated run shows the ids someone can actually act on", () => {
  const FLEET_RUN = "t3-fleet-run-ccc4f7df7ace97de1cd45fafef4b2512";
  const CODING_SESSION = "coding-session-9f2b1c4d";

  function delegatedHost(overrides: Json = {}) {
    const base: Task = { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 };
    const host = createHost({ mountedOnBoot: true, world: { tasks: [base] } });
    const inner = host.callTool;
    host.callTool = (name: string, args: Json): Promise<Json> => {
      if (name === "get_task" && args.detail !== "prompt") {
        return Promise.resolve({
          structuredContent: {
            ...base,
            parentRunId: "openclaw-run-77",
            liveness: { checkedAt: Date.now() - 20_000, upstream: "active", producing: false },
            agentSession: {
              id: "att-1",
              runtime: "claude-fleet",
              handle: FLEET_RUN,
              providerSessionId: CODING_SESSION,
              worktree: "/Users/x/.t3-fleet-worktrees/clawconnect-recovery-fix",
              host: "build-host",
              status: "running",
            },
            updates: [],
            logCursor: 0,
            ...overrides,
          },
        });
      }
      return inner(name, args);
    };
    return host;
  }

  it("renders the Fleet run and coding-session ids verbatim, reachable while the run is HEALTHY", async () => {
    const host = delegatedHost();
    const { root } = mount(host);
    await settle();

    // The tab exists even though nothing has failed — that is the point.
    const diagnosticsTab = findTabButton(root, "Diagnostics");
    click(diagnosticsTab);
    await settle();

    const shown = withClass(root, "cc-idvalue").map(textOf);
    expect(shown).toContain(FLEET_RUN);
    expect(shown).toContain(CODING_SESSION);
    // Untruncated: a prefix identifies a run you already know and is useless
    // for attaching to one you don't.
    expect(shown.join(" ")).toContain(FLEET_RUN);
    expect(textOf(root)).toContain("openclaw-run-77");
  });

  it("does not tell the operator a healthy delegated run has failed", async () => {
    const host = delegatedHost();
    const { root } = mount(host);
    await settle();
    click(findTabButton(root, "Diagnostics"));
    await settle();

    // The old unconditional fallback said exactly this over a working run.
    expect(textOf(root)).not.toContain("The task failed without additional diagnostics.");
    expect(withClass(root, "cc-diagnostics")).toHaveLength(0);
    expect(withClass(root, "cc-pill").map(textOf).join(" ")).toContain("Running");
  });

  it("dates the upstream evidence rather than asserting it as current", async () => {
    const host = delegatedHost();
    const { root } = mount(host);
    await settle();
    click(findTabButton(root, "Diagnostics"));
    await settle();

    const text = textOf(root);
    expect(text).toContain("run executing");
    expect(text).toMatch(/checked \d+s ago/);
  });

  it("carries the ids into a real failure too, so the error names something checkable", async () => {
    const host = delegatedHost({
      status: "failed",
      error: "Stopped watching after 90m: upstream run openclaw-run-77 was last reported executing 4m ago",
    });
    const { root } = mount(host);
    await settle();
    // A failed task opens on diagnostics by itself.
    const text = textOf(root);
    expect(text).toContain("Stopped watching after 90m");
    expect(withClass(root, "cc-idvalue").map(textOf)).toContain(FLEET_RUN);
  });
});

describe("the card asks for the payload it actually renders", () => {
  it("requests a diagnostics-bearing preset — it renders a Diagnostics tab, so it must not ask for one that strips the failure", async () => {
    const world = { tasks: [{ taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "running", lastEventAt: 0 }] };
    const host = createHost({ mountedOnBoot: true, world });
    mount(host);
    await settle();

    const heartbeat = host.calls.filter((c) => c.name === "get_task" && c.args.detail !== "prompt");
    expect(heartbeat.length).toBeGreaterThan(0);
    // buildGetTaskStructuredContent emits error/errorInfo ONLY under these two.
    for (const call of heartbeat) {
      expect(["diagnostics", "fullWithDiagnostics"]).toContain(call.args.detail);
    }
  });

  it("surfaces the recovery guidance through get_task's real nested shape, not just a flat fixture", async () => {
    const base: Task = { taskId: TASK_ID, jobId: TASK_ID, sessionKey: SESSION_KEY, agent: "assistant", status: "failed", lastEventAt: 0 };
    const host = createHost({ mountedOnBoot: true, world: { tasks: [base] } });
    const inner = host.callTool;
    host.callTool = (name: string, args: Json): Promise<Json> => {
      if (name === "get_task" && args.detail !== "prompt") {
        // Exactly what buildGetTaskStructuredContent returns: error/errorInfo
        // NESTED under `diagnostics`, not at the top level.
        return Promise.resolve({
          structuredContent: {
            ...base,
            updates: [],
            logCursor: 0,
            diagnostics: {
              error: "Stopped watching after 90m: upstream run openclaw-run-77 was last reported executing 4m ago",
              errorInfo: {
                category: "timeout",
                message: "late recovery hit the hard cap",
                suggestedRecovery: "Do not re-submit on this session while the run is executing — a second send aborts it.",
              },
            },
          },
        });
      }
      return inner(name, args);
    };

    const { root } = mount(host);
    await settle();

    const text = textOf(root);
    expect(text).toContain("Stopped watching after 90m");
    // The whole point: the action, not just the complaint.
    expect(text).toContain("Do not re-submit on this session");
    expect(withClass(root, "cc-guidance").length).toBeGreaterThan(0);
  });
});
