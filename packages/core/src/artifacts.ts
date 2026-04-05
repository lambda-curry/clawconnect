import type { Artifacts, GatewayEvent, JobStatus } from "./types.ts";

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

export function extractPatternsFromSummary(artifacts: Artifacts, summary: string) {
  if (!artifacts.prUrl) {
    const prMatch = summary.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    if (prMatch) artifacts.prUrl = prMatch[0];
  }
  if (!artifacts.commitSha) {
    const shaMatch = summary.match(/\b([0-9a-f]{7,40})\b/);
    if (shaMatch) artifacts.commitSha = shaMatch[1];
  }
  if (!artifacts.branchName) {
    const branchMatch = summary.match(/(?:branch|checkout -b|switch -c)\s+['"]?([^\s'"]+)/);
    if (branchMatch) artifacts.branchName = branchMatch[1];
  }
  for (const cmd of artifacts.commandsRun) {
    if (!artifacts.branchName) {
      const m = cmd.match(/(?:checkout -b|switch -c)\s+(\S+)/);
      if (m) artifacts.branchName = m[1];
    }
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
