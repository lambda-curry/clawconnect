import 'dotenv/config'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { OpenClawAdapter } from './openclaw/adapter.js'

const hono = new Hono()
const openclaw = new OpenClawAdapter()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

const TOOLS = [
  {
    name: 'run_openclaw_task',
    description: 'Submit a task to OpenClaw. Returns a jobId immediately. Use check_openclaw_task to poll for the result. The response also includes a sessionKey — pass it back in follow-up calls to continue the same conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to perform' },
        context: { type: 'string', description: 'Optional context for the task' },
        workspace: { type: 'string' },
        sessionKey: { type: 'string', description: 'Session key from a previous call to continue the conversation. Omit to start fresh.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'check_openclaw_task',
    description: 'Check the status of a previously submitted task. Returns the result if complete, or current status if still running. You MUST poll this after calling run_openclaw_task until status is "completed" or "error".',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId returned by run_openclaw_task' },
      },
      required: ['jobId'],
    },
  },
]

hono.get('/', (c) => c.text('OK'))
hono.get('/health', (c) => c.json({ ok: true }))

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/mcp')) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))

    // Parse body
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString()

    let msg: { jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    const isNotification = msg.id === undefined

    const respond = (result: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
    }

    const respondError = (code: number, message: string, httpStatus = 200) => {
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } }))
    }

    console.log(`[mcp] ${req.method} ${msg.method}`)

    if (msg.method === 'initialize') {
      respond({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'openclaw-app', version: '0.0.1' },
      })
    } else if (isNotification) {
      res.writeHead(202)
      res.end()
    } else if (msg.method === 'tools/list') {
      respond({ tools: TOOLS })
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, string> }

      if (name === 'run_openclaw_task') {
        const job = openclaw.submitTask({
          task: args.task,
          context: args.context,
          workspace: args.workspace,
          sessionKey: args.sessionKey,
        })
        console.log(`[mcp] submitted job ${job.jobId} on session ${job.sessionKey}`)
        respond({
          content: [{ type: 'text', text: `Task submitted. Poll with check_openclaw_task using jobId: ${job.jobId}` }],
          structuredContent: { jobId: job.jobId, sessionKey: job.sessionKey, status: 'running' },
        })
      } else if (name === 'check_openclaw_task') {
        const job = openclaw.getJob(args.jobId)
        if (!job) {
          respond({
            content: [{ type: 'text', text: `Unknown jobId: ${args.jobId}` }],
            isError: true,
          })
        } else if (job.status === 'running') {
          const elapsed = Math.round((Date.now() - job.startedAt) / 1000)
          respond({
            content: [{ type: 'text', text: `Still running (${elapsed}s elapsed). Poll again shortly.` }],
            structuredContent: { jobId: job.jobId, sessionKey: job.sessionKey, status: 'running', elapsedSeconds: elapsed },
          })
        } else if (job.status === 'completed') {
          respond({
            content: [{ type: 'text', text: job.summary ?? '' }],
            structuredContent: { jobId: job.jobId, sessionKey: job.sessionKey, status: 'completed', summary: job.summary },
          })
        } else {
          respond({
            content: [{ type: 'text', text: `Task failed: ${job.error}` }],
            structuredContent: { jobId: job.jobId, sessionKey: job.sessionKey, status: 'error', error: job.error },
            isError: true,
          })
        }
      } else {
        respondError(-32601, `Unknown tool: ${name}`)
      }
    } else {
      respondError(-32601, `Method not found: ${msg.method}`)
    }

    console.log(`[mcp] → ${res.statusCode}`)
    return
  }

  // Route everything else through Hono
  const url = `http://${req.headers.host ?? 'localhost'}${req.url}`
  const webReq = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
  const webRes = await hono.fetch(webReq)

  res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()))
  const buf = await webRes.arrayBuffer()
  res.end(Buffer.from(buf))
})

const port = Number(process.env.PORT || 7331)
server.timeout = 0
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
