import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Token files land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-oauth-home-'))

import {
  McpClient,
  loginMcpServer,
  logoutMcpServer,
  mcpAuthFile,
  mcpAuthStatus,
  mcpPromptCommands,
  mcpToolRisk,
  parsePromptArgs,
  registerMcpServers,
} from './index.js'
import type { ToolContext } from './context.js'
import { createDefaultRegistry } from './registry.js'

interface Fake {
  origin: string
  /** Authorization header of every request, by path. */
  seen: Array<{ path: string; auth?: string }>
  close(): void
}

type Reply = { status: number; headers?: Record<string, string>; body?: string }

async function serve(handler: (req: IncomingMessage, url: URL, body: string) => Reply): Promise<Fake> {
  const seen: Fake['seen'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      seen.push({ path: url.pathname, auth: req.headers.authorization })
      const r = handler(req, url, body)
      res.writeHead(r.status, r.headers).end(r.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

const json = (body: unknown, status = 200): Reply => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// Authorization server (one origin) + protected MCP server (another origin) + a bystander (a third origin).
let as: Fake
let rs: Fake
let other: Fake
const log: string[] = []
const codes = new Map<string, { challenge: string; redirect: string; resource: string }>()
const refresh = new Set<string>()
const access = new Map<string, { expired: boolean }>()
let redirectTo: string | undefined
const resource = () => `${rs.origin}/mcp`

beforeAll(async () => {
  as = await serve((req, url, body) => {
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: as.origin,
        authorization_endpoint: `${as.origin}/authorize`,
        token_endpoint: `${as.origin}/token`,
        registration_endpoint: `${as.origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/register') {
      const meta = JSON.parse(body) as { redirect_uris: string[]; application_type?: string }
      log.push(`register ${meta.application_type}`)
      return json({ ...meta, client_id: 'client-1' }, 201)
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      log.push(`authorize resource=${p.get('resource')} method=${p.get('code_challenge_method')}`)
      const code = randomBytes(8).toString('hex')
      codes.set(code, { challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, resource: p.get('resource')! })
      const back = new URL(p.get('redirect_uri')!)
      back.search = new URLSearchParams({ code, state: p.get('state')!, iss: as.origin }).toString()
      return { status: 302, headers: { location: back.href } }
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body)
      const issue = (): Reply => {
        const at = `at-${randomBytes(4).toString('hex')}`
        const rt = `rt-${randomBytes(4).toString('hex')}`
        access.set(at, { expired: false })
        refresh.add(rt)
        return json({ access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt })
      }
      if (p.get('resource') !== resource()) return json({ error: 'invalid_target' }, 400)
      if (p.get('grant_type') === 'authorization_code') {
        const entry = codes.get(p.get('code') ?? '')
        const pkce = entry && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === entry.challenge
        log.push(`token code pkce=${pkce ? 'ok' : 'bad'}`)
        if (!entry || !pkce || entry.redirect !== p.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400)
        codes.delete(p.get('code')!)
        return issue()
      }
      if (p.get('grant_type') === 'refresh_token' && refresh.delete(p.get('refresh_token') ?? '')) {
        log.push('token refresh')
        return issue()
      }
      return json({ error: 'invalid_grant' }, 400)
    }
    return { status: 404 }
  })

  rs = await serve((req, url, body) => {
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: resource(), authorization_servers: [as.origin], scopes_supported: ['mcp:read'] })
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST') return { status: 405 }
    if (redirectTo) return { status: 307, headers: { location: redirectTo } }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const live = token ? access.get(token) : undefined
    if (!live || live.expired) {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${rs.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"` },
      }
    }
    const msg = JSON.parse(body) as { id?: number; method: string }
    if (msg.id === undefined) return { status: 202 }
    const rpc = (payload: object) => json({ jsonrpc: '2.0', id: msg.id, ...payload })
    if (msg.method === 'initialize') return rpc({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } } })
    if (msg.method === 'tools/list') return rpc({ result: { tools: [{ name: 'hi', inputSchema: { type: 'object' } }] } })
    if (msg.method === 'tools/call') return rpc({ result: { content: [{ type: 'text', text: 'hi' }] } })
    return rpc({ error: { code: -32601, message: 'Method not found' } })
  })

  other = await serve(() => ({ status: 401, headers: { 'www-authenticate': 'Bearer' } }))
})

