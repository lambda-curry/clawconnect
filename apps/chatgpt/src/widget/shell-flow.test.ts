import { describe, expect, it } from "vitest";
import { buildWidgetHtml } from "../../scripts/build-widget.mjs";

/**
 * Compact -> Task Center -> compact, driven through the *assembled* widget.
 *
 * state.test.ts covers the pure decisions and references.test.ts covers the
 * seam where state.js is inlined; neither runs the shell's actual glue, which
 * is where this bug lived. Opening the Task Center used to widen the compact
 * card's own scope (allActivity) and row filter (view) in order to widen the
 * *read*, and closing only flipped displayMode back — so the compact card came
 * back rendering every session the Task Center had loaded, and kept polling
 * unscoped forever after.
 *
 * The host here is a stub, not a real browser: enough DOM to run el()/render()
 * and enough window.openai to answer callTool/requestDisplayMode. What it
 * proves is data flow — which sessions each surface renders, and what
 * list_tasks each surface asks for.
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

function findButton(root: El, label: string): El {
  const match = [...withClass(root, "cc-btn"), ...withClass(root, "cc-card-tab")].find(
    (n) => n.getAttribute("aria-label") === label || textOf(n) === label,
  );
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match;
}

// ── Fixture ────────────────────────────────────────────────────────────────
type Task = {
  taskId: string;
  jobId: string;
  sessionKey: string;
  agent: string;
  status: string;
  lastEventAt: number;
  summary?: string;
};

const A1: Task = { taskId: "a1", jobId: "a1", sessionKey: "sess-a", agent: "clawdy", status: "running", lastEventAt: 1_000 };
const B1: Task = { taskId: "b1", jobId: "b1", sessionKey: "sess-b", agent: "scout", status: "running", lastEventAt: 2_000 };
const C1: Task = { taskId: "c1", jobId: "c1", sessionKey: "sess-c", agent: "archivist", status: "done", lastEventAt: 500, summary: "Old work" };

/** list_tasks filters by status server-side only — it is never scoped to one card's sessions (see app.ts's list_tasks handler). */
function listTasks(all: Task[], view: unknown): Task[] {
  const active = new Set(["queued", "running", "blocked", "needs-human"]);
  return view === "active" ? all.filter((t) => active.has(t.status)) : all;
}

interface HostCall {
  name: string;
  args: Json;
}

