import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ClawConnect is public. Nothing a reader can see should require, assume, or
 * even name the private host, company, or agent deployment it happens to have
 * been built alongside — an integration is supposed to read as "bring your own
 * runtime", and a stray internal name quietly turns that into "bring ours".
 *
 * Grep is the whole mechanism on purpose: this repo has no CI or lint harness,
 * so a check nobody runs is a check that doesn't exist, and a test file is the
 * one thing here that always runs.
 *
 * See docs/architecture/runtime-boundary.md for what the boundary actually is.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * Private names. `claude-fleet` is deliberately NOT here: it is the real,
 * exported id of the legacy local adapter that ships in this repo, so banning
 * it would mean lying about the code rather than cleaning it up.
 */
const BANNED_NAMES = /\b(clawdy|saffron|t3|arbor|main-mini|minip3)\b/i;

/** Things no public file can meaningfully reference, wherever they appear. */
const BANNED_REFERENCES = /(\/Users\/|\b(thr|art|con)_[0-9a-f]{6,})/;

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".job-store"]);

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

/** file → the offending lines, as `path:lineNo: text`, for a readable failure. */
function offenders(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

const isMarkdown = (p: string) => p.endsWith(".md");

/**
 * Docs a newcomer actually navigates. The dated `docs/architecture/2026-*.md`
 * and `docs/decisions/` files are excluded here and only checked for internal
 * references below: they are historical build records, each carrying its own
 * non-normative banner, and rewriting history to look tidier would make them
 * worse records.
 */
const PUBLIC_DOCS = walk(REPO_ROOT, isMarkdown).filter((p) => {
  const rel = relative(REPO_ROOT, p);
  if (rel.startsWith(`docs${sep}architecture${sep}20`)) return false;
  if (rel.startsWith(`docs${sep}decisions${sep}`)) return false;
  return true;
});

/** Shipped source. Test files are excluded — this file names every banned term. */
const SHIPPED_SOURCE = walk(join(REPO_ROOT, "packages"), (p) => /\.(ts|js)$/.test(p) && !p.includes(".test."))
  .concat(walk(join(REPO_ROOT, "apps"), (p) => /\.(ts|js|html)$/.test(p) && !p.includes(".test.")));

describe("public surface stays host-neutral", () => {
  it("finds the files it is supposed to be checking", () => {
    // A walk that silently matched nothing would make every assertion below
    // pass for the wrong reason.
    expect(PUBLIC_DOCS.map((p) => relative(REPO_ROOT, p))).toContain("README.md");
    expect(PUBLIC_DOCS.map((p) => relative(REPO_ROOT, p))).toContain(
      join("docs", "architecture", "runtime-boundary.md"),
    );
    expect(SHIPPED_SOURCE.length).toBeGreaterThan(20);
  });

  it("can fail — negative control on both patterns", () => {
    // A hygiene check that cannot fail is decoration. These are the exact
    // strings this sweep removed from the repository.
    expect(BANNED_NAMES.test("then ask Clawdy to continue")).toBe(true);
    expect(BANNED_NAMES.test('runtime: "t3-fleet"')).toBe(true);
    expect(BANNED_REFERENCES.test("`/Users/someone/notes/report.md`")).toBe(true);
    expect(BANNED_REFERENCES.test("thread `thr_9dfe1478`")).toBe(true);
    // …and the exemption holds: the legacy adapter's real id stays legal.
    expect(BANNED_NAMES.test("the built-in claude-fleet adapter")).toBe(false);
  });

  it("names no private host, company, or agent in public docs", () => {
    expect(offenders(PUBLIC_DOCS, BANNED_NAMES)).toEqual([]);
  });

  it("names no private host, company, or agent in shipped source", () => {
    expect(offenders(SHIPPED_SOURCE, BANNED_NAMES)).toEqual([]);
  });

  it("references no internal path or thread id in any document", () => {
    expect(offenders(walk(REPO_ROOT, isMarkdown), BANNED_REFERENCES)).toEqual([]);
  });

  it("keeps the runtime seam documented as optional", async () => {
    const boundary = readFileSync(join(REPO_ROOT, "docs/architecture/runtime-boundary.md"), "utf8");
    expect(boundary).toMatch(/registers no runtime/);

    // Behavioral, not textual. An earlier version of this test grepped the
    // entrypoints for the registry class name; once loading moved behind
    // loadAgentSessionRuntimes() that grep passed for the wrong reason. Assert
    // the actual invariant instead: with no module named, nothing is
    // registered, so a default install cannot reach any runtime.
    const { loadAgentSessionRuntimes, RUNTIME_MODULES_ENV } = await import(
      "../packages/core/src/runtime-modules.ts"
    );
    await expect(loadAgentSessionRuntimes(undefined)).resolves.toBeUndefined();
    await expect(loadAgentSessionRuntimes("")).resolves.toBeUndefined();

    // And the operator-facing way in is documented, or the seam is unreachable
    // in practice from a shipped binary — the gap that motivated it.
    const guide = readFileSync(join(REPO_ROOT, "docs/guides/runtime-integration.md"), "utf8");
    expect(guide).toContain(RUNTIME_MODULES_ENV);
  });
});
