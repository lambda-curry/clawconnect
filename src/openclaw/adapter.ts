import { randomUUID } from 'node:crypto'
import { OpenClawGateway, type GatewayEvent } from './gateway.js'

const TIMEOUT_MS = 600_000 // 10 minutes
const POLL_WAIT_MS = 50_000 // max time check waits before returning
const MAX_LOG_ENTRIES = 100
const MAX_ARRAY_ITEMS = 50

// ── Types ────────────────────────────────────────────────────────────────────

export type LogEntry = { ts: number; type: string; text: string }

export type Artifacts = {
  filesChanged: string[]
  commandsRun: string[]
  branchName?: string
  commitSha?: string
  prUrl?: string
  needsHumanDecision: boolean
}

export type ErrorCategory = 'auth' | 'timeout' | 'merge_conflict' | 'test_failure' | 'tooling' | 'unknown'

export type ErrorInfo = {
  category: ErrorCategory
  message: string
  suggestedRecovery: string
}

export type ContinuationState = {
  sessionKey: string
  lastJobId: string
  workspace?: string
  lastSummary: string
  artifacts: Artifacts
  recommendedNextStep?: string
}

export type JobStatus = 'running' | 'completed' | 'error'

export type Job = {
  jobId: string
  sessionKey: string
  status: JobStatus
  summary?: string
  error?: string
  errorInfo?: ErrorInfo
  startedAt: number
  logs: LogEntry[]
  artifacts: Artifacts
}

// ── Artifact extraction ──────────────────────────────────────────────────────

function emptyArtifacts(): Artifacts {
  return { filesChanged: [], commandsRun: [], needsHumanDecision: false }
}

function processEvent(artifacts: Artifacts, event: GatewayEvent) {
  if (event.type === 'tool' && artifacts.commandsRun.length < MAX_ARRAY_ITEMS) {
    const name = event.toolName
    if (name === 'Bash' || name === 'exec') {
      const cmd = String(event.args.command ?? '').slice(0, 120)
      if (cmd) artifacts.commandsRun.push(cmd)
    }
    if ((name === 'Edit' || name === 'Write' || name === 'read') && event.args.file_path) {
      const fp = String(event.args.file_path)
      if (artifacts.filesChanged.length < MAX_ARRAY_ITEMS && !artifacts.filesChanged.includes(fp)) {
        artifacts.filesChanged.push(fp)
      }
    }
  }
}

function extractPatternsFromSummary(artifacts: Artifacts, summary: string) {
  if (!artifacts.prUrl) {
    const prMatch = summary.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)
    if (prMatch) artifacts.prUrl = prMatch[0]
  }
  if (!artifacts.commitSha) {
    const shaMatch = summary.match(/\b([0-9a-f]{7,40})\b/)
    if (shaMatch) artifacts.commitSha = shaMatch[1]
  }
  if (!artifacts.branchName) {
    const branchMatch = summary.match(/(?:branch|checkout -b|switch -c)\s+['"]?([^\s'"]+)/)
    if (branchMatch) artifacts.branchName = branchMatch[1]
  }
  // Check commands for git patterns too
  for (const cmd of artifacts.commandsRun) {
    if (!artifacts.branchName) {
      const m = cmd.match(/(?:checkout -b|switch -c)\s+(\S+)/)
      if (m) artifacts.branchName = m[1]
    }
  }
  // Detect if agent needs human input
  const lastSentence = summary.slice(-200)
  if (/\?\s*$/.test(lastSentence) || /please confirm|which option|waiting for|choose between/i.test(lastSentence)) {
    artifacts.needsHumanDecision = true
  }
}

// ── Error classification ─────────────────────────────────────────────────────

const ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory; recovery: string }> = [
  { pattern: /authenticat|401|403|permission denied|unauthorized/i, category: 'auth', recovery: 'Check credentials and permissions, then retry.' },
  { pattern: /timed?\s?out|ETIMEDOUT/i, category: 'timeout', recovery: 'The task may be too large. Try breaking it into smaller steps, or continue from the same session.' },
  { pattern: /merge conflict|CONFLICT/i, category: 'merge_conflict', recovery: 'Resolve the merge conflict, then ask Clawdy to continue.' },
  { pattern: /test fail|tests? failed|assertion|expect.*received/i, category: 'test_failure', recovery: 'Review the failing tests and fix the issues.' },
  { pattern: /ENOENT|command not found|module not found|Cannot find/i, category: 'tooling', recovery: 'Check that required tools and dependencies are installed.' },
]