afterAll(() => {
  for (const f of [as, rs, other]) f?.close()
})

/** Plays the browser: follows the authorize redirect, first with a forged state, then for real. */
function browser(results: number[]): (url: string) => void {
  return (url) => {
    void (async () => {
      const res = await fetch(url, { redirect: 'manual' })
      const back = new URL(res.headers.get('location')!)
      const forged = new URL(back)
      forged.searchParams.set('state', 'forged')
      results.push((await fetch(forged)).status)
      results.push((await fetch(back)).status)
    })()
  }
}

describe('remote MCP OAuth', () => {
  it('needs a login before a session can use the server', async () => {
    await expect(McpClient.connect({ url: resource() }, 5000, 'remote')).rejects.toThrow(/hesdor mcp login remote/)
    expect(await mcpAuthStatus('remote', resource())).toBe('not logged in')
  })

  it('logs in with discovery, dynamic registration, PKCE and the resource indicator', async () => {
    const callbacks: number[] = []
    const printed: string[] = []
    await loginMcpServer('remote', resource(), { openBrowser: browser(callbacks), print: (l) => printed.push(l), timeoutMs: 10_000 })
    expect(callbacks).toEqual([400, 200]) // forged state refused, real callback accepted
    expect(printed.join('\n')).toContain(`${as.origin}/authorize?`)
    expect(log).toContain('register native')
    expect(log).toContain(`authorize resource=${resource()} method=S256`)
    expect(log).toContain('token code pkce=ok')

    const file = mcpAuthFile('remote')
    expect(file.startsWith(process.env.APPDATA!)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).serverUrl).toBe(resource())
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await mcpAuthStatus('remote', resource())).toBe('logged in')
  })

  it('sends the token to the server and refreshes it when it expires', async () => {
    const client = await McpClient.connect({ url: resource() }, 5000, 'remote')
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(['hi'])
      for (const entry of access.values()) entry.expired = true
      expect((await client.callTool('hi', {})).text).toBe('hi')
      expect(log).toContain('token refresh')
      const stored = JSON.parse(readFileSync(mcpAuthFile('remote'), 'utf8')) as { tokens: { access_token: string } }
      expect(access.get(stored.tokens.access_token)?.expired).toBe(false)
    } finally {
      client.close()
    }
  })

  it('never sends a token to another origin', async () => {
    // Same server name, different URL: the stored token is bound to the old URL.
    await expect(McpClient.connect({ url: `${other.origin}/mcp` }, 5000, 'remote')).rejects.toThrow(/hesdor mcp login remote/)
    // A redirect from the real server to another origin is not followed with the token.
    const client = await McpClient.connect({ url: resource() }, 5000, 'remote')
    redirectTo = `${other.origin}/mcp`
    try {
      await expect(client.callTool('hi', {})).rejects.toThrow()
    } finally {
      redirectTo = undefined
      client.close()
    }
    expect(other.seen.length).toBeGreaterThan(0)
    expect(other.seen.every((r) => r.auth === undefined)).toBe(true)
    expect(as.seen.every((r) => !r.auth?.startsWith('Bearer at-'))).toBe(true)
  })

  it('logout deletes the stored tokens', async () => {
    expect(await logoutMcpServer('remote')).toBe(true)
    expect(existsSync(mcpAuthFile('remote'))).toBe(false)
    expect(await logoutMcpServer('remote')).toBe(false)
  })
})

const extras = { command: process.execPath, args: [fileURLToPath(new URL('./testing/mcp-extras-server.cjs', import.meta.url))] }

function ctx(mode: ToolContext['mode']): ToolContext {
  return {
    root: process.cwd(),
    mode,
    model: 'test',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(true),
    approvalsEnabled: true,
    state: { activeChild: null, snapshots: [], redo: [] },
  }
}

