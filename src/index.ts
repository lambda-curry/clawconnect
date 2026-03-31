import 'dotenv/config'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { OpenClawAdapter } from './openclaw/adapter.js'

const hono = new Hono()
const openclaw = new OpenClawAdapter()

interface Session {
  mcpServer: McpServer
  transport: StreamableHTTPServerTransport
  openClawSessionKey: string
}

const sessions = new Map<string, Session>()

function createSession(): Session {
  const sessionId = randomUUID()
  const openClawSessionKey = `agent:main:chatgpt-${sessionId}`

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
  })

  const mcpServer = new McpServer({ name: 'openclaw-app', version: '0.0.1' })

  mcpServer.tool(
    'run_openclaw_task',
    'Send a task to OpenClaw and return a structured result',
    {
      task: z.string(),
      context: z.string().optional(),
      workspace: z.string().optional(),
    },
    async ({ task, context, workspace }) => {
      const result = await openclaw.runTask({ task, context, workspace, sessionKey: openClawSessionKey })
      return {
        structuredContent: result,
        content: [{ type: 'text', text: result.summary }],
      }
    }
  )

  // Remove non-standard `execution` field — older MCP clients (including ChatGPT)
  // don't recognise it and crash parsing tools/list.
  delete (mcpServer as any)._registeredTools['run_openclaw_task'].execution

  void mcpServer.connect(transport)

  const session: Session = { mcpServer, transport, openClawSessionKey }
  sessions.set(sessionId, session)
  return session
}

hono.get('/', (c) => c.text('OK'))
hono.get('/health', (c) => c.json({ ok: true }))

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/mcp')) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const sessionFound = !!(sessionId && sessions.get(sessionId))
    const session = (sessionId && sessions.get(sessionId)) ?? createSession()
    console.log(`[mcp] ${req.method} session=${sessionId ?? 'none'} found=${sessionFound} → ${session.openClawSessionKey}`)
    await session.transport.handleRequest(req, res)
    console.log(`[mcp] response status=${res.statusCode}`)
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
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
