import type { ArtifactProvenance, Artifacts, GatewayEvent, JobStatus } from "./types.ts";

const MAX_ARRAY_ITEMS = 50;

export function emptyArtifacts(): Artifacts {
  return { filesChanged: [], commandsRun: [], needsHumanDecision: false };
}

function addChangedFile(artifacts: Artifacts, filePath: string | undefined) {
  if (!filePath) return;
  if (artifacts.filesChanged.length >= MAX_ARRAY_ITEMS) return;
  if (!artifacts.filesChanged.includes(filePath)) {
    artifacts.filesChanged.push(filePath);
  }
}

function extractChangedFilesFromPatch(input: unknown): string[] {
  if (typeof input !== "string") return [];
  const matches = new Set<string>();

  for (const line of input.split("\n")) {
    let match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) {
      matches.add(match[1].trim());
      continue;
    }

    match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) {
      matches.add(match[1].trim());
    }
  }

  return [...matches];
}

export function processEvent(artifacts: Artifacts, event: GatewayEvent) {
  if (event.type !== "tool") return;

  const name = event.toolName;
  if ((name === "Bash" || name === "exec") && artifacts.commandsRun.length < MAX_ARRAY_ITEMS) {
    const cmd = String(event.args.command ?? "").slice(0, 120);
    if (cmd) artifacts.commandsRun.push(cmd);
  }

  const directFilePath = [event.args.file_path, event.args.filePath, event.args.path, event.args.file].find(
    (value) => typeof value === "string",
  ) as string | undefined;

  if (name === "Edit" || name === "Write" || name === "edit" || name === "write") {
    addChangedFile(artifacts, directFilePath);
  }

  if (name === "ApplyPatch" || name === "apply_patch") {
    for (const filePath of extractChangedFilesFromPatch(event.args.input)) {
      addChangedFile(artifacts, filePath);
    }
  }
}

/**
 * Everything below infers an identifier from text nobody wrote for a parser.
 *
 * A summary is an agent narrating to a human: it restates preconditions it was
 * given, pastes JSON it read, and wraps names in markdown. So a value scraped
 * from it is a guess about what the prose MEANT, and is weaker evidence than
 * the same value read off a command the agent actually ran — a `checkout -b`
 * in `commandsRun` is a thing that happened, while "branch `x`" in prose may be
 * describing someone else's branch, a branch it was asked to avoid, or a branch
 * that does not exist yet. Both are recorded, and `Artifacts.provenance` keeps
 * them distinguishable so a reader can weigh them differently; where both are
 * available, the command wins.
 */

const PR_URL = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/;

const COMMIT_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/commit\/([0-9a-f]{7,40})\b/g;

/**
 * A hex run is only SHA-shaped when it stands alone. `\b` does not establish
 * that: `-`, `_` and `/` are word boundaries, so the 32 hex characters inside a
 * session slug (`run-62c3…`) or a path segment satisfy `\b` on both sides and
 * were being recorded as a commit. Requiring the neighbours to be none of
 * `-_/` or alphanumeric also rejects runs longer than 40, which no SHA is.
 */
const HEX_RUN = /(?<![0-9A-Za-z_\-/])[0-9a-f]{7,40}(?![0-9A-Za-z_\-/])/g;

/**
 * …and being SHA-shaped is not a claim. The run must be introduced as a commit
 * by an adjacent cue, reachable across markdown and a linking word. Without
 * this, any 7+ digit number is eligible, because `0-9` is a subset of the hex
 * class — a CI run id lifted out of a pasted URL was recorded as the commit of
 * a job that made none.
 */
const COMMIT_CUE = /(?:commit(?:s|ted)?|sha|head)\b[^A-Za-z0-9]*(?:at|as|is|to|=)?[^A-Za-z0-9]*$/i;

/**
 * …and even a cue can be introducing an INPUT. "expected head <sha>", "base
 * <sha>", "from commit <sha>" are preconditions the agent was handed and
 * restated, not work it did; that is exactly how a job whose only changed file
 * was a scratch file came to report a commit SHA. Matched by adjacency to the
 * hex run rather than by scanning a fixed window, so an ordinary sentence like
 * "the change was reviewed and committed as <sha>" still reads as a real commit.
 */
