import { describe, expect, it } from "vitest";
import { deriveNextStep, emptyArtifacts, extractPatternsFromSummary } from "./artifacts.ts";

/**
 * Every fixture here is synthetic but shaped like a real terminal summary that
 * caused a fabricated identifier: a manager restating preconditions, a pasted
 * URL carrying a numeric id, and markdown around a branch name. What is being
 * defended is that an identifier only appears when the prose actually claimed
 * it — a wrong SHA is worse than no SHA, because deriveNextStep believes it.
 */

function extract(summary: string, commandsRun: string[] = []) {
  const artifacts = emptyArtifacts();
  artifacts.commandsRun = commandsRun;
  extractPatternsFromSummary(artifacts, summary);
  return artifacts;
}

describe("commitSha", () => {
  it("ignores a SHA the prose restated as a precondition", () => {
    const artifacts = extract(
      "Blocked before starting: the working tree was not clean. (full context: repo/PR #42, " +
        "branch `some-branch-name`, expected head `7c2fa19b`, base `e40d5b2`, " +
        "session run-4d1f8a2c6b3e9047f5a1c8d2e6b0937a)",
    );

    expect(artifacts.commitSha).toBeUndefined();
    expect(artifacts.branchName).toBe("some-branch-name");
    expect(artifacts.provenance?.branchName).toBe("summary-text");
  });

  it("ignores a hex run embedded in a hyphenated slug", () => {
    expect(extract("Attached to session run-4d1f8a2c6b3e9047f5a1c8d2e6b0937a.").commitSha).toBeUndefined();
    expect(extract("Wrote artifact-1a2b3c4d5e-final.json to the scratch directory.").commitSha).toBeUndefined();
  });

  it("ignores a CI run id pasted inside a URL", () => {
    const artifacts = extract(
      'Read-only check only. The failing job is {"detailsUrl": ' +
        '"https://github.com/o/r/actions/runs/48825170394/job/71204486315"} and nothing was changed.',
    );

    expect(artifacts.commitSha).toBeUndefined();
  });

  it("ignores a bare long decimal number in prose", () => {
    expect(extract("Scanned 12345678 rows in 1755123456 ms.").commitSha).toBeUndefined();
  });

  it("takes a SHA introduced as a commit", () => {
    const artifacts = extract("Fixed the parser and committed as `a1b2c3d4`.");

    expect(artifacts.commitSha).toBe("a1b2c3d4");
    expect(artifacts.provenance?.commitSha).toBe("summary-text");
  });

  it("takes a SHA from a GitHub commit URL", () => {
    const artifacts = extract("Landed: https://github.com/o/r/commit/9f8e7d6c5b4a3928 — see the diff.");

    expect(artifacts.commitSha).toBe("9f8e7d6c5b4a3928");
    expect(artifacts.provenance?.commitSha).toBe("summary-text");
  });

  it("still reads a commit whose sentence happens to contain an input word", () => {
    expect(extract("The change was reviewed and committed as `a1b2c3d4`.").commitSha).toBe("a1b2c3d4");
  });
});

describe("branchName", () => {
  it("strips markdown and trailing punctuation from prose", () => {
    expect(extract("Work continues on branch `feature-x`, which is pushed.").branchName).toBe("feature-x");
    expect(extract('Created branch "feature-y".').branchName).toBe("feature-y");
  });

  it("prefers a branch the agent actually created over one it merely mentioned", () => {
    const artifacts = extract("Started from branch `some-other-branch`, then began the work.", [
      "git checkout -b feature-real",
    ]);

    expect(artifacts.branchName).toBe("feature-real");
    expect(artifacts.provenance?.branchName).toBe("command");
  });

  it("records command provenance for switch -c", () => {
    const artifacts = extract("Done.", ["git switch -c feature-z"]);

    expect(artifacts.branchName).toBe("feature-z");
    expect(artifacts.provenance?.branchName).toBe("command");
  });
});

describe("prUrl", () => {
  it("is unchanged and carries summary-text provenance", () => {
    const artifacts = extract("Opened https://github.com/o/r/pull/42 for review.");

    expect(artifacts.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(artifacts.provenance?.prUrl).toBe("summary-text");
  });
});

describe("deriveNextStep", () => {
  it("still asks for a commit when no credible SHA was found", () => {
    const artifacts = extract("Edited the prompt file. (full context: expected head `7c2fa19b`)");
    artifacts.filesChanged.push("prompts/example.md");

    expect(deriveNextStep(artifacts, "completed")).toBe("Review changes and commit.");
  });

  it("does not ask for a commit once one is credibly claimed", () => {
    const artifacts = extract("Committed as `a1b2c3d4`.");
    artifacts.filesChanged.push("src/example.ts");

    expect(deriveNextStep(artifacts, "completed")).toBe("Review the changes or continue with the next task.");
  });
});

describe("provenance", () => {
  it("makes no entry for an identifier that was never inferred", () => {
    expect(extract("Nothing to report.").provenance).toBeUndefined();
  });
});
