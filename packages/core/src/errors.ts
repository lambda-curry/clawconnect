import type { ErrorCategory, ErrorInfo } from "./types.ts";

const ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory; recovery: string }> = [
  {
    pattern: /authenticat|401|403|permission denied|unauthorized/i,
    category: "auth",
    recovery: "Check credentials and permissions, then retry.",
  },
  {
    pattern: /timed?\s?out|ETIMEDOUT/i,
    category: "timeout",
    recovery: "The task may be too large. Try breaking it into smaller steps, or continue from the same session.",
  },
  {
    pattern: /merge conflict|CONFLICT/i,
    category: "merge_conflict",
    recovery: "Resolve the merge conflict, then ask Clawdy to continue.",
  },
  {
    pattern: /test fail|tests? failed|assertion|expect.*received/i,
    category: "test_failure",
    recovery: "Review the failing tests and fix the issues.",
  },
  {
    pattern: /ENOENT|command not found|module not found|Cannot find/i,
    category: "tooling",
    recovery: "Check that required tools and dependencies are installed.",
  },
];

export function classifyError(message: string): ErrorInfo {
  for (const { pattern, category, recovery } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { category, message, suggestedRecovery: recovery };
    }
  }
  return { category: "unknown", message, suggestedRecovery: "Review the error details and retry." };
}
