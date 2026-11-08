import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModelProvider, StreamChunk } from '@hesdor/protocol'
import type { ToolContext } from './context.js'
import type { ChecksConfig } from './checks.js'
import { newProblems, resolveChecks } from './checks.js'
import { runAgentLoop } from './loop.js'
import { createDefaultRegistry } from './registry.js'
import { applyPatchTool, writeFileTool } from './tools/fs.js'
import { applyPatchV4ATool } from './tools/patch-v4a.js'
import { filterArgs, parseFailures, runTestsTool } from './tools/tests.js'
import { undoLastChange } from './undo.js'

/** Fake tools as node scripts, so the tests need no prettier, eslint or tsc. */
const FORMATTER = `import { readFileSync, writeFileSync } from 'node:fs'
const f = process.argv.at(-1)
writeFileSync(f, readFileSync(f, 'utf8').replace(/\\r\\n/g, '\\n').replace(/[ \\t]+$/gm, ''))`
const LINTER = `import { readFileSync } from 'node:fs'
const f = process.argv[2]
readFileSync(f, 'utf8').split(/\\r?\\n/).forEach((l, i) => { if (l.includes('TODO')) console.log(f + ':' + (i + 1) + ':1 warning no-todo: ' + l.trim()) })`
const COUNTER = `import { appendFileSync } from 'node:fs'
appendFileSync('runs.txt', 'x')`

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-checks-'))
  for (const [rel, text] of Object.entries({ 'fmt.mjs': FORMATTER, 'lint.mjs': LINTER, 'count.mjs': COUNTER, ...files })) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

function ctxFor(root: string, checks?: ChecksConfig, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    mode: 'build',
    model: 'm',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(true),
    approvalsEnabled: true,
    state: { activeChild: null, snapshots: [], redo: [] },
    ...(checks ? { checks } : {}),
    ...extra,
  }
}

