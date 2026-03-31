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

const TOOL_DEFINITION = {
  name: 'run_openclaw_task',
  description: 'Send a task to OpenClaw and return a structured result. The response includes a sessionKey — pass it back in follow-up calls to continue the same session.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      context: { type: 'string' },
      workspace: { type: 'string' },
      sessionKey: { type: 'string', description: 'Session key returned from a previous call. Omit to start a new session.' },
    },
    required: ['task'],
  },
}

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

    // Disable socket timeout for long-running tasks
    req.socket.setTimeout(0)
    req.socket.setKeepAlive(true)
    res.once('close', () => {
      if (!res.writableEnded) console.log('[mcp] connection closed by client before response was sent')
    })

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
      // notifications/initialized and other notifications — just acknowledge
      res.writeHead(202)
      res.end()
    } else if (msg.method === 'tools/list') {
      respond({ tools: [TOOL_DEFINITION] })
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params as { name: string; arguments: Record<string, string> }
      if (name !== 'run_openclaw_task') {
        respondError(-32601, `Unknown tool: ${name}`)
        return
      }
      try {
        const result = await openclaw.runTask({
          task: args.task,
          context: args.context,
          workspace: args.workspace,
        })
        respond({
          content: [{ type: 'text', text: result.summary }],
          structuredContent: result,
        })
      } catch (err) {
        respond({
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        })
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
