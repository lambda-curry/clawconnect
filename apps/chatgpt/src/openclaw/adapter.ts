import { randomUUID } from 'node:crypto'
import { OpenClawGateway, type GatewayEvent } from './gateway.js'

const TIMEOUT_MS = 600_000 // 10 minutes
const POLL_WAIT_MS = 50_000 // max time check waits before returning
const MAX_LOG_ENTRIES = 200
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
  lastSummary: string
  artifacts: Artifacts
  recommendedNextStep?: string
}

/**
 * Server-side job status. The widget derives its own richer UI states
 * (active, quiet, stalled, etc.) from these plus timestamps.
 */
export type JobStatus = 'running' | 'completed' | 'completed_no_summary' | 'error'

export type Job = {
  jobId: string
  sessionKey: string
  status: JobStatus
  summary?: string
  error?: string
  errorInfo?: ErrorInfo
  startedAt: number
  lastEventAt: number
  logs: LogEntry[]
  artifacts: Artifacts
}

/**
 * The snapshot sent to the widget on every poll. Contains everything
 * the widget needs to render and persist for rehydration.
 */
export type JobSnapshot = {
  jobId: string
  sessionKey: string
  status: JobStatus
  startedAt: number
  lastEventAt: number
  lastPollAt: number
  summary?: string
  error?: string
  errorInfo?: ErrorInfo
  logs: LogEntry[]
  artifacts: Artifacts
  continuationState?: ContinuationState
}

// ── Artifact extraction ──────────────────────────────────────────────────────

function emptyArtifacts(): Artifacts {
  return { filesChanged: [], commandsRun: [], needsHumanDecision: false }
}

function addChangedFile(artifacts: Artifacts, filePath: string | undefined) {
  if (!filePath) return
  if (artifacts.filesChanged.length >= MAX_ARRAY_ITEMS) return
  if (!artifacts.filesChanged.includes(filePath)) {
    artifacts.filesChanged.push(filePath)
  }
}

function extractChangedFilesFromPatch(input: unknown): string[] {
  if (typeof input !== 'string') return []
  const matches = new Set<string>()

  for (const line of input.split('\n')) {
    let match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (match) {
      matches.add(match[1].trim())
      continue
    }

    match = line.match(/^\+\+\+ b\/(.+)$/)
    if (match) {
      matches.add(match[1].trim())
    }
  }

  return [...matches]
}

