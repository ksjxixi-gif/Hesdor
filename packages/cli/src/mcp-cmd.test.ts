import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from './args.js'
import { runMcpCommand } from './mcp-cmd.js'
import { createSession } from './session.js'

// Config writes land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-mcpcmd-home-'))
const userFile = path.join(process.env.APPDATA, 'hesdor', 'mcp.json')
const extras = fileURLToPath(new URL('../../agent-core/src/testing/mcp-extras-server.cjs', import.meta.url))

const root = mkdtempSync(path.join(tmpdir(), 'hesdor-mcpcmd-repo-'))
mkdirSync(path.join(root, '.hesdor'))
writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'definitely-not-run-xyz' } } }))

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  try {
    return { code: await runMcpCommand(argv, root), out: out.join('\n'), err: err.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('hesdor mcp', () => {
  it('keeps the words after "mcp" verbatim', () => {
    const parsed = parseArgs(['mcp', 'add', 'fs', 'npx', '-y', '@scope/pkg'])
    expect(parsed.command).toBe('mcp')
    expect(parsed.args).toEqual(['add', 'fs', 'npx', '-y', '@scope/pkg'])
  })

  it('add validates and writes only the user mcp.json', async () => {
    expect((await run(['add', 'bad name', 'x'])).code).toBe(1)
    expect((await run(['add', 'web', '--url', 'http://example.com/mcp'])).err).toMatch(/must use https/)
    expect((await run(['add', 'fake', process.execPath, extras])).code).toBe(0)
    expect((await run(['add', 'remote', '--url', 'https://127.0.0.1:1/mcp'])).code).toBe(0)
    expect((await run(['add', 'fake', 'other'])).err).toMatch(/already exists/)

    const saved = JSON.parse(readFileSync(userFile, 'utf8'))
    expect(saved.mcp).toEqual({ fake: { command: process.execPath, args: [extras] }, remote: { url: 'https://127.0.0.1:1/mcp' } })
    if (process.platform !== 'win32') expect(statSync(userFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { proj: { command: 'definitely-not-run-xyz' } } })
  })

  it('list shows scope, transport, status and auth without starting project servers', async () => {
    const { code, out } = await run(['list'])
    expect(code).toBe(0)
    expect(out).toContain(`fake  user  stdio ${process.execPath} ${extras}\n    status: ok, 4 tools  ·  auth: -`)
    expect(out).toMatch(/remote {2}user {2}http https:\/\/127\.0\.0\.1:1\/mcp\n {4}status: failed: .*auth: not logged in/)
    expect(out).toContain('proj  project  stdio definitely-not-run-xyz\n    status: not started (project server, loads after workspace trust)')
  })

  it('login and logout check the server', async () => {
    expect((await run(['login', 'fake'])).err).toMatch(/stdio server/)
    expect((await run(['login', 'nope'])).err).toMatch(/no MCP server named "nope"/)
    expect((await run(['logout', 'remote'])).out).toBe('no saved login for "remote"')
    expect((await run(['frobnicate'])).code).toBe(1)
  })
})

describe('session MCP wiring', () => {
  it('adds prompt commands, trusts user annotations, and declines elicitation headless', async () => {
    const warnings: string[] = []
    const session = await createSession({ root, warn: (m) => warnings.push(m) })
    try {
      const greet = session.commands.get('mcp__fake__greet')
      expect(await greet?.expand?.('Ada')).toBe('Hello Ada')
      expect(session.registry.get('mcp_fake_look')?.risk).toBe('READ')
      expect(session.mcpServers.map((s) => [s.name, s.userScope])).toEqual([['fake', true]])

      const ask = session.registry.get('mcp_fake_ask')!
      const ctx = {
        root,
        mode: 'build' as const,
        model: 't',
        signal: new AbortController().signal,
        emit: () => {},
        requestApproval: async () => true,
        approvalsEnabled: true,
        state: { activeChild: null, snapshots: [], redo: [] },
      }
      expect(((await ask.execute({}, ctx)) as { text: string }).text).toBe('elicit:decline{}')
      expect(warnings.join('\n')).toContain('mcp server "fake" asked for input ("Pick a name"); declined')

      session.onElicit = async () => ({ action: 'accept', content: { name: 'Lin' } })
      expect(((await ask.execute({}, ctx)) as { text: string }).text).toBe('elicit:accept{"name":"Lin"}')
    } finally {
      session.dispose()
    }
  })
})
