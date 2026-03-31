import 'dotenv/config'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { OpenClawAdapter } from './openclaw/adapter.js'

const hono = new Hono()
const openclaw = new OpenClawAdapter()

function createMcpServer() {
  const server = new McpServer({
    name: 'openclaw-app',
    version: '0.0.1',
  })

  server.tool(
    'run_openclaw_task',
    'Send a task to OpenClaw and return a structured result',
    {
      task: z.string(),
      context: z.string().optional(),
      workspace: z.string().optional(),
    },
    async ({ task, context, workspace }) => {
      const result = await openclaw.runTask({ task, context, workspace })
      return {
        structuredContent: result,
        content: [{ type: 'text', text: result.summary }],
      }
    }
  )

  return server
}

hono.get('/', (c) => c.text('OK'))
hono.get('/health', (c) => c.json({ ok: true }))

const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/mcp')) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    const mcpServer = createMcpServer()
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res)
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

const port = Number(process.env.PORT || 3000)
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
