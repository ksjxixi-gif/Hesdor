import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpClient, contentToText, expandEnvVars, readMcpConfigFiles, registerMcpServers } from './index.js'
import type { ToolContext } from './context.js'
import type { ToolRegistry } from './registry.js'
import { createDefaultRegistry } from './registry.js'

// A 2025-era MCP stdio server for tests: initialize, paginated tools/list, tools/call, list_changed.
const FAKE_SERVER = `
const exitOnUnknown = process.env.FAKE_EXIT_ON_UNKNOWN === '1'
const initDelay = Number(process.env.FAKE_INIT_DELAY || 0)
let tools = [
  { name: 'zeta', description: 'Last by name', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo', description: 'Echo the given text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]
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
  if (process.env.FAKE_LOG && msg.method) require('node:fs').appendFileSync(process.env.FAKE_LOG, msg.method + '\\n')
  if (msg.method === 'initialize') {
    setTimeout(() => send(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1.0.0' } }), initDelay)
    return
  }
  if (msg.method === 'ping') { send(msg.id, {}); return }
  if (msg.method === 'tools/list') {
    // Two pages: the client must follow nextCursor.
    if (msg.params?.cursor === 'page2') send(msg.id, { tools: tools.slice(1) })
    else send(msg.id, { tools: tools.slice(0, 1), nextCursor: 'page2' })
    return
  }
  // Replies to our own server-to-client requests: report what came back.
  if (!msg.method && typeof msg.id === 'string' && msg.id.startsWith('srv-')) {
    const outcome = msg.error ? 'error:' + msg.error.code : 'result'
    send(pendingCall, { content: [{ type: 'text', text: msg.id + ':' + outcome }] })
    return
  }
  if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? ''
    if (text === 'ping-me' || text === 'roots-me') {
      pendingCall = msg.id
      const method = text === 'ping-me' ? 'ping' : 'roots/list'
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-' + method, method }) + '\\n')
      return
    }
    if (text === 'die') { process.stderr.write('fatal: fake crash\\n'); process.exit(3) }
    if (text === 'change') {
      tools = [...tools, { name: 'added', description: 'New tool', inputSchema: { type: 'object', properties: {} } }]
      send(msg.id, { content: [{ type: 'text', text: 'changed' }] })
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n')
      return
    }
    if (text === 'rich') {
      send(msg.id, {
        content: [
          { type: 'text', text: 'summary' },
          { type: 'image', mimeType: 'image/png', data: 'AAAAAAAA' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline body' } },
        ],
        structuredContent: { ok: true },
      })
      return
    }
    send(msg.id, { content: [{ type: 'text', text: 'echo:' + text }] })
    return
  }
  if (msg.id !== undefined && msg.method) {
    if (exitOnUnknown) process.exit(1) // like servers on SDKs that die on any pre-initialize request
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
  }
}
let pendingCall
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`

const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-mcp-'))
const serverScript = path.join(dir, 'fake-mcp-server.cjs')
writeFileSync(serverScript, FAKE_SERVER)
const fake = (env?: Record<string, string>) => ({ command: process.execPath, args: [serverScript], ...(env ? { env } : {}) })

describe('McpClient over stdio', () => {
  it('handshakes, lists every page of tools in name order and calls them', async () => {
    const client = await McpClient.connect(fake())
    try {
      expect(client.serverInfo.name).toBe('fake')
      expect((await client.listTools()).map((t) => t.name)).toEqual(['echo', 'zeta'])

      const result = await client.callTool('echo', { text: 'hello' })
      expect(result.isError).toBe(false)
      expect(result.text).toBe('echo:hello')
    } finally {
      client.close()
    }
  })

  it('answers server requests with the id the server sent', async () => {
    const client = await McpClient.connect(fake())
    try {
      expect((await client.callTool('echo', { text: 'ping-me' })).text).toBe('srv-ping:result')
      expect((await client.callTool('echo', { text: 'roots-me' })).text).toBe('srv-roots/list:error:-32601')
    } finally {
      client.close()
    }
  })

  it('keeps images, resources and structured content as text', async () => {
    const client = await McpClient.connect(fake())
    try {
      const { text } = await client.callTool('echo', { text: 'rich' })
      expect(text).toBe('summary\n[image image/png, 6 bytes not shown]\n[resource file:///a.txt]\ninline body\n{"ok":true}')
    } finally {
      client.close()
    }
  })

  it('falls back to the 2025 handshake when the server exits on the version probe', async () => {
    const log = path.join(dir, 'probe.log')
    const client = await McpClient.connect(fake({ FAKE_EXIT_ON_UNKNOWN: '1', FAKE_LOG: log }))
    try {
      expect((await client.callTool('echo', { text: 'x' })).text).toBe('echo:x')
      // First process died on the probe; the second got the plain 2025 handshake.
      expect(readFileSync(log, 'utf8').split('\n').slice(0, 2)).toEqual(['server/discover', 'initialize'])
    } finally {
      client.close()
    }
  })

  it('detects a dead server, fails that call, and reconnects on the next one', async () => {
    const client = await McpClient.connect(fake())
    try {
      await expect(client.callTool('echo', { text: 'die' })).rejects.toThrow()
      await expect.poll(() => client.alive).toBe(false)
      expect((await client.callTool('echo', { text: 'back' })).text).toBe('echo:back')
      expect(client.alive).toBe(true)
    } finally {
      client.close()
    }
  })

  it('fails fast when a server command does not exist', async () => {
    await expect(McpClient.connect({ command: 'definitely-not-a-real-command-xyz' })).rejects.toThrow(
      /failed to start|ENOENT|not recognized/i,
    )
  })

  it.runIf(process.platform === 'win32')('refuses cmd.exe metacharacters in a .cmd server config', async () => {
    await expect(McpClient.connect({ command: 'server.cmd', args: ['x & calc'] })).rejects.toThrow(/refusing to run through cmd.exe/)
  })

  it('includes the stderr tail when a server dies during startup', async () => {
    const config = { command: process.execPath, args: ['-e', 'console.error("bad token for server"); process.exit(1)'] }
    await expect(McpClient.connect(config)).rejects.toThrow(/bad token for server/)
  })
})

