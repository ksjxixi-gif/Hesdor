import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideCommand } from '@hesdor/agent-core'
import { parseArgs } from './args.js'
import { configDir } from './config.js'
import { runHeadless } from './headless.js'
import { addUserAllowRule, loadPermissions, runPolicyCommand } from './policy-cmd.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

function project(rules?: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-policy-'))
  if (rules !== undefined) {
    mkdirSync(path.join(root, '.hesdor'))
    writeFileSync(path.join(root, '.hesdor', 'permissions.json'), JSON.stringify(rules))
  }
  return root
}

function writeUserConfig(cfg: unknown): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(path.join(configDir(), 'config.json'), JSON.stringify(cfg))
}

afterEach(() => {
  vi.restoreAllMocks()
  writeUserConfig({})
})

describe('loadPermissions', () => {
  it('takes allow rules from the user only; the project can add ask and deny', async () => {
    writeUserConfig({ permissions: { allow: ['make build'] } })
    const root = project({ allow: ['node'], ask: ['make'], deny: [{ write: 'secrets/**' }] })
    const policy = await loadPermissions(root)
    expect(policy.user.allow).toEqual(['make build'])
    expect(policy.project).toEqual({ ask: ['make'], deny: [{ write: 'secrets/**' }] })
    expect(decideCommand(['node', 'x.js'], policy).action).toBe('ask')
    expect(decideCommand(['make', 'build'], policy).action).toBe('ask') // project ask beats user allow
  })

  it('fails loudly on malformed rules', async () => {
    await expect(loadPermissions(project({ deny: 'rm' }))).rejects.toThrow(/permissions.json: permissions.deny must be an array/)
  })
})

describe('addUserAllowRule ("always allow")', () => {
  it('persists the exact argv once, keeps other config, and updates the live policy', async () => {
    writeUserConfig({ provider: 'openai', permissions: { deny: ['git push'] } })
    const root = project()
    const live = await loadPermissions(root)
    expect(decideCommand(['node', 'build.js', '--prod'], live).action).toBe('ask')
    await addUserAllowRule(['node', 'build.js', '--prod'], live)
    await addUserAllowRule(['node', 'build.js', '--prod'], live)
    expect(decideCommand(['node', 'build.js', '--prod'], live).action).toBe('allow')
    const saved = JSON.parse(readFileSync(path.join(configDir(), 'config.json'), 'utf8'))
    expect(saved).toEqual({ provider: 'openai', permissions: { deny: ['git push'], allow: [['node', 'build.js', '--prod']] } })
    expect(decideCommand(['node', 'build.js', '--prod'], await loadPermissions(root)).action).toBe('allow')
  })
})

describe('hesdor policy check', () => {
  const capture = async (args: string[], cwd: string): Promise<{ code: number; out: string }> => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const code = await runPolicyCommand(args, cwd)
    return { code, out: lines.join('\n') }
  }

  it('prints the decision, the matching rule and where it comes from', async () => {
    const root = project({ deny: ['git push'], allow: ['rm'] })
    const deny = await capture(['check', 'git', 'push', '--force'], root)
    expect(deny.code).toBe(0)
    expect(deny.out).toMatch(/^deny {2}\["git","push","--force"\]/)
    expect(deny.out).toContain('why:    project deny rule "git push"')
    expect(deny.out).toContain(path.join('.hesdor', 'permissions.json'))
    expect(deny.out).toContain('allow rules in')

    const risky = await capture(['check', 'rm -rf build'], root)
    expect(risky.out).toMatch(/^ask {2}\["rm","-rf","build"\]/)
    expect(risky.out).toContain('DESTRUCTIVE: destructive filesystem operation')
    expect(risky.out).toContain('headless: refused unless --yes')

    expect((await capture(['check', 'node', 'x.js'], root)).out).toContain('headless without --yes: runs')
    expect((await capture(['check', 'pnpm', 'test'], root)).out).toMatch(/^allow[\s\S]*built-in safe command/)
    expect((await capture(['nope'], root)).code).toBe(1)
  })

  it("parses everything after `policy` verbatim, so the command's flags are not Hesdor's", () => {
    expect(parseArgs(['policy', 'check', 'git', 'commit', '-m', 'a b', '-f'])).toMatchObject({
      command: 'policy',
      args: ['check', 'git', 'commit', '-m', 'a b', '-f'],
      flags: { force: false },
    })
    expect(parseArgs(['fix', 'the', 'policy']).command).toBe('interactive')
    expect(parseArgs(['run', 'x', '--allow-root']).flags.allowRoot).toBe(true)
  })
})

describe('headless as root', () => {
  it('refuses uid 0 unless --allow-root', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')))
    const flags = parseArgs(['run', 'hello']).flags
    expect(await runHeadless('build', 'hello', flags, { uid: 0, cwd: project() })).toBe(1)
    expect(errors.join('\n')).toMatch(/refusing to run headless as root/)
  })
})
