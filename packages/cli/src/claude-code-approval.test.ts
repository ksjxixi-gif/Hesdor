import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '@hesdor/agent-core'
import { approvalRequest, startApprovalServer } from './claude-code-approval.js'

const root = path.resolve('/repo')

describe('claude-code approvals', () => {
  it("asks Hesdor's user for each Claude Code permission prompt over MCP", async () => {
    const asked: ApprovalRequest[] = []
    const answers = [true, false]
    const server = await startApprovalServer(async (req) => (asked.push(req), answers.shift()!), root)
    try {
      const { url, headers } = JSON.parse(server.mcpConfig).mcpServers.hesdor as { url: string; headers: Record<string, string> }
      const rpc = async (body: object, h = headers) => {
        const res = await fetch(url, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) })
        return { status: res.status, json: (res.status === 200 ? await res.json() : undefined) as any }
      }
      expect((await rpc({ id: 1, method: 'tools/list' }, {})).status).toBe(401)
      expect((await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json.result.capabilities).toEqual({ tools: {} })
      expect((await rpc({ method: 'notifications/initialized' })).status).toBe(202)
      expect((await rpc({ id: 2, method: 'tools/list' })).json.result.tools.map((t: { name: string }) => t.name)).toEqual(['approve'])

      const call = async (id: number) =>
        JSON.parse((await rpc({ id, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } } })).json.result.content[0].text)
      expect(await call(3)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
      expect(await call(4)).toMatchObject({ behavior: 'deny' })
      expect(asked).toEqual([
        { title: 'Claude Code: Bash npm test', detail: 'npm test' },
        { title: 'Claude Code: Bash npm test', detail: 'npm test' },
      ])
    } finally {
      server.close()
    }
  })

  it('shows a file edit by its path, with the input as detail', () => {
    const req = approvalRequest('Write', { file_path: path.join(root, 'a.ts'), content: 'x' }, root)
    expect(req.title).toBe('Claude Code: Write a.ts')
    expect(JSON.parse(req.detail!)).toEqual({ file_path: path.join(root, 'a.ts'), content: 'x' })
    expect(req.source).toBeUndefined()
  })
})
