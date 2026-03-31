import { randomUUID } from 'node:crypto'
import { OpenClawGateway } from './gateway.js'

const TIMEOUT_MS = 600_000 // 10 minutes

export type OpenClawResult = {
  success: boolean
  summary: string
  sessionKey: string
  steps: string[]
  warnings?: string[]
  artifacts?: string[]
  raw?: unknown
}

const gateway = new OpenClawGateway(
  process.env.OPENCLAW_URL!,
  process.env.OPENCLAW_PASSWORD!,
)

export class OpenClawAdapter {
  async runTask(input: {
    task: string
    context?: string
    workspace?: string
    sessionKey?: string
  }): Promise<OpenClawResult> {
    const message = input.context
      ? `${input.context}\n\n${input.task}`
      : input.task

    const sessionKey = input.sessionKey ?? `agent:chatgpt:${randomUUID()}`
    const reply = await gateway.chat(sessionKey, message, TIMEOUT_MS)

    return {
      success: true,
      summary: reply,
      sessionKey,
      steps: [],
      warnings: [],
      artifacts: [],
    }
  }
}