describe('MCP trust, prompts, resources and elicitation', () => {
  it('maps annotations to risk only for user-scope servers, in a stable order', async () => {
    const registry = createDefaultRegistry()
    const servers = await registerMcpServers(registry, { mine: extras, repo: extras }, () => {}, { userScoped: ['mine'] })
    try {
      const risk = (n: string) => registry.get(n)?.risk
      expect(servers.map((s) => s.tools)).toEqual([
        ['mcp_mine_ask', 'mcp_mine_fetch', 'mcp_mine_look', 'mcp_mine_zap'],
        ['mcp_repo_ask', 'mcp_repo_fetch', 'mcp_repo_look', 'mcp_repo_zap'],
      ])
      expect([risk('mcp_mine_look'), risk('mcp_mine_zap'), risk('mcp_mine_fetch'), risk('mcp_mine_ask')]).toEqual(['READ', 'DESTRUCTIVE', 'NETWORK', 'NETWORK'])
      expect(['look', 'zap', 'fetch', 'ask'].map((t) => risk(`mcp_repo_${t}`))).toEqual(['NETWORK', 'NETWORK', 'NETWORK', 'NETWORK'])
      expect(mcpToolRisk({ name: 'x', annotations: { readOnlyHint: true } }, false)).toBe('NETWORK')

      // Resources: one READ tool, capped output, repository servers need build mode.
      const read = registry.get('mcp_read_resource')!
      expect(read.risk).toBe('READ')
      expect(read.description).toContain('mine: mem://small (small)')
      const big = (await read.execute({ server: 'mine', uri: 'mem://big' }, ctx('plan'))) as { text: string }
      expect(big.text.length).toBeLessThan(101_000)
      expect(big.text).toMatch(/\[truncated: \d+ more characters not shown\]$/)
      expect(((await read.execute({ server: 'mine' }, ctx('ask'))) as { text: string }).text).toBe('mem://big (big)\nmem://small (small)')
      await expect(read.execute({ server: 'repo', uri: 'mem://small' }, ctx('plan'))).rejects.toThrow(/needs build mode/)
      expect(((await read.execute({ server: 'repo', uri: 'mem://small' }, ctx('build'))) as { text: string }).text).toContain('small body')

      // Prompts as slash commands.
      const commands = mcpPromptCommands(servers)
      expect(commands.map((c) => c.name)).toEqual(['mcp__mine__greet', 'mcp__repo__greet'])
      expect(await commands[0]!.expand!('Bob tone="very warm"')).toBe('Hello Bob (very warm)')
      await expect(commands[0]!.expand!('')).rejects.toThrow(/missing argument "who"/)
    } finally {
      for (const s of servers) s.client.close()
    }
  })

  it('passes elicitation to the host hook, and declines without one', async () => {
    const registry = createDefaultRegistry()
    const asked: string[] = []
    const servers = await registerMcpServers(registry, { mine: extras }, () => {}, {
      onElicit: async (server, request) => {
        asked.push(`${server}: ${request.message}`)
        return { action: 'accept', content: { name: 'Ada' } }
      },
    })
    const bare = await registerMcpServers(createDefaultRegistry(), { other: extras })
    try {
      expect(((await registry.get('mcp_mine_ask')!.execute({}, ctx('build'))) as { text: string }).text).toBe('elicit:accept{"name":"Ada"}')
      expect(asked).toEqual(['mine: Pick a name'])
      expect(((await bare[0]!.client.callTool('ask', {})).text)).toBe('elicit:decline{}')
    } finally {
      for (const s of [...servers, ...bare]) s.client.close()
    }
  })

  it('parses prompt arguments', () => {
    const defs = [{ name: 'a', required: true }, { name: 'b' }]
    expect(parsePromptArgs('b=2 one', defs)).toEqual({ a: 'one', b: '2' })
    expect(parsePromptArgs('x y z', defs)).toEqual({ a: 'x', b: 'y z' })
    expect(parsePromptArgs(`a="q \\" r" b='s t'`, defs)).toEqual({ a: 'q " r', b: 's t' })
    expect(() => parsePromptArgs('', defs)).toThrow(/usage: a=<...> \[b=<...>\]/)
  })
})
