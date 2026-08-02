import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * shell.html is not a module — it's a template whose single <script> block gets
 * state.js/protocol.js textually inlined by scripts/build-widget.mjs. Nothing
 * in the normal toolchain type-checks or link-checks across that seam: tsc
 * doesn't read .html, and the unit tests import state.js directly, so a
 * function that shell.html *calls* but nobody *defines* is invisible to every
 * other test in this suite.
 *
 * That is not hypothetical. Commit 30a5669 renamed two call sites to
 * ensurePinnedTask and introduced deriveCardTabs/defaultCardTab/
 * isLikelyMarkdown/renderMarkdownHtml, without adding any of the five to
 * state.js. Every existing test still passed, the widget build still
 * succeeded, and `node -e "new Function(...)"` still parsed the output —
 * because a ReferenceError is a *runtime* error. The built widget threw on its
 * very first render(), painted an empty div, and never polled at all.
 *
 * This test closes that seam: every bare function call in shell.html's script
 * must resolve to something defined in shell.html itself, exported by an
 * inlined module, or a genuine browser/JS global.
 */

const DIR = new URL(".", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR), "utf8");

const shell = read("shell.html");
const modules = ["state.js", "protocol.js"].map(read).join("\n");

// The script block is everything from the inline placeholder onward.
const script = shell.slice(shell.indexOf("__STATE_MODULE__"));

/** Names the inlined modules bring into scope. build-widget.mjs strips the leading `export`, so top-level declarations of both kinds land in the shell's scope. */
function moduleScope(): Set<string> {
  const names = new Set<string>();
  for (const m of modules.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of modules.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)/gm)) names.add(m[1]);
  return names;
}

/**
 * Parameter names, which are callable in their own body (`new Promise((resolve,
 * reject) => …)` calls `reject(…)`; a `cb` parameter gets invoked as `cb(…)`).
 * Deliberately scope-blind — this check is about "is this name defined
 * anywhere", not about precise scope resolution.
 */
function parameterNames(source: string): Set<string> {
  const names = new Set<string>();
  const lists = [
    ...source.matchAll(/\(([^()]*)\)\s*=>/g),
    ...source.matchAll(/(?:async\s+)?function\s*[\w$]*\s*\(([^()]*)\)/g),
    ...source.matchAll(/catch\s*\(\s*([\w$]+)\s*\)/g),
  ];
  for (const m of lists) {
    for (const part of m[1].split(",")) {
      const id = /([A-Za-z_$][\w$]*)/.exec(part.trim());
      if (id) names.add(id[1]);
    }
  }
  for (const m of source.matchAll(/(?:^|[\s;,({[])([\w$]+)\s*=>/g)) names.add(m[1]); // single-param arrow, no parens
  return names;
}

/** Names shell.html's own script declares, at any nesting depth (a nested helper is still resolvable from its enclosing scope). */
function shellScope(): Set<string> {
  const names = new Set<string>();
  for (const m of script.matchAll(/(?:^|[\s;{(])(?:async\s+)?function\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of script.matchAll(/(?:^|[\s;{])(?:const|let|var)\s+([\w$]+)\s*=/gm)) names.add(m[1]);
  for (const n of parameterNames(script)) names.add(n);
  return names;
}

// Language keywords and control-flow forms that a `name(` regex also matches.
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "await", "else", "do", "try",
  "in", "of", "case", "delete", "void", "throw", "yield", "instanceof", "super", "this", "async",
]);

// Genuine platform globals this widget legitimately calls.
const GLOBALS = new Set([
  "Array", "Boolean", "Date", "Error", "JSON", "Map", "Math", "Number", "Object", "Promise", "Set", "String",
  "clearInterval", "clearTimeout", "matchMedia", "parseFloat", "parseInt", "queueMicrotask", "setInterval", "setTimeout",
  "structuredClone",
]);

/**
 * Bare `name(` call sites, excluding member calls (`a.b()`), keywords, and
 * anything inside a comment or string — prose like "…stops entirely (see…)"
 * and tool names in string literals such as "list_tasks" would otherwise
 * read as calls.
 */
function calledNames(source: string): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // line comments
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, (m) =>
      // Keep ${...} interpolations (they hold real calls); drop the literal parts.
      [...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" "),
    )
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");

  const names = new Set<string>();
  for (const m of code.matchAll(/(\.?)\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[1] === ".") continue;
    if (KEYWORDS.has(m[2])) continue;
    names.add(m[2]);
  }
  return names;
}

describe("shell.html <-> inlined module seam", () => {
  it("every function shell.html calls is actually defined — the seam tsc and the unit tests both miss", () => {
    const resolvable = new Set([...moduleScope(), ...shellScope(), ...GLOBALS]);
    const unresolved = [...calledNames(script)].filter((n) => !resolvable.has(n)).sort();
    expect(unresolved).toEqual([]);
  });

  it("catches a call to a function nobody defines (proves the check above can fail)", () => {
    const resolvable = new Set([...moduleScope(), ...shellScope(), ...GLOBALS]);
    const injected = calledNames(`${script}\nconst x = totallyUndefinedHelper(1);`);
    expect([...injected].filter((n) => !resolvable.has(n))).toEqual(["totallyUndefinedHelper"]);
  });

  it("the five functions commit 30a5669 left undefined are defined now", () => {
    const scope = moduleScope();
    for (const name of ["ensurePinnedTask", "deriveCardTabs", "defaultCardTab", "isLikelyMarkdown", "renderMarkdownHtml"]) {
      expect(scope.has(name), `${name} must be defined in an inlined module`).toBe(true);
    }
  });

  it("state.js and protocol.js stay free of NUL bytes, which make the files read as binary to grep and other line tools", () => {
    expect(modules).not.toContain(String.fromCharCode(0));
  });
});
