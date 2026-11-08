import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolContext } from './context.js'
import { createDefaultRegistry, stopAllJobs } from './index.js'
import { bwrapArgv, sandboxArgv, sandboxHint, sandboxStatus, seatbeltProfile, stricterSandbox, validateSandbox } from './sandbox.js'
import type { SandboxConfig } from './sandbox.js'

const WS: SandboxConfig = { mode: 'workspace-write', network: 'off' }

describe('sandbox argv and profiles (pure, every OS)', () => {
  it('bwrap: / read-only, private /tmp, workspace writable, protected git paths, no network', () => {
    const out = bwrapArgv(['pnpm', 'test'], WS, '/w', '/w/pkg')
    expect(out.slice(0, 5)).toEqual(['bwrap', '--ro-bind', '/', '/', '--dev'])
    expect(out.join(' ')).toContain('--tmpfs /tmp')
    expect(out.join(' ')).toContain('--bind /w /w')
    expect(out.join(' ')).toContain('--ro-bind-try /w/.git/hooks /w/.git/hooks')
    expect(out).toContain('--unshare-net')
    expect(out.slice(-5)).toEqual(['--chdir', '/w/pkg', '--', 'pnpm', 'test'])
    // The workspace bind comes after the /tmp tmpfs, so a workspace under /tmp stays visible.
    expect(out.indexOf('--bind')).toBeGreaterThan(out.indexOf('--tmpfs'))
  })

  it('bwrap: read-only binds nothing writable; network on keeps the host network', () => {
    const ro = bwrapArgv(['ls'], { mode: 'read-only' }, '/w', '/w')
    expect(ro).not.toContain('--bind')
    expect(ro).toContain('--unshare-net') // network defaults to off
    expect(bwrapArgv(['ls'], { mode: 'workspace-write', network: 'on' }, '/w', '/w')).not.toContain('--unshare-net')
    // allowlist is not enforced yet: it fails closed.
    expect(bwrapArgv(['ls'], { mode: 'workspace-write', network: 'allowlist', allowDomains: ['x.org'] }, '/w', '/w')).toContain('--unshare-net')
  })

  it('seatbelt: writes only to the workspace and temp dirs, git paths denied, IP network denied, strings escaped', () => {
    const p = seatbeltProfile(WS, '/Users/me/my "repo"', ['/private/tmp'])
    expect(p).toContain('(deny file-write*)')
    expect(p).toContain('(subpath "/Users/me/my \\"repo\\"")')
    expect(p).toContain('(subpath "/private/tmp")')
    expect(p).toContain('(deny file-write* (subpath "/Users/me/my \\"repo\\"/.git/hooks")')
    expect(p).toContain('(deny network-outbound (remote ip "*:*"))')
    const ro = seatbeltProfile({ mode: 'read-only', network: 'on' }, '/w', ['/private/tmp'])
    expect(ro).not.toContain('"/w"')
    expect(ro).not.toContain('network')
    const argv = sandboxArgv(['make'], WS, 'seatbelt', '/w', '/w', ['/private/tmp'])
    expect(argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(argv.slice(-2)).toEqual(['--', 'make'])
  })

  it('is not supported on Windows', () => {
    expect(sandboxStatus('win32')).toEqual({ available: false, reason: 'not supported on Windows yet' })
  })

  it('validates config and fails closed on typos', () => {
    expect(validateSandbox(undefined, 'x')).toBeUndefined()
    expect(validateSandbox({ mode: 'read-only', network: 'allowlist', allowDomains: ['*.npmjs.org'] }, 'x')).toBeTruthy()
    expect(() => validateSandbox({ mode: 'on' }, 'cfg')).toThrow(/cfg: sandbox.mode/)
    expect(() => validateSandbox({ mode: 'read-only', netwrok: 'off' }, 'cfg')).toThrow(/unknown key "netwrok"/)
    expect(() => validateSandbox({ mode: 'read-only', allowDomains: ['a b'] }, 'cfg')).toThrow(/allowDomains/)
    expect(() => validateSandbox('read-only', 'cfg')).toThrow(/must be an object/)
  })

  it('stricterSandbox never loosens', () => {
    expect(stricterSandbox(WS, { mode: 'off', network: 'on' })).toEqual({ mode: 'workspace-write', network: 'off' })
    expect(stricterSandbox({ mode: 'off' }, { mode: 'read-only', failIfUnavailable: true })).toEqual({ mode: 'read-only', network: 'off', failIfUnavailable: true })
    expect(
      stricterSandbox({ mode: 'workspace-write', network: 'allowlist', allowDomains: ['a.org', 'b.org'] }, { mode: 'workspace-write', network: 'allowlist', allowDomains: ['b.org'] }),
    ).toEqual({ mode: 'workspace-write', network: 'allowlist', allowDomains: ['b.org'] })
    expect(stricterSandbox(undefined, WS)).toBe(WS)
  })

  it('hints name the constraint behind EPERM/EACCES and network errors', () => {
    expect(sandboxHint(WS, "EACCES: permission denied, open '/home/me/x'")).toMatch(/writes only inside the workspace/)
    expect(sandboxHint(WS, 'getaddrinfo ENOTFOUND registry.npmjs.org')).toMatch(/blocks network access/)
    expect(sandboxHint({ mode: 'workspace-write', network: 'on' }, 'getaddrinfo ENOTFOUND x')).toBeUndefined()
    expect(sandboxHint(WS, 'AssertionError: expected 1 to be 2')).toBeUndefined()
  })
})

// ── Real sandbox: runs where bwrap (Linux CI installs it) or sandbox-exec (macOS) works ─────

const status = sandboxStatus()
const root = mkdtempSync(path.join(os.tmpdir(), 'hesdor-sbx-'))
mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
writeFileSync(path.join(root, 'write.js'), "require('fs').writeFileSync(process.argv[2], 'x'); console.log('wrote')\n")
writeFileSync(
  path.join(root, 'connect.js'),
  "const s = require('net').connect(Number(process.argv[2]), '127.0.0.1', () => { console.log('connected'); process.exit(0) })\ns.on('error', (e) => { console.error(e.code); process.exit(1) })\n",
)
const outsideDir = mkdtempSync(path.join(os.homedir(), '.hesdor-sbx-out-'))
afterAll(async () => {
  await stopAllJobs()
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

const registry = createDefaultRegistry()
let prompts = 0
const ctx = (sandbox: SandboxConfig): ToolContext => ({
  root,
  mode: 'build',
  model: 'test',
  signal: new AbortController().signal,
  emit: () => {},
  // Rules are present and approvals on, so an unclassified command would ask: the sandbox must replace that prompt.
  requestApproval: () => {
    prompts++
    return Promise.resolve(false)
  },
  approvalsEnabled: true,
  permissions: { user: {}, project: {} },
  sandbox,
  state: { activeChild: null, snapshots: [], redo: [] },
})
const run = (input: unknown, sandbox: SandboxConfig = WS) => registry.get('run_command')!.execute(input, ctx(sandbox)) as Promise<any>

// CI installs bwrap on Linux and macOS ships sandbox-exec: fail loudly (with the probe's reason) instead of skipping.
it.runIf(process.platform === 'darwin' || (process.env.CI && process.platform === 'linux'))('the sandbox is available on this CI runner', () => {
  expect(status).toMatchObject({ available: true })
})

describe.skipIf(!status.available)(`real sandbox (${status.backend ?? 'unavailable'})`, () => {
  it('writes inside the workspace without a prompt', async () => {
    const r = await run({ command: 'node write.js inside.txt' })
    expect(r.exitCode).toBe(0)
    expect(existsSync(path.join(root, 'inside.txt'))).toBe(true)
    expect(prompts).toBe(0)
  })

  it('cannot write outside the workspace or into .git/hooks, and says why', async () => {
    const outside = path.join(outsideDir, 'escaped.txt')
    const r = await run({ command: `node write.js "${outside}"` })
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(outside)).toBe(false)
    expect(r.sandbox).toMatch(/writes only inside the workspace/)
    const hook = await run({ command: 'node write.js .git/hooks/pre-commit' })
    expect(hook.exitCode).not.toBe(0)
    expect(existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('read-only mode refuses workspace writes', async () => {
    const r = await run({ command: 'node write.js ro.txt' }, { mode: 'read-only' })
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(path.join(root, 'ro.txt'))).toBe(false)
  })

  it('blocks the network unless sandbox.network is "on"', async () => {
    const server = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const blocked = await run({ command: `node connect.js ${port}` })
      expect(blocked.exitCode).not.toBe(0)
      expect(blocked.stdout).not.toContain('connected')
      const open = await run({ command: `node connect.js ${port}` }, { mode: 'workspace-write', network: 'on' })
      expect(open.stdout).toContain('connected')
    } finally {
      server.close()
    }
  })

  it('sandboxes background jobs too', async () => {
    const outside = path.join(outsideDir, 'job.txt')
    const r = await run({ command: `node write.js "${outside}"`, background: true })
    expect(r.status).toBe('exited')
    expect(existsSync(outside)).toBe(false)
  })
})

describe.skipIf(status.available)('sandbox unavailable here', () => {
  it('failIfUnavailable refuses to run; otherwise commands run unsandboxed and ask as usual', async () => {
    await expect(run({ command: 'node write.js nope.txt' }, { ...WS, failIfUnavailable: true })).rejects.toThrow(/sandbox is required/)
    expect(existsSync(path.join(root, 'nope.txt'))).toBe(false)
    const before = prompts
    await expect(run({ command: 'node write.js asked.txt' })).rejects.toThrow(/denied/)
    expect(prompts).toBe(before + 1)
  })
})