const exec = (tool: unknown, input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> =>
  (tool as { execute: (i: unknown, c: ToolContext) => Promise<Record<string, unknown>> }).execute(input, ctx)

/** A node_modules/.bin shim the way npm/pnpm install one (.cmd on Windows). */
function shim(root: string, name: string): void {
  const dir = path.join(root, 'node_modules', '.bin')
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') writeFileSync(path.join(dir, `${name}.cmd`), '@node "%~dp0..\\..\\fmt.mjs" %*\r\n')
  else {
    writeFileSync(path.join(dir, name), '#!/bin/sh\nexec node "$(dirname "$0")/../../fmt.mjs" "$@"\n')
    chmodSync(path.join(dir, name), 0o755)
  }
}

const FORMAT = ['node', 'fmt.mjs', '{file}']
const LINT = ['node', 'lint.mjs', '{file}']

describe('resolveChecks', () => {
  it('detects installed and configured tools and the test runner; config overrides per kind', async () => {
    const root = repo({
      '.prettierrc': '{}',
      'eslint.config.js': 'export default []',
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    })
    for (const n of ['prettier', 'eslint', 'tsc']) shim(root, n)
    const found = await resolveChecks(root)
    expect(found.checks.map((c) => `${c.kind}:${c.name}`)).toEqual(['format:prettier', 'lint:eslint', 'typecheck:tsc'])
    expect(found.test).toMatchObject({ kind: 'vitest', argv: ['pnpm', 'test'] })

    const own = await resolveChecks(root, { lint: [], format: FORMAT, test: ['pytest', '-x'] })
    expect(own.checks.map((c) => `${c.kind}:${c.name}`)).toEqual(['format:node', 'typecheck:tsc'])
    expect(own.test).toMatchObject({ kind: 'pytest', source: 'checks.test' })
  })

  it('never uses node_modules/.bin tools the repository itself commits', async () => {
    const root = repo({ '.prettierrc': '{}' })
    shim(root, 'prettier')
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-f', 'node_modules/.bin'], { cwd: root })
    expect((await resolveChecks(root)).checks).toEqual([])
  })

  it('detects nothing in a bare directory and needs a prettier config before formatting', async () => {
    const root = repo()
    shim(root, 'prettier')
    expect(await resolveChecks(root)).toMatchObject({ checks: [] })
    expect((await resolveChecks(root)).test).toBeUndefined()
  })
})

describe('post-edit checks', () => {
  it('formats after write_file, keeps the stamp fresh, and /undo restores the pre-edit file', async () => {
    const root = repo({ 'a.ts': 'old\n' })
    const ctx = ctxFor(root, { format: FORMAT })
    const res = await exec(writeFileTool, { path: 'a.ts', content: 'const x = 1   \n' }, ctx)
    expect(res.formatted).toContain('reformatted a.ts')
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('const x = 1\n')
    // The formatted file is the known state: apply_patch is not refused as stale.
    await exec(applyPatchTool, { path: 'a.ts', edits: [{ find: 'x = 1', replace: 'x = 2' }] }, ctx)
    await undoLastChange(ctx)
    await undoLastChange(ctx)
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('old\n')
  })

  it('a formatter detected in node_modules/.bin runs through its shim', async () => {
    const root = repo({ '.prettierrc': '{}', 'a.ts': '' })
    shim(root, 'prettier')
    const res = await exec(writeFileTool, { path: 'a.ts', content: 'x  \n' }, ctxFor(root))
    expect(res.formatted).toContain('prettier')
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('x\n')
  })

  it('keeps CRLF when the formatter writes LF', async () => {
    const root = repo({ 'a.ts': 'a\r\nb\r\n' })
    await exec(writeFileTool, { path: 'a.ts', content: 'a  \r\nc\r\n' }, ctxFor(root, { format: FORMAT }))
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('a\r\nc\r\n')
  })

  it('reports only lint problems the edit added', async () => {
    const root = repo({ 'a.ts': 'one // TODO old\ntwo\n' })
    const ctx = ctxFor(root, { lint: LINT })
    const res = await exec(applyPatchTool, { path: 'a.ts', edits: [{ find: 'two', replace: 'zero\ntwo // TODO new' }] }, ctx)
    expect(res.checks).toBe('lint (node) new problems in a.ts:\na.ts:3:1 warning no-todo: two // TODO new')
    const again = await exec(applyPatchTool, { path: 'a.ts', edits: [{ find: 'zero\n', replace: '' }] }, ctx)
    expect(again.checks).toBeUndefined() // lines moved, nothing new
  })

  it('a deny rule turns a check off', async () => {
    const root = repo({ 'a.ts': '' })
    const permissions = { user: {}, project: { deny: ['node fmt.mjs'] } }
    const res = await exec(writeFileTool, { path: 'a.ts', content: 'x  \n' }, ctxFor(root, { format: FORMAT }, { permissions }))
    expect(res.formatted).toBeUndefined()
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('x  \n')
  })

  it('runs a whole-project check once per turn', async () => {
    const root = repo()
    const ctx = ctxFor(root, { typecheck: ['node', 'count.mjs'] })
    await exec(writeFileTool, { path: 'a.ts', content: '1' }, ctx)
    await exec(writeFileTool, { path: 'b.ts', content: '2' }, ctx)
    expect(readFileSync(path.join(root, 'runs.txt'), 'utf8')).toBe('x')
    await exec(writeFileTool, { path: 'c.ts', content: '3' }, { ...ctx, signal: new AbortController().signal }) // next turn
    expect(readFileSync(path.join(root, 'runs.txt'), 'utf8')).toBe('xx')
  })

  it('formats every file a V4A patch adds or updates', async () => {
    const root = repo({ 'a.ts': 'a\n' })
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '-a', '+a  ', '*** Add File: b.ts', '+b  ', '*** End Patch'].join('\n')
    const out = await exec(applyPatchV4ATool, { input: patch }, ctxFor(root, { format: FORMAT }))
    expect(String(out)).toContain('reformatted a.ts')
    expect(String(out)).toContain('reformatted b.ts')
    expect(readFileSync(path.join(root, 'b.ts'), 'utf8')).toBe('b\n')
  })

  it('newProblems ignores moved line numbers and counts duplicates', () => {
    expect(newProblems(['a.ts:5:1 x', 'a.ts:9:1 x', 'a.ts:2:1 y'], ['a.ts:4:1 x'])).toEqual(['a.ts:9:1 x', 'a.ts:2:1 y'])
  })
})

