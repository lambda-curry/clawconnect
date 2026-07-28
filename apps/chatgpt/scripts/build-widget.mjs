#!/usr/bin/env node
// Inlines widget/state.js into widget/shell.html to produce one
// self-contained dist/widget.html — the MCP Apps resource must ship as a
// single document (the host's CSP blocks anything it didn't bring inline;
// there is no bundler step for the served HTML itself). state.js is
// authored as a real ES module (export function/const) so it stays
// directly testable and lintable; this script strips the `export` keyword
// at inline time so the shell's plain (non-module) <script> tag — chosen
// deliberately to avoid any host CSP/sandbox edge case around
// type="module" — sees ordinary top-level declarations.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src", "widget");
const DIST_DIR = join(__dirname, "..", "dist");

const stateJs = readFileSync(join(SRC_DIR, "state.js"), "utf8");
const shellHtml = readFileSync(join(SRC_DIR, "shell.html"), "utf8");

const inlinedState = stateJs.replace(/^export (function|const) /gm, "$1 ");

// Line-start only, so this doesn't false-positive on the word "export"
// appearing in a comment (as it does a few lines up in this very file).
if (/^export\b/m.test(inlinedState)) {
  throw new Error("build-widget.mjs: an `export` statement survived inlining — state.js has an export shape this script doesn't strip yet.");
}

if (!shellHtml.includes("__STATE_MODULE__")) {
  throw new Error("build-widget.mjs: shell.html has no __STATE_MODULE__ placeholder to inline into.");
}

const output = shellHtml.replace("__STATE_MODULE__", inlinedState);

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "widget.html"), output, "utf8");

console.log(`[build-widget] wrote dist/widget.html (${output.length} bytes)`);