describe('McpClient over Streamable HTTP', () => {
  it('sends configured headers and calls tools', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      if (req.method !== 'POST') return void res.writeHead(405).end()
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        seen.push(String(req.headers.authorization))
        const msg = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { text?: string } } }
        if (msg.id === undefined) return void res.writeHead(202).end()
        const json = (payload: object) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }))
        if (msg.method === 'initialize') {
          return json({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fake', version: '1' } } })
        }
        if (msg.method === 'tools/list') return json({ result: { tools: [{ name: 'hi', inputSchema: { type: 'object' } }] } })
        if (msg.method === 'tools/call') return json({ result: { content: [{ type: 'text', text: `hi ${msg.params?.arguments?.text}` }] } })
        json({ error: { code: -32601, message: 'Method not found' } })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    const client = await McpClient.connect({ url, headers: { Authorization: 'Bearer t0k' } })
    try {
      expect(client.serverInfo.name).toBe('http-fake')
      expect((await client.listTools()).map((t) => t.name)).toEqual(['hi'])
      expect((await client.callTool('hi', { text: 'there' })).text).toBe('hi there')
      expect(seen.every((h) => h === 'Bearer t0k')).toBe(true)
    } finally {
      client.close()
      server.close()
    }
  })
})

describe('registerMcpServers', () => {
  it('namespaces MCP tools into the registry with NETWORK risk', async () => {
    const registry: ToolRegistry = createDefaultRegistry()
    const warnings: string[] = []
    const servers = await registerMcpServers(registry, { demo: fake() }, (m) => warnings.push(m))

    try {
      expect(servers).toHaveLength(1)
      expect(warnings).toHaveLength(0)
      expect(servers[0]!.tools).toEqual(['mcp_demo_echo', 'mcp_demo_zeta'])

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

  it('registers tools announced by tools/list_changed', async () => {
    const registry = createDefaultRegistry()
    const servers = await registerMcpServers(registry, { demo: fake() })
    try {
      await registry.get('mcp_demo_echo')!.execute({ text: 'change' }, brokenCtx())
      await expect.poll(() => registry.get('mcp_demo_added') !== undefined).toBe(true)
    } finally {
      for (const server of servers) server.client.close()
    }
  })

  it('starts servers in parallel', async () => {
    const registry = createDefaultRegistry()
    const started = Date.now()
    const servers = await registerMcpServers(registry, {
      a: fake({ FAKE_INIT_DELAY: '1500' }),
      b: fake({ FAKE_INIT_DELAY: '1500' }),
    })
    try {
      expect(servers.map((s) => s.name)).toEqual(['a', 'b'])
      expect(Date.now() - started).toBeLessThan(2900)
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

describe('contentToText', () => {
  it('survives a null result and skips structuredContent already present as text', () => {
    expect(contentToText(null)).toBe('')
    expect(contentToText({ content: [{ type: 'text', text: '{ "a": 1 }' }], structuredContent: { a: 1 } })).toBe('{ "a": 1 }')
    expect(contentToText({ content: [{ type: 'resource_link', name: 'r', uri: 'x://y' }] })).toBe('[resource link: r x://y]')
  })
})

describe('MCP config files', () => {
  it('merges mcp.json and .mcp.json, expands ${VAR}, and drops disabled or invalid servers', async () => {
    const cfg = mkdtempSync(path.join(tmpdir(), 'hesdor-mcpcfg-'))
    const global = path.join(cfg, 'mcp.json')
    const project = path.join(cfg, '.mcp.json')
    writeFileSync(global, JSON.stringify({ mcp: { old: { command: 'x' }, keep: { command: 'k', args: ['${HESDOR_TEST_ARG}'] } } }))
    writeFileSync(
      project,
      JSON.stringify({
        mcpServers: {
          old: { command: 'x', disabled: true },
          web: { type: 'http', url: 'https://example.test/${HESDOR_TEST_PATH:-mcp}', headers: { Authorization: 'Bearer ${HESDOR_TEST_TOKEN}' } },
          broken: { args: ['no command'] },
        },
      }),
    )
    process.env.HESDOR_TEST_ARG = 'expanded'
    process.env.HESDOR_TEST_TOKEN = 'secret'
    try {
      const servers = await readMcpConfigFiles([global, project, path.join(cfg, 'missing.json')])
      expect(Object.keys(servers).sort()).toEqual(['keep', 'web'])
      expect(servers.keep!.args).toEqual(['expanded'])
      expect(servers.web).toMatchObject({ url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' } })
    } finally {
      delete process.env.HESDOR_TEST_ARG
      delete process.env.HESDOR_TEST_TOKEN
    }
  })

  it('expands defaults and leaves unset variables empty', () => {
    expect(expandEnvVars('${NOPE_X:-dflt}/${NOPE_Y}/$HOME', {})).toBe('dflt//$HOME')
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
    state: { activeChild: null, snapshots: [], redo: [] },
  }
}