function processEvent(artifacts: Artifacts, event: GatewayEvent) {
  if (event.type !== 'tool') return

  const name = event.toolName
  if ((name === 'Bash' || name === 'exec') && artifacts.commandsRun.length < MAX_ARRAY_ITEMS) {
    const cmd = String(event.args.command ?? '').slice(0, 120)
    if (cmd) artifacts.commandsRun.push(cmd)
  }

  const directFilePath = [event.args.file_path, event.args.filePath, event.args.path, event.args.file]
    .find((value) => typeof value === 'string') as string | undefined

  if (name === 'Edit' || name === 'Write' || name === 'edit' || name === 'write') {
    addChangedFile(artifacts, directFilePath)
  }

  if (name === 'ApplyPatch' || name === 'apply_patch') {
    for (const filePath of extractChangedFilesFromPatch(event.args.input)) {
      addChangedFile(artifacts, filePath)
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
  for (const cmd of artifacts.commandsRun) {
    if (!artifacts.branchName) {
      const m = cmd.match(/(?:checkout -b|switch -c)\s+(\S+)/)
      if (m) artifacts.branchName = m[1]
    }
  }
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
const DEFAULT_AGENT_ID = process.env.OPENCLAW_AGENT_ID?.trim() || 'main'
const LEGACY_CHATGPT_SESSION_PREFIX = 'agent:chatgpt:'

function createThreadSessionKey(agentId = DEFAULT_AGENT_ID): string {
  return `agent:${agentId}:main:thread:mcp-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function resolveSessionKey(input?: string): { sessionKey: string; migratedFromLegacy: boolean } {
  if (!input) return { sessionKey: createThreadSessionKey(), migratedFromLegacy: false }
  if (input.startsWith(LEGACY_CHATGPT_SESSION_PREFIX)) {
    return { sessionKey: createThreadSessionKey(), migratedFromLegacy: true }
  }
  return { sessionKey: input, migratedFromLegacy: false }
}

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
const latestJobBySession = new Map<string, string>()

export class OpenClawAdapter {
  submitTask(input: {
    task: string
    context?: string
    sessionKey?: string
  }): Job {
    const message = input.context
      ? `${input.context}\n\n${input.task}`
      : input.task

    const { sessionKey, migratedFromLegacy } = resolveSessionKey(input.sessionKey)
    const jobId = randomUUID()
    const artifacts = emptyArtifacts()
    const now = Date.now()
    const logs: LogEntry[] = []

    if (!input.sessionKey) {
      logs.push({ ts: now, type: 'lifecycle', text: `Started new Clawdy thread session: ${sessionKey}` })
    } else if (migratedFromLegacy) {
      logs.push({ ts: now, type: 'lifecycle', text: `Migrated legacy ChatGPT session to new Clawdy thread: ${sessionKey}` })
    }

    const job: Job = { jobId, sessionKey, status: 'running', startedAt: now, lastEventAt: logs.length > 0 ? now : 0, logs, artifacts }
    jobs.set(jobId, job)
    latestJobBySession.set(sessionKey, jobId)
    sessions.set(sessionKey, {
      sessionKey,
      lastJobId: jobId,
      lastSummary: '',
      artifacts,
    })

    gateway.chat(sessionKey, message, TIMEOUT_MS, (event) => {
      job.lastEventAt = Date.now()
      if (job.logs.length < MAX_LOG_ENTRIES) {
        job.logs.push({ ts: Date.now(), type: event.type, text: event.text })
      }
      console.log(`[job ${jobId.slice(0, 8)}] event #${job.logs.length}: ${event.type} - ${event.text.slice(0, 80)}`)
      processEvent(artifacts, event)
    }).then(
      (reply) => {
        job.lastEventAt = Date.now()
        const noSummary = !reply || reply === 'Stream finished with no response collected.'
        job.status = noSummary ? 'completed_no_summary' : 'completed'
        job.summary = reply
        extractPatternsFromSummary(artifacts, reply)
        sessions.set(sessionKey, {
          sessionKey,
          lastJobId: jobId,
          lastSummary: reply.slice(0, 500),
          artifacts,
          recommendedNextStep: deriveNextStep(artifacts, job.status),
        })
        console.log(`[job ${jobId}] ${job.status}, ${reply.length} chars, ${artifacts.filesChanged.length} files`)
      },
      (err) => {
        job.lastEventAt = Date.now()
        job.status = 'error'
        job.error = err instanceof Error ? err.message : String(err)
        job.errorInfo = classifyError(job.error)
        sessions.set(sessionKey, {
          sessionKey,
          lastJobId: jobId,
          lastSummary: job.error,
          artifacts,
          recommendedNextStep: deriveNextStep(artifacts, 'error'),
        })
        console.log(`[job ${jobId}] error (${job.errorInfo.category}): ${job.error}`)
      },
    )

    return job
  }

  /** Build a snapshot suitable for the widget to persist and restore from. */
  buildSnapshot(job: Job): JobSnapshot {
    const continuation = sessions.get(job.sessionKey)
    return {
      jobId: job.jobId,
      sessionKey: job.sessionKey,
      status: job.status,
      startedAt: job.startedAt,
      lastEventAt: job.lastEventAt,
      lastPollAt: Date.now(),
      summary: job.summary,
      error: job.error,
      errorInfo: job.errorInfo,
      logs: job.logs,
      artifacts: job.artifacts,
      ...(continuation ? { continuationState: continuation } : {}),
    }
  }

  getJob(jobId: string): Job | undefined {
    return jobs.get(jobId)
  }

  getLatestJobForSession(sessionKey: string): Job | undefined {
    const latestJobId = latestJobBySession.get(sessionKey) ?? sessions.get(sessionKey)?.lastJobId
    return latestJobId ? jobs.get(latestJobId) : undefined
  }

  getSessionState(sessionKey: string): ContinuationState | undefined {
    return sessions.get(sessionKey)
  }

  resolveJob(jobId?: string, sessionKey?: string): Job | undefined {
    if (jobId) {
      const job = jobs.get(jobId)
      if (job) return job
    }

    if (sessionKey) {
      return this.getLatestJobForSession(sessionKey)
    }

    return undefined
  }

  async waitForJob(jobId: string | undefined, knownLogCount = 0, sessionKey?: string): Promise<Job | undefined> {
    const job = this.resolveJob(jobId, sessionKey)
    if (!job) { console.log(`[waitForJob] no job found (jobId=${jobId?.slice(0, 8)}, session=${sessionKey?.slice(-8)})`); return undefined }
    if (job.status !== 'running') { console.log(`[waitForJob] job ${job.jobId.slice(0, 8)} already ${job.status}, logs=${job.logs.length}`); return job }
    console.log(`[waitForJob] job ${job.jobId.slice(0, 8)} waiting (known=${knownLogCount}, current=${job.logs.length})`)
    const deadline = Date.now() + POLL_WAIT_MS
    while (Date.now() < deadline && job.status === 'running') {
      await new Promise(r => setTimeout(r, 500))
      if (job.logs.length > knownLogCount) {
        console.log(`[waitForJob] job ${job.jobId.slice(0, 8)} has new logs (${job.logs.length} > ${knownLogCount})`)
        return job
      }
    }
    console.log(`[waitForJob] job ${job.jobId.slice(0, 8)} poll timeout (logs=${job.logs.length}, status=${job.status})`)
    return job
  }
}
