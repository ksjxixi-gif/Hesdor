import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApprovalRequest } from '@hesdor/agent-core'
import { toolSummary } from './claude-code.js'

/** The tool Claude Code calls (`--permission-prompt-tool`) when its own rules don't settle an action. */
export const APPROVAL_TOOL = 'mcp__hesdor__approve'

/** What Hesdor's approval prompt shows for one of Claude Code's permission requests. */
export function approvalRequest(toolName: string, input: Record<string, unknown>, root: string): ApprovalRequest {
  const detail = typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)
  // No `source`: the human answers, never an auto-reviewer (Hesdor's guardian does not apply to Claude Code).
  return { title: `Claude Code: ${toolSummary(toolName, input, root)}`, detail: detail.length > 2000 ? `${detail.slice(0, 1999)}…` : detail }
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> }

/**
 * A one-turn MCP server (streamable HTTP, JSON responses only) on 127.0.0.1 with one tool, `approve`, that asks
 * Hesdor's user. A random bearer token keeps other local processes out; they could only trigger a prompt anyway.
 */
export async function startApprovalServer(ask: (req: ApprovalRequest) => Promise<boolean>, root: string) {
  const token = randomBytes(24).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return void res.writeHead(401).end()
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end()
    let body = ''
    req.on('data', (d: Buffer) => {
      body += d.toString()
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let msg: Rpc
      try {
        msg = JSON.parse(body) as Rpc
      } catch {
        return void res.writeHead(400).end()
      }
      if (msg.id === undefined || msg.id === null) return void res.writeHead(202).end() // a notification
      const reply = (r: { result: unknown } | { error: { code: number; message: string } }): void =>
        void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...r }))
      const p = msg.params ?? {}
      switch (msg.method) {
        case 'initialize':
          return reply({ result: { protocolVersion: p.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hesdor', version: '1' } } })
        case 'ping':
          return reply({ result: {} })
        case 'tools/list':
          return reply({
            result: {
              tools: [
                {
                  name: 'approve',
                  description: "Asks the Hesdor user to allow or deny one of Claude Code's actions.",
                  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
                },
              ],
            },
          })
        case 'tools/call': {
          if (p.name !== 'approve') return reply({ error: { code: -32602, message: `unknown tool ${String(p.name)}` } })
          const a = (p.arguments ?? {}) as { tool_name?: unknown; input?: unknown }
          const input = a.input && typeof a.input === 'object' ? (a.input as Record<string, unknown>) : {}
          const allowed = await ask(approvalRequest(typeof a.tool_name === 'string' ? a.tool_name : 'tool', input, root)).catch(() => false)
          const decision = allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this in Hesdor.' }
          return reply({ result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } })
        }
        default:
          return reply({ error: { code: -32601, message: `method not found: ${String(msg.method)}` } })
      }
    })
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    /** `--mcp-config` value: Hesdor's approval server only, alongside the user's own MCP servers. */
    mcpConfig: JSON.stringify({ mcpServers: { hesdor: { type: 'http', url: `http://127.0.0.1:${port}/`, headers: { Authorization: `Bearer ${token}` } } } }),
    close: (): void => {
      server.closeAllConnections()
      server.close()
    },
  }
}
