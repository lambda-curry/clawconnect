import 'dotenv/config'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { OpenClawAdapter } from './openclaw/adapter.js'

const hono = new Hono()
const openclaw = new OpenClawAdapter()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

function createMcpServer(): McpServer {
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
      const result = await openclaw.runTask({ task, context, workspace })
      return {
        structuredContent: result,
        content: [{ type: 'text', text: result.summary }],
      }
    }
  )

  // Remove non-standard `execution` field — ChatGPT's MCP client crashes parsing it
  delete (mcpServer as any)._registeredTools['run_openclaw_task'].execution

  return mcpServer
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

    // Add CORS headers to all MCP responses
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))

    console.log(`[mcp] ${req.method} session=${req.headers['mcp-session-id'] ?? 'none'}`)

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    const mcpServer = createMcpServer()
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res)

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
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
