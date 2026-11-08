import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './context.js'

// The real sandbox exists only on Linux/macOS: stand in a wrapper script that logs and runs the argv.
vi.mock('./sandbox.js', async (orig) => ({
  ...(await orig<typeof import('./sandbox.js')>()),
  wrapCommand: (argv: string[], cfg: unknown) => (cfg ? { argv: ['node', 'wrap.mjs', ...argv], sandboxed: true } : { argv, sandboxed: false }),
}))

const { writeFileTool } = await import('./tools/fs.js')
const { runTestsTool } = await import('./tools/tests.js')

const WRAP = `import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
appendFileSync('wrapped.txt', process.argv.slice(2).join(' ') + '\\n')
process.exit(spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' }).status ?? 1)`
const FORMATTER = `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], readFileSync(process.argv[2], 'utf8').trimEnd() + '\\n')`

describe('checks and run_tests in the sandbox', () => {
  it('wrap check and test commands, and a sandboxed default ask runs without a prompt', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-checks-sb-'))
    writeFileSync(path.join(root, 'wrap.mjs'), WRAP)
    writeFileSync(path.join(root, 'fmt.mjs'), FORMATTER)
    writeFileSync(path.join(root, 'n.test.mjs'), "import test from 'node:test'\ntest('ok', () => {})\n")
    const requestApproval = vi.fn(() => Promise.resolve(false))
    const ctx: ToolContext = {
      root,
      mode: 'build',
      model: 'm',
      signal: new AbortController().signal,
      emit: () => {},
      requestApproval,
      approvalsEnabled: true,
      permissions: { user: {}, project: {} }, // `node --test` is a default ask without the sandbox
      sandbox: { mode: 'workspace-write' },
      checks: { format: ['node', 'fmt.mjs', '{file}'], test: ['node', '--test'] },
      state: { activeChild: null, snapshots: [], redo: [] },
    }
    const exec = (tool: unknown, input: unknown) =>
      (tool as { execute: (i: unknown, c: ToolContext) => Promise<Record<string, unknown>> }).execute(input, ctx)

    expect((await exec(writeFileTool, { path: 'a.ts', content: 'x\n\n\n' })).formatted).toContain('reformatted')
    expect((await exec(runTestsTool, { path: 'n.test.mjs' })).result).toBe('passed')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(readFileSync(path.join(root, 'wrapped.txt'), 'utf8').split('\n')).toEqual(['node fmt.mjs a.ts', 'node --test n.test.mjs', ''])
  })
})
