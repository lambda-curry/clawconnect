import type { Job, JobSnapshot } from "@clawconnect/core";

export function formatJobResult(job: Job, json: boolean): string {
  if (json) {
    return JSON.stringify({
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      status: job.status,
      summary: job.summary,
      error: job.error,
      errorInfo: job.errorInfo,
      artifacts: job.artifacts,
      logCount: job.logs.length,
    });
  }

  const lines: string[] = [];

  if (job.status === "error") {
    lines.push(`ERROR: ${job.error}`);
    if (job.errorInfo) {
      lines.push(`  Category: ${job.errorInfo.category}`);
      lines.push(`  Recovery: ${job.errorInfo.suggestedRecovery}`);
    }
  } else if (job.summary) {
    lines.push(job.summary);
  } else {
    lines.push("Task completed (no summary returned).");
  }

  const a = job.artifacts;
  if (a.filesChanged.length > 0) {
    lines.push("");
    lines.push(`Files changed (${a.filesChanged.length}):`);
    for (const f of a.filesChanged) lines.push(`  ${f}`);
  }
  if (a.branchName) lines.push(`Branch: ${a.branchName}`);
  if (a.commitSha) lines.push(`Commit: ${a.commitSha}`);
  if (a.prUrl) lines.push(`PR: ${a.prUrl}`);
  if (a.needsHumanDecision) lines.push("\n⚠ OpenClaw is waiting for your input.");

  return lines.join("\n");
}

export function formatJobStatus(job: Job, json: boolean): string {
  if (json) {
    return JSON.stringify({
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      status: job.status,
      logCount: job.logs.length,
      lastEventAt: job.lastEventAt,
      artifacts: job.artifacts,
    });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  const lines = [
    `Job: ${job.jobId.slice(0, 8)}`,
    `Status: ${job.status}`,
    `Elapsed: ${elapsed}s`,
    `Logs: ${job.logs.length} entries`,
  ];

  if (job.logs.length > 0) {
    const recent = job.logs.slice(-5);
    lines.push("");
    lines.push("Recent activity:");
    for (const log of recent) {
      lines.push(`  [${log.type}] ${log.text}`);
    }
  }

  return lines.join("\n");
}

export function formatSnapshot(snapshot: JobSnapshot, json: boolean): string {
  if (json) return JSON.stringify(snapshot);

  const lines = [
    `Job: ${snapshot.jobId.slice(0, 8)} | Status: ${snapshot.status}`,
    `Session: ${snapshot.sessionKey.slice(-12)}`,
  ];

  if (snapshot.continuationState?.recommendedNextStep) {
    lines.push(`Next step: ${snapshot.continuationState.recommendedNextStep}`);
  }

  return lines.join("\n");
}

export function progressLine(text: string) {
  process.stderr.write(`\r\x1b[K${text}`);
}

export function progressDone() {
  process.stderr.write("\r\x1b[K");
}