function createHost(options: { mounted?: Task; knownSessionKeys?: string[]; world: { tasks: Task[] } }) {
  const calls: HostCall[] = [];
  const host = {
    calls,
    displayMode: "inline",
    theme: "light" as const,
    toolOutput: options.mounted
      ? { structuredContent: { taskId: options.mounted.taskId, jobId: options.mounted.jobId, sessionKey: options.mounted.sessionKey } }
      : null,
    widgetState: options.knownSessionKeys ? { mounted: null, knownSessionKeys: options.knownSessionKeys } : null,
    setWidgetState(value: unknown) {
      host.widgetState = value as typeof host.widgetState;
    },
    callTool(name: string, args: Json): Promise<Json> {
      calls.push({ name, args });
      if (name === "list_tasks") {
        return Promise.resolve({ structuredContent: { tasks: listTasks(options.world.tasks, args.view) } });
      }
      if (name === "get_task") {
        const task = options.world.tasks.find((t) => t.taskId === args.taskId);
        if (args.detail === "prompt") {
          return Promise.resolve({ structuredContent: { taskId: args.taskId, prompt: { task: "do the thing" } } });
        }
        return Promise.resolve({ structuredContent: task ? { ...task, updates: [] } : { taskId: args.taskId, status: "error" } });
      }
      if (name === "get_session") {
        return Promise.resolve({
          structuredContent: { tasks: options.world.tasks.filter((t) => t.sessionKey === args.sessionId) },
        });
      }
      return Promise.resolve({});
    },
    requestDisplayMode({ mode }: { mode: string }): Promise<{ mode: string }> {
      calls.push({ name: "requestDisplayMode", args: { mode } });
      host.displayMode = mode;
      return Promise.resolve({ mode });
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
  const windowStub = { openai: host, addEventListener: () => {}, parent: undefined };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "document", "setTimeout", "clearTimeout", "queueMicrotask", "matchMedia", "console", SCRIPT) as (
    ...args: unknown[]
  ) => void;
  run(
    windowStub,
    documentStub,
    (fn: () => void, ms?: number) => setTimeout(fn, ms),
    (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    queueMicrotask,
    () => ({ matches: false }),
    console,
  );
  return root;
}

/** Drains the promise chain refresh() runs through (list_tasks -> get_task x2 -> get_session -> render). */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

const rowTitles = (root: El) => withClass(root, "cc-row").map((row) => textOf(withClass(row, "cc-title")[0]));
const sidebarTitles = (root: El) => withClass(root, "cc-fs-session").map((row) => textOf(withClass(row, "cc-title")[0]));
const lastListTasksView = (host: ReturnType<typeof createHost>) =>
  [...host.calls].reverse().find((c) => c.name === "list_tasks")?.args.view;

describe("compact -> Task Center -> compact", () => {
  it("restores the compact card's own sessions after the Task Center closes", async () => {
    const world = { tasks: [A1, B1, C1] };
    const host = createHost({ mounted: A1, world });
    const root = mount(host);
    await settle();

    // Compact: scoped to this card's own session, even though list_tasks
    // returns every conversation's active work.
    expect(rowTitles(root)).toEqual(["clawdy is working…"]);
    expect(lastListTasksView(host)).toBe("active");

    click(findButton(root, "Open Task Center"));
    await settle();

    // Task Center: every session, every group — that is the point of it.
    expect(sidebarTitles(root)).toEqual(["clawdy is working…", "scout is working…", "Old work"]);
    expect(lastListTasksView(host)).toBe("all");

    click(findButton(root, "Close"));
    await settle();

    // ...and closing it hands the compact card back exactly what it had.
    expect(rowTitles(root)).toEqual(["clawdy is working…"]);
    expect(lastListTasksView(host)).toBe("active");
  });

  it("keeps polling at compact breadth after the Task Center closes", async () => {
    const world = { tasks: [A1, B1, C1] };
    const host = createHost({ mounted: A1, world });
    const root = mount(host);
    await settle();

    click(findButton(root, "Open Task Center"));
    await settle();
    click(findButton(root, "Close"));
    await settle();

    const before = host.calls.filter((c) => c.name === "list_tasks").length;
    await new Promise((resolve) => setTimeout(resolve, 3_000)); // > pollIntervalMs("active")
    await settle();
    const after = host.calls.filter((c) => c.name === "list_tasks").length;

    expect(after).toBeGreaterThan(before);
    expect(lastListTasksView(host)).toBe("active");
    expect(rowTitles(root)).toEqual(["clawdy is working…"]);
  });

  it("re-runs the compact selection policy when the pinned session vanished while expanded", async () => {
    // No mounted run: this card's scope is the sessions it remembers, and its
    // pinned session is whichever of them is doing live work.
    const world = { tasks: [A1, B1] };
    const host = createHost({ knownSessionKeys: ["sess-a", "sess-b"], world });
    const root = mount(host);
    await settle();

    // sess-b is newer, so compact pins it — pinned rows sort first.
    expect(rowTitles(root)[0]).toBe("scout is working…");

    click(findButton(root, "Open Task Center"));
    await settle();

    // sess-b's task ages out of the store entirely while the Task Center is up.
    world.tasks = [A1, C1];
    click(findButton(root, "Close"));
    await settle();

    // The pin is re-resolved rather than left dangling on a session that is
    // gone — and sess-c stays out, being outside this card's scope.
    expect(rowTitles(root)).toEqual(["clawdy is working…"]);
    expect(host.calls.some((c) => c.name === "get_task" && c.args.taskId === "a1")).toBe(true);
  });
});