function classifyError(message: string): ErrorInfo {
  for (const { pattern, category, recovery } of ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return { category, message, suggestedRecovery: recovery }
    }
  }
  return { category: 'unknown', message, suggestedRecovery: 'Review the error details and retry.' }
}

// ── Session continuation ─────────────────────────────────────────────────────

const sessions = new Map<string, ContinuationState>()

function deriveNextStep(artifacts: Artifacts, status: JobStatus): string | undefined {
  if (status === 'error') return 'Fix the issue and retry.'
  if (artifacts.prUrl) return 'Review or merge the PR.'
  if (artifacts.needsHumanDecision) return 'Answer the pending question to continue.'
  if (artifacts.filesChanged.length > 0 && !artifacts.commitSha) return 'Review changes and commit.'
  if (artifacts.filesChanged.length > 0) return 'Review the changes or continue with the next task.'
  return undefined
}

// ── Gateway + job store ──────────────────────────────────────────────────────

const gateway = new OpenClawGateway(
  process.env.OPENCLAW_URL!,
  process.env.OPENCLAW_PASSWORD!,
)

const jobs = new Map<string, Job>()

export class OpenClawAdapter {
  submitTask(input: {
    task: string
    context?: string
    workspace?: string
    sessionKey?: string
  }): Job {
    const message = input.context
      ? `${input.context}\n\n${input.task}`
      : input.task

    const sessionKey = input.sessionKey ?? `agent:chatgpt:${randomUUID()}`
    const jobId = randomUUID()
    const artifacts = emptyArtifacts()
    const job: Job = { jobId, sessionKey, status: 'running', startedAt: Date.now(), logs: [], artifacts }
    jobs.set(jobId, job)

    gateway.chat(sessionKey, message, TIMEOUT_MS, (event) => {
      if (job.logs.length < MAX_LOG_ENTRIES) {
        job.logs.push({ ts: Date.now(), type: event.type, text: event.text })
      }
      processEvent(artifacts, event)
    }).then(
      (reply) => {
        job.status = 'completed'
        job.summary = reply
        extractPatternsFromSummary(artifacts, reply)
        sessions.set(sessionKey, {
          sessionKey,
          lastJobId: jobId,
          workspace: input.workspace,
          lastSummary: reply.slice(0, 500),
          artifacts,
          recommendedNextStep: deriveNextStep(artifacts, 'completed'),
        })
        console.log(`[job ${jobId}] completed, ${reply.length} chars, ${artifacts.filesChanged.length} files`)
      },
      (err) => {
        job.status = 'error'
        job.error = err instanceof Error ? err.message : String(err)
        job.errorInfo = classifyError(job.error)
        sessions.set(sessionKey, {
          sessionKey,
          lastJobId: jobId,
          workspace: input.workspace,
          lastSummary: job.error,
          artifacts,
          recommendedNextStep: deriveNextStep(artifacts, 'error'),
        })
        console.log(`[job ${jobId}] error (${job.errorInfo.category}): ${job.error}`)
      },
    )

    return job
  }

  getJob(jobId: string): Job | undefined {
    return jobs.get(jobId)
  }

  getSessionState(sessionKey: string): ContinuationState | undefined {
    return sessions.get(sessionKey)
  }

  async waitForJob(jobId: string): Promise<Job | undefined> {
    const job = jobs.get(jobId)
    if (!job || job.status !== 'running') return job
    const deadline = Date.now() + POLL_WAIT_MS
    while (Date.now() < deadline && job.status === 'running') {
      await new Promise(r => setTimeout(r, 1000))
    }
    return job
  }
}