const COMMIT_INPUT_MARKER =
  /\b(?:expected|base|from|was|previous|parent)\b[^A-Za-z0-9]*(?:head|commit|sha|ref|revision)?[^A-Za-z0-9]*$/i;

const BRANCH_FROM_COMMAND = /(?:checkout -b|switch -c)\s+(\S+)/;

/**
 * The capture class excluded quotes but not backticks, so ``branch `x`,`` was
 * recorded as the branch name with its markdown attached. Trailing sentence
 * punctuation is stripped for the same reason.
 */
const BRANCH_FROM_PROSE = /(?:branch|checkout -b|switch -c)\s+['"`]?([^\s'"`]+)/;
const TRAILING_PUNCTUATION = /[.,;:)\]}]+$/;

function setInferred(
  artifacts: Artifacts,
  field: "commitSha" | "branchName" | "prUrl",
  value: string,
  provenance: ArtifactProvenance,
) {
  artifacts[field] = value;
  artifacts.provenance = { ...artifacts.provenance, [field]: provenance };
}

/**
 * Is the SHA at `at` introduced as something the agent was HANDED rather than
 * something it produced?
 *
 * One function, deliberately called from both branches below. The rejection
 * started life inline on the bare-hex branch only, while the commit-URL branch
 * returned above it — so a URL introduced by "expected head" was recorded as a
 * commit the job made, which is the exact defect this file exists to fix,
 * arriving through the other door. A guard that has to be remembered in two
 * places is a guard that will be forgotten in one.
 */
function isRestatedInput(summary: string, at: number): boolean {
  return COMMIT_INPUT_MARKER.test(summary.slice(0, at));
}

function findCommitSha(summary: string): string | undefined {
  // A commit URL is evidence that a commit EXISTS. It is never evidence that
  // THIS job produced it: "expected head <url>" restates a precondition
  // exactly the way "expected head <sha>" does, and both must be rejected.
  //
  // Iterated rather than first-match-wins so a summary that names an input
  // commit before the real one — "base <url>, committed as <url>" — still
  // finds the real one instead of giving up at the input.
  for (const match of summary.matchAll(COMMIT_URL)) {
    if (isRestatedInput(summary, match.index)) continue;
    return match[1];
  }

  for (const match of summary.matchAll(HEX_RUN)) {
    if (!COMMIT_CUE.test(summary.slice(0, match.index))) continue;
    if (isRestatedInput(summary, match.index)) continue;
    return match[0];
  }
  return undefined;
}

function findBranchName(
  artifacts: Artifacts,
  summary: string,
): { name: string; provenance: ArtifactProvenance } | undefined {
  for (const cmd of artifacts.commandsRun) {
    const name = cmd.match(BRANCH_FROM_COMMAND)?.[1].replace(TRAILING_PUNCTUATION, "");
    if (name) return { name, provenance: "command" };
  }
  const name = summary.match(BRANCH_FROM_PROSE)?.[1].replace(TRAILING_PUNCTUATION, "");
  if (name) return { name, provenance: "summary-text" };
  return undefined;
}

export function extractPatternsFromSummary(artifacts: Artifacts, summary: string) {
  if (!artifacts.prUrl) {
    const prMatch = summary.match(PR_URL);
    if (prMatch) setInferred(artifacts, "prUrl", prMatch[0], "summary-text");
  }
  if (!artifacts.commitSha) {
    const sha = findCommitSha(summary);
    if (sha) setInferred(artifacts, "commitSha", sha, "summary-text");
  }
  if (!artifacts.branchName) {
    const branch = findBranchName(artifacts, summary);
    if (branch) setInferred(artifacts, "branchName", branch.name, branch.provenance);
  }
  const lastSentence = summary.slice(-200);
  if (/\?\s*$/.test(lastSentence) || /please confirm|which option|waiting for|choose between/i.test(lastSentence)) {
    artifacts.needsHumanDecision = true;
  }
}

export function deriveNextStep(artifacts: Artifacts, status: JobStatus): string | undefined {
  if (status === "error") return "Fix the issue and retry.";
  if (artifacts.prUrl) return "Review or merge the PR.";
  if (artifacts.needsHumanDecision) return "Answer the pending question to continue.";
  if (artifacts.filesChanged.length > 0 && !artifacts.commitSha) return "Review changes and commit.";
  if (artifacts.filesChanged.length > 0) return "Review the changes or continue with the next task.";
  return undefined;
}
