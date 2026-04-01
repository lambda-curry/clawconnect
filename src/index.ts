import 'dotenv/config'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { OpenClawAdapter } from './openclaw/adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WIDGET_HTML = readFileSync(join(__dirname, 'widget.html'), 'utf-8')

const hono = new Hono()
const openclaw = new OpenClawAdapter()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

const WIDGET_URI = 'ui://widget/openclaw-status.html'

const TOOLS = [
  {
    name: 'run_openclaw_task',
    description: 'Submit a task to OpenClaw. New tasks start in a fresh Clawdy thread session on the configured agent. Returns quickly with a jobId and sessionKey so the widget can poll check_openclaw_task for live progress. Pass sessionKey from a previous result to continue the same thread.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to perform' },
        context: { type: 'string', description: 'Optional context for the task' },
        sessionKey: { type: 'string', description: 'Session key from a previous call to continue the same Clawdy thread. Omit to start a new thread.' },
      },
      required: ['task'],
    },
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      'ui/resourceUri': WIDGET_URI,
      'openai/toolInvocation/invoking': 'Sending task to Clawdy...',
    },
  },
  {
    name: 'check_openclaw_task',
    description: 'Check the status of a previously submitted task. Waits up to 50 seconds for completion before returning. Poll until status is "completed", "completed_no_summary", or "error".',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId returned by run_openclaw_task' },
        sessionKey: { type: 'string', description: 'Optional session key for reattaching status checks after refresh or stale local state.' },
        knownLogCount: { type: 'number', description: 'Number of log entries already seen. Server returns as soon as new entries appear.' },
      },
      required: ['jobId'],
    },
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ['app'] },
      'ui/resourceUri': WIDGET_URI,
    },
  },
]

hono.get('/', (c) => c.text('OK'))
hono.get('/health', (c) => c.json({ ok: true }))

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/mcp')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))

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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'openclaw-app', version: '0.0.1' },
      })
    } else if (isNotification) {
      res.writeHead(202)
      res.end()
    } else if (msg.method === 'tools/list') {
      respond({ tools: TOOLS })

    } else if (msg.method === 'resources/list') {
      respond({
        resources: [{
          uri: WIDGET_URI,
          name: 'OpenClaw Status Widget',
          mimeType: 'text/html;profile=mcp-app',
        }],
      })
    } else if (msg.method === 'resources/read') {
      const uri = (msg.params as { uri?: string })?.uri
      if (uri === WIDGET_URI) {
        respond({
          contents: [{
            uri: WIDGET_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: WIDGET_HTML,
            _meta: {
              ui: {
                borders: 'square',
                domains: ['*'],
              },
            },
          }],
        })
      } else {
        respondError(-32602, `Unknown resource: ${uri}`)
      }

    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, string> }

      if (name === 'run_openclaw_task') {
        const job = openclaw.submitTask({
          task: args.task,
          context: args.context,
          sessionKey: args.sessionKey,
        })
        console.log(`[mcp] submitted job ${job.jobId} on session ${job.sessionKey}`)
        const snapshot = openclaw.buildSnapshot(job)
        respond({
          content: [{ type: 'text', text: `Task submitted. Job ID: ${job.jobId}` }],
          structuredContent: snapshot,
        })

      } else if (name === 'check_openclaw_task') {
        const knownLogCount = Number(args.knownLogCount) || 0
        const requestedJobId = typeof args.jobId === 'string' ? args.jobId : undefined
        const requestedSessionKey = typeof args.sessionKey === 'string' ? args.sessionKey : undefined
        const job = await openclaw.waitForJob(requestedJobId, knownLogCount, requestedSessionKey)
        if (!job) {
          const notFoundMsg = requestedSessionKey
            ? 'Task state not found for that session. The server may have restarted.'
            : 'Job not found. The server may have restarted.'
          respond({
            content: [{ type: 'text', text: notFoundMsg }],
            structuredContent: {
              jobId: requestedJobId,
              sessionKey: requestedSessionKey,
              status: 'error',
              error: notFoundMsg,
            },
            isError: true,
          })
        } else {
          const snapshot = openclaw.buildSnapshot(job)
          const isTerminal = job.status !== 'running'
          respond({
            content: [{ type: 'text', text: isTerminal ? (job.summary ?? job.error ?? '') : `Still running. Poll again.` }],
            structuredContent: snapshot,
            ...(job.status === 'error' ? { isError: true } : {}),
          })
        }

      } else {
        respondError(-32601, `Unknown tool: ${name}`)
      }
    } else {
      respondError(-32601, `Method not found: ${msg.method}`)
    }

    console.log(`[mcp] -> ${res.statusCode}`)
    return
  }

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
