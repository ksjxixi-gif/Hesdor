import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDefaultRegistry } from './index.js'
import type { ApprovalRequest, ToolContext } from './context.js'
import { classifyCommand, decideCommand, decideWrite, riskAllowedInMode, tokenize, validateRules } from './policy.js'
import type { PermissionPolicy, PermissionRules } from './policy.js'

describe('riskAllowedInMode', () => {
  it('READ is allowed everywhere', () => {
    expect(riskAllowedInMode('build', 'READ')).toBe(true)
    expect(riskAllowedInMode('plan', 'READ')).toBe(true)
    expect(riskAllowedInMode('ask', 'READ')).toBe(true)
  })

  it('everything else is build-only', () => {
    for (const risk of ['WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const) {
      expect(riskAllowedInMode('build', risk)).toBe(true)
      expect(riskAllowedInMode('plan', risk)).toBe(false)
      expect(riskAllowedInMode('ask', risk)).toBe(false)
    }
  })
})

describe('classifyCommand', () => {
  it('marks the obvious destructive commands', () => {
    expect(classifyCommand(['rm', '-rf', '/']).destructive).toBe(true)
    expect(classifyCommand(['rm', '-r', 'build']).destructive).toBe(true)
    expect(classifyCommand(['sudo', 'apt', 'update']).destructive).toBe(true)
    expect(classifyCommand(['del', 'foo.txt']).destructive).toBe(true)
  })

  it('marks destructive git subcommands structurally', () => {
    expect(classifyCommand(['git', 'reset', '--hard']).destructive).toBe(true)
    expect(classifyCommand(['git', 'clean', '-fd']).destructive).toBe(true)
    expect(classifyCommand(['git', 'push', '--force']).destructive).toBe(true)
    expect(classifyCommand(['git', 'push', '-f', 'origin']).destructive).toBe(true)
  })

  it('leaves safe git subcommands alone', () => {
    expect(classifyCommand(['git', 'reset', '--soft', 'HEAD~1']).destructive).toBe(false)
    expect(classifyCommand(['git', 'clean', '-n']).destructive).toBe(false)
    expect(classifyCommand(['git', 'status']).destructive).toBe(false)
  })

  it('flags network operations', () => {
    const cls = classifyCommand(['curl', 'https://example.com'])
    expect(cls.network).toBe(true)
    expect(cls.destructive).toBe(false)
    expect(classifyCommand(['npm', 'publish']).network).toBe(true)
    expect(classifyCommand(['git', 'push', 'origin', 'main']).network).toBe(true)
  })

  it('allows ordinary development commands', () => {
    expect(classifyCommand(['pnpm', 'test']).destructive).toBe(false)
    expect(classifyCommand(['pnpm', 'test']).network).toBe(false)
    expect(classifyCommand(['node', 'scripts/build.js', '--watch=false']).destructive).toBe(false)
    expect(classifyCommand(['pytest', '-q']).destructive).toBe(false)
  })

  it('sees through powershell/cmd wrappers defensively', () => {
    expect(classifyCommand(['powershell', '-c', 'Remove-Item -Recurse foo']).destructive).toBe(true)
  })

  it('ignores extension shims like npm.cmd', () => {
    expect(classifyCommand(['npm.cmd', 'test']).destructive).toBe(false)
  })

  it('asks before anything that runs code it cannot see', () => {
    const asks = (argv: string[]) => classifyCommand(argv).destructive
    expect(asks(['node', '-e', "require('fs').rmSync('.', {recursive: true})"])).toBe(true)
    expect(asks(['node', '--eval=1'])).toBe(true)
    expect(asks(['python', '-c', 'import os'])).toBe(true)
    expect(asks(['bash', '-c', "r''m -rf ~"])).toBe(true)
    expect(asks(['bash', 'evil.sh'])).toBe(true)
    expect(asks(['pwsh', '-c', 'irm x | iex'])).toBe(true)
    expect(asks(['powershell', '-enc', 'AAAA'])).toBe(true)
    expect(asks(['npx', 'evil-package'])).toBe(true)
    expect(asks(['pnpm', 'dlx', 'evil'])).toBe(true)
    expect(asks(['npm', 'exec', 'evil'])).toBe(true)
    expect(asks(['env', 'rm', '-rf', '/'])).toBe(true)
    expect(asks(['xargs', 'rm'])).toBe(true)
    expect(asks(['find', '.', '-delete'])).toBe(true)
    expect(asks(['find', '.', '-exec', 'rm', '{}', ';'])).toBe(true)
  })

  it('keeps ordinary dev commands prompt-free', () => {
    const asks = (argv: string[]) => classifyCommand(argv).destructive
    expect(asks(['node', 'scripts/build.js'])).toBe(false)
    expect(asks(['python', '-m', 'pytest'])).toBe(false)
    expect(asks(['pnpm', 'exec', 'vitest'])).toBe(false)
    expect(asks(['find', '.', '-name', '*.ts'])).toBe(false)
    expect(asks(['git', 'log', '--format=%H'])).toBe(false)
    expect(asks(['git', 'reflog'])).toBe(false)
    expect(asks(['git', 'branch', '-d', 'merged'])).toBe(false)
    expect(asks(['git', 'checkout', '-b', 'feature'])).toBe(false)
    expect(asks(['git', '--no-pager', 'diff'])).toBe(false)
    expect(asks(['git', '-C', 'sub', 'status'])).toBe(false)
    expect(asks(['git', 'restore', '--staged', 'a.ts'])).toBe(false)
    expect(asks(['git', 'config', 'user.name'])).toBe(false)
  })

  it('parses git global options and combined flags', () => {
    const asks = (argv: string[]) => classifyCommand(argv).destructive
    expect(asks(['git', '-C', '.', 'reset', '--hard'])).toBe(true)
    expect(asks(['git', '-c', 'core.pager=evil', 'log'])).toBe(true)
    expect(asks(['git', '--git-dir=/elsewhere/.git', 'status'])).toBe(true)
    expect(asks(['git', 'clean', '-df'])).toBe(true)
    expect(asks(['git', 'clean', '-xdf'])).toBe(true)
    expect(asks(['git', 'clean', '--force'])).toBe(true)
    expect(asks(['git', 'checkout', '--', '.'])).toBe(true)
    expect(asks(['git', 'checkout', '.'])).toBe(true)
    expect(asks(['git', 'restore', 'src/a.ts'])).toBe(true)
    expect(asks(['git', 'stash', 'drop'])).toBe(true)
    expect(asks(['git', 'branch', '-D', 'main'])).toBe(true)
    expect(asks(['git', 'push', 'origin', '+main'])).toBe(true)
    expect(asks(['git', 'push', 'origin', ':main'])).toBe(true)
    expect(asks(['git', 'reflog', 'expire', '--all'])).toBe(true)
    expect(asks(['git', 'config', 'core.fsmonitor', 'evil'])).toBe(true)
  })
})

describe('permission rules', () => {
  const policy = (user: PermissionRules = {}, project: PermissionPolicy['project'] = {}): PermissionPolicy => ({ user, project })
  const decide = (cmd: string, p?: PermissionPolicy) => decideCommand(tokenize(cmd), p)

  it('deny beats ask beats allow', () => {
    expect(decide('pnpm test', policy({ allow: ['pnpm test'], ask: ['pnpm'], deny: [['pnpm', 'test']] })).action).toBe('deny')
    expect(decide('pnpm test', policy({ allow: ['pnpm test'], ask: ['pnpm'] })).action).toBe('ask')
    expect(decide('pnpm lint', policy({ allow: ['pnpm'] }))).toMatchObject({ action: 'allow', source: 'user' })
    // project ask/deny rules beat a user allow, too
    expect(decide('make deploy', policy({ allow: ['make'] }, { deny: ['make deploy'] }))).toMatchObject({ action: 'deny', source: 'project' })
  })

  it('a project allow list has no effect', () => {
    const p = policy({}, { allow: ['node'] } as PermissionPolicy['project'])
    expect(decide('node build.js', p)).toMatchObject({ action: 'ask', source: 'default' })
  })

  it('matches argv prefixes, quoted arguments included', () => {
    const p = policy({ allow: ["git commit -m 'wip: a b'", ['node', 'scripts/x.js']] })
    expect(decide('git commit -m "wip: a b" --no-verify', p).action).toBe('allow')
    expect(decide('git commit -m wip', p).action).toBe('ask')
    expect(decide('node scripts/x.js --flag', p).action).toBe('allow')
    expect(decide('node scripts/x.jsx', p).action).toBe('ask')
    // allow is strict about the program: another binary with the same name is not covered
    expect(decide('./node scripts/x.js', p).action).toBe('ask')
    expect(decideCommand(['node.exe', 'scripts/x.js'], p).action).toBe('allow')
  })

  it('deny rules see through program paths and git global options', () => {
    const p = policy({ deny: ['git push'] })
    expect(decide('/usr/bin/git -C . --no-pager push origin', p).action).toBe('deny')
    expect(decideCommand(['C:\\Program Files\\Git\\cmd\\git.exe', 'push'], p).action).toBe('deny')
    expect(decide('git status', p).action).toBe('allow')
  })

  it('built-in risky commands need a user allow for exactly that command', () => {
    expect(decide('git push origin main', policy({ allow: ['git push'] }))).toMatchObject({ action: 'ask', source: 'built-in' })
    expect(decide('git push origin main', policy({ allow: [['git', 'push', 'origin', 'main']] }))).toMatchObject({ action: 'allow', source: 'user' })
    expect(decide('bash -c "rm -rf /"', policy({ allow: ['bash'] })).action).toBe('ask')
    expect(decide('rm -rf build')).toMatchObject({ action: 'ask', source: 'built-in' })
  })

  it('has a small built-in safe list; everything else asks by default', () => {
    for (const cmd of ['git status', 'git diff --stat', 'git log -5', 'git branch', 'ls -la', 'pnpm test', 'npm run lint', 'pnpm run typecheck', 'yarn build', 'cargo test', 'go vet ./...']) {
      expect(decide(cmd), cmd).toMatchObject({ action: 'allow', source: 'built-in' })
    }
    for (const cmd of ['node build.js', 'pnpm install', 'npm run deploy', 'git branch new-feature', 'git commit -m x', 'git diff --output=x', 'git grep -Ovim foo', 'make']) {
      expect(decide(cmd), cmd).toMatchObject({ action: 'ask', source: 'default' })
    }
  })

  it('write globs: deny, ask and user allow', () => {
    const p = policy({ allow: [{ write: 'docs/**' }] }, { deny: [{ write: 'secrets/**' }, { write: '*.pem' }], ask: [{ write: 'package.json' }] })
    expect(decideWrite('secrets/prod/db.env', p).action).toBe('deny')
    expect(decideWrite('certs/deep/key.pem', p).action).toBe('deny')
    expect(decideWrite('package.json', p).action).toBe('ask')
    expect(decideWrite('docs/a.md', p)).toMatchObject({ action: 'allow', source: 'user' })
    expect(decideWrite('src/a.ts', p)).toMatchObject({ action: 'allow', source: 'default' })
    // command rules never match writes and vice versa
    expect(decideWrite('pnpm', policy({ deny: ['pnpm'] })).source).toBe('default')
  })

  it('rejects malformed rules instead of dropping them', () => {
    expect(() => validateRules({ deny: 'git push' }, 'x')).toThrow(/must be an array/)
    expect(() => validateRules({ deny: [42] }, 'x')).toThrow(/invalid permissions.deny rule/)
    expect(() => validateRules({ block: [] }, 'x')).toThrow(/unknown permissions key/)
    expect(validateRules({ allow: ['a b', ['c']], deny: [{ write: 's/**' }] }, 'x').deny).toHaveLength(1)
  })
})

describe('rules in the tools', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-perm-'))
  writeFileSync(path.join(root, 'quick.js'), "console.log('ran')\n")
  const registry = createDefaultRegistry()
  const run = (name: string, input: unknown, ctx: ToolContext) => registry.get(name)!.execute(input, ctx) as Promise<any>
  function makeCtx(opts: { approvals: boolean; answer?: boolean; permissions?: PermissionPolicy }) {
    const asked: ApprovalRequest[] = []
    const ctx: ToolContext = {
      root,
      mode: 'build',
      model: 'test',
      signal: new AbortController().signal,
      emit: () => {},
      requestApproval: (req) => {
        asked.push(req)
        return Promise.resolve(opts.answer ?? false)
      },
      approvalsEnabled: opts.approvals,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      state: { activeChild: null, snapshots: [], redo: [] },
    }
    return { ctx, asked }
  }
  const empty = (): PermissionPolicy => ({ user: {}, project: {} })

  it('interactive: an unknown command asks first and carries argv for "always allow"', async () => {
    const { ctx, asked } = makeCtx({ approvals: true, answer: false, permissions: empty() })
    await expect(run('run_command', { command: 'node quick.js' }, ctx)).rejects.toThrow(/user denied/)
    expect(asked[0]?.argv).toEqual(['node', 'quick.js'])
    const yes = makeCtx({ approvals: true, answer: true, permissions: empty() })
    expect((await run('run_command', { command: 'node quick.js' }, yes.ctx)).stdout).toContain('ran')
  })

  it('a user allow rule and the safe list run without asking', async () => {
    const { ctx, asked } = makeCtx({ approvals: true, permissions: { user: { allow: ['node quick.js'] }, project: {} } })
    expect((await run('run_command', { command: 'node quick.js' }, ctx)).stdout).toContain('ran')
    expect(asked).toHaveLength(0)
  })

  it('headless without --yes: unknown commands still run, risky ones and ask rules are blocked', async () => {
    const { ctx, asked } = makeCtx({ approvals: false, permissions: empty() })
    expect((await run('run_command', { command: 'node quick.js' }, ctx)).stdout).toContain('ran')
    await expect(run('run_command', { command: 'node -e 1' }, ctx)).rejects.toThrow(/blocked \(DESTRUCTIVE\)/)
    const askRule = makeCtx({ approvals: false, permissions: { user: {}, project: { ask: ['node'] } } })
    await expect(run('run_command', { command: 'node quick.js' }, askRule.ctx)).rejects.toThrow(/blocked \(EXECUTE\)/)
    expect(asked).toHaveLength(0)
  })

  it('hosts without permissions keep the old behaviour', async () => {
    const { ctx, asked } = makeCtx({ approvals: true, answer: false })
    expect((await run('run_command', { command: 'node quick.js' }, ctx)).stdout).toContain('ran')
    expect(asked).toHaveLength(0)
  })

  it('deny rules refuse even with approvals on', async () => {
    const { ctx, asked } = makeCtx({ approvals: true, answer: true, permissions: { user: {}, project: { deny: ['node quick.js'] } } })
    await expect(run('run_command', { command: 'node quick.js' }, ctx)).rejects.toThrow(/denied: .*project deny rule/)
    expect(asked).toHaveLength(0)
  })

  it('write rules: deny refuses, ask needs approval, user allow skips the review', async () => {
    const permissions: PermissionPolicy = { user: { allow: [{ write: 'docs/**' }] }, project: { deny: [{ write: 'secrets/**' }], ask: [{ write: '*.lock' }] } }
    const { ctx } = makeCtx({ approvals: false, permissions })
    await expect(run('write_file', { path: 'secrets/key.txt', content: 'x' }, ctx)).rejects.toThrow(/denied: changing secrets\/key.txt/)
    expect(existsSync(path.join(root, 'secrets', 'key.txt'))).toBe(false)
    await expect(run('write_file', { path: 'deps.lock', content: 'x' }, ctx)).rejects.toThrow(/blocked: changing deps.lock/)
    let reviewed = 0
    ctx.reviewChange = () => {
      reviewed++
      return Promise.resolve(true)
    }
    await run('write_file', { path: 'docs/a.md', content: 'x' }, ctx)
    await run('write_file', { path: 'src/a.ts', content: 'x' }, ctx)
    expect(reviewed).toBe(1)
  })
})
