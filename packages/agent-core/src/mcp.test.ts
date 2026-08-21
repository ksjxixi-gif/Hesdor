import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpClient, registerMcpServers } from './index.js'
import type { ToolContext } from './context.js'
import type { ToolRegistry } from './registry.js'
import { createDefaultRegistry } from './registry.js'

// A minimal MCP stdio server for tests: initialize + tools/list + tools/call.
const FAKE_SERVER = `
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    reply(msg)
  }
})
function reply(msg) {
  if (msg.method === 'initialize') {
    send(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } })
    return
  }
  if (msg.method === 'ping') { send(msg.id, {}); return }
  if (msg.method === 'tools/list') {
    send(msg.id, { tools: [
      { name: 'echo', description: 'Echo the given text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ] })
    return
  }
  if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? ''
    send(msg.id, { content: [{ type: 'text', text: 'echo:' + text }] })
    return
  }
}
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`

const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-mcp-'))
const serverScript = path.join(dir, 'fake-mcp-server.mjs')
writeFileSync(serverScript, FAKE_SERVER)

describe('McpClient over stdio', () => {
  it('handshakes, lists tools and calls them', async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [serverScript] })
    try {
      expect(client.serverInfo.name).toBe('fake')

      const tools = await client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('echo')

      const result = await client.callTool('echo', { text: 'hello' })
      expect(result.isError).toBe(false)
      expect(result.text).toBe('echo:hello')
    } finally {
      client.close()
    }
  })

  it('fails fast when a server command does not exist', async () => {
    await expect(McpClient.connect({ command: 'definitely-not-a-real-command-xyz' })).rejects.toThrow(
      /failed to start|timed out/i,
    )
  })
})

describe('registerMcpServers', () => {
  it('namespaces MCP tools into the registry with NETWORK risk', async () => {
    const registry: ToolRegistry = createDefaultRegistry()
    const warnings: string[] = []
    const servers = await registerMcpServers(
      registry,
      { demo: { command: process.execPath, args: [serverScript] } },
      (m) => warnings.push(m),
    )

    try {
      expect(servers).toHaveLength(1)
      expect(warnings).toHaveLength(0)

      const tool = registry.get('mcp_demo_echo')
      expect(tool).toBeDefined()
      expect(tool!.risk).toBe('NETWORK')
      expect(tool!.description).toContain('[mcp:demo]')
      // JSON Schema passes through untouched.
      expect(registry.specs().find((s) => s.name === 'mcp_demo_echo')?.parametersJsonSchema).toHaveProperty('properties')

      const out = (await tool!.execute({ text: 'x' }, brokenCtx())) as { text: string }
      expect(out.text).toBe('echo:x')
    } finally {
      for (const server of servers) server.client.close()
    }
  })

  it('warns instead of throwing when a server cannot start', async () => {
    const registry = createDefaultRegistry()
    const warnings: string[] = []
    const servers = await registerMcpServers(
      registry,
      { bad: { command: 'definitely-not-a-real-command-xyz' } },
      (m) => warnings.push(m),
    )
    expect(servers).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(registry.list().some((t) => t.name.startsWith('mcp_'))).toBe(false)
  })
})

function brokenCtx(): ToolContext {
  return {
    root: process.cwd(),
    mode: 'build',
    model: 'test',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(true),
    approvalsEnabled: true,
    state: { activeChild: null, snapshots: [] },
  }
}
