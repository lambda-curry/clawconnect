#!/usr/bin/env node
/**
 * Record the commit this artifact was built from, at build time.
 *
 * get_connection_info reports a build identity so a client can tell "the
 * server is wrong" from "my tool catalog is stale" — the question that could
 * not be answered when the deployment box spent a day serving three commits
 * that existed on no remote and no merged branch.
 *
 * Stamping it here, rather than setting an environment variable on the
 * service, is deliberate: a hand-set SHA in a launchd plist is correct once
 * and wrong after the next deploy, and a build identity that confidently
 * reports the wrong commit is strictly worse than one that admits it does not
 * know. Written during the build, it describes the artifact by construction.
 *
 * When there is no repository to ask (an installed package, a container built
 * from a tarball), it writes nothing and the server reports "unknown".
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist");

function currentSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const sha = currentSha();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "build-sha.txt"), sha, "utf8");
console.log(`[stamp-build] ${sha || "(no git repository — build identity will report 'unknown')"}`);