describe('run_tests', () => {
  it('parses failures from vitest, jest, pytest, go, cargo and node --test output', () => {
    expect(
      parseFailures('vitest', [' FAIL  a.test.ts > math > adds', 'AssertionError: expected 3 to be 4', '', ' ❯ a.test.ts:4:19']),
    ).toEqual([{ name: 'a.test.ts > math > adds', location: 'a.test.ts:4:19', message: 'AssertionError: expected 3 to be 4' }])
    expect(
      parseFailures('jest', ['  ● math › adds', '', '    expect(received).toBe(expected)', '      at Object.<anonymous> (src/a.test.js:4:13)', '  ● Console']),
    ).toEqual([{ name: 'math › adds', location: 'src/a.test.js:4:13', message: 'expect(received).toBe(expected)' }])
    expect(
      parseFailures('pytest', ['____ test_add ____', 'tests/test_a.py:3: AssertionError', 'FAILED tests/test_a.py::test_add - assert 3 == 4']),
    ).toEqual([{ name: 'tests/test_a.py::test_add', location: 'tests/test_a.py:3', message: 'assert 3 == 4' }])
    expect(parseFailures('go', ['--- FAIL: TestAdd (0.00s)', '    a_test.go:8: got 3 want 4'])).toEqual([
      { name: 'TestAdd', location: 'a_test.go:8', message: 'got 3 want 4' },
    ])
    expect(parseFailures('cargo', ['---- tests::adds stdout ----', "thread 'tests::adds' panicked at src/lib.rs:9:9:", 'assertion failed'])).toEqual([
      { name: 'tests::adds', location: 'src/lib.rs:9:9', message: 'assertion failed' },
    ])
    expect(parseFailures('node', ['✖ failing tests:', '', 'test at n.test.mjs:3:1', '✖ adds (1.37ms)', '  AssertionError: 3 !== 4'])).toEqual([
      { name: 'adds', location: 'n.test.mjs:3:1', message: 'AssertionError: 3 !== 4' },
    ])
    // Node 22 prints TAP when stdout is not a terminal (captured from `node --test --test-reporter=tap`).
    const tap = [
      'TAP version 13', '# Subtest: adds', 'not ok 1 - adds', '  ---', '  duration_ms: 1.378', "  type: 'test'",
      "  location: 'C:\\\\repo\\\\n.test.mjs:3:1'", "  failureType: 'testCodeFailure'", '  error: |-',
      '    Expected values to be strictly equal:', '    ', '    3 !== 4', "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'",
      '  expected: 4', '  ...', '# Subtest: ok', 'ok 2 - ok', '  ---', '  ...', '1..2',
    ]
    expect(parseFailures('node', tap)).toEqual([
      { name: 'adds', location: 'C:\\repo\\n.test.mjs:3:1', message: 'AssertionError: Expected values to be strictly equal:' },
    ])
  })

  it('puts filters in each runner syntax, after -- for npm', () => {
    expect(filterArgs({ kind: 'vitest', argv: ['npm', 'test'], source: '' }, 'a.test.ts', 'adds')).toEqual(['--', 'a.test.ts', '-t', 'adds'])
    expect(filterArgs({ kind: 'go', argv: ['go', 'test'], source: 'go.mod' }, 'pkg/a_test.go')).toEqual(['./pkg'])
    expect(filterArgs({ kind: 'go', argv: ['go', 'test'], source: 'go.mod' }, undefined, 'TestA')).toEqual(['./...', '-run', 'TestA'])
  })

  it('runs the configured runner and returns structured failures', async () => {
    const root = repo({
      'n.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.strictEqual(1 + 2, 4))\ntest('ok', () => {})\n",
    })
    const res = await exec(runTestsTool, { path: 'n.test.mjs' }, ctxFor(root, { test: ['node', '--test'] }))
    expect(res.result).toBe('failed')
    expect(res.failures).toEqual([expect.stringMatching(/^n\.test\.mjs:3:\d+ adds: AssertionError/)])
    await expect(exec(runTestsTool, { name: '--evil' }, ctxFor(root, { test: ['node', '--test'] }))).rejects.toThrow('must not start')
    await expect(exec(runTestsTool, {}, ctxFor(repo()))).rejects.toThrow('no test runner found')
  })

  it('nudges once per run after an edit when a test runner exists', async () => {
    const root = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
    const call = (id: string, file: string): StreamChunk[] => [
      { type: 'tool_call', index: 0, id, name: 'write_file', argumentsDelta: JSON.stringify({ path: file, content: 'x' }) },
      { type: 'finish', reason: 'tool_calls' },
    ]
    const steps = [call('1', 'a.txt'), call('2', 'b.txt'), [{ type: 'text', text: 'done' }, { type: 'finish', reason: 'stop' }] as StreamChunk[]]
    const provider: ModelProvider = {
      name: 'p',
      model: 'm',
      async *stream() {
        for (const c of steps.shift()!) yield c
      },
    }
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx: ctxFor(root), systemPrompt: '', userPrompt: 'go' })
    const results = result.messages.filter((m) => m.role === 'tool_result')
    expect(results.map((m) => String(m.content).includes('run_tests'))).toEqual([true, false])
  })
})
