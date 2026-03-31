import { randomUUID } from 'node:crypto'
import { OpenClawGateway } from './gateway.js'

const TIMEOUT_MS = 600_000 // 10 minutes
const POLL_WAIT_MS = 50_000 // max time check_openclaw_task waits before returning

export type JobStatus = 'running' | 'completed' | 'error'

export type Job = {
  jobId: string
  sessionKey: string
  status: JobStatus
  summary?: string
  error?: string
  startedAt: number
}

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
    const job: Job = { jobId, sessionKey, status: 'running', startedAt: Date.now() }
    jobs.set(jobId, job)

    gateway.chat(sessionKey, message, TIMEOUT_MS).then(
      (reply) => {
        job.status = 'completed'
        job.summary = reply
        console.log(`[job ${jobId}] completed, ${reply.length} chars`)
      },
      (err) => {
        job.status = 'error'
        job.error = err instanceof Error ? err.message : String(err)
        console.log(`[job ${jobId}] error: ${job.error}`)
      },
    )

    return job
  }

  getJob(jobId: string): Job | undefined {
    return jobs.get(jobId)
  }

  /** Server-side long poll: waits up to POLL_WAIT_MS for the job to finish. */
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
