import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ModelProvider, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { parseArgs } from './args.js'
import type { CliFlags } from './args.js'
import { runHeadless } from './headless.js'
import { capDiff, parseFindings, reviewDiff, runReview } from './review.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []
  constructor(private readonly steps: StreamChunk[][]) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    for (const chunk of step) yield chunk
  }
}
const usage = { inputTokens: 10, outputTokens: 1, totalTokens: 11, ready: true }
const answer = (text: string): StreamChunk[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop', usage }]
const call = (name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id: 'c1', name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls', usage },
]
const flags = (extra: Partial<CliFlags> = {}): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, ...extra })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })

/** main: a.txt; feature (checked out): b.txt committed on top. */
function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-review-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'feature')
  writeFileSync(path.join(repo, 'b.txt'), 'feature line\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'feature')
  return repo
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const code = await fn()
  vi.restoreAllMocks()
  return { code, out: out.join('') }
}

afterEach(() => vi.restoreAllMocks())

const findingsJson = (priority: string) =>
  `Looks mostly fine.\n\`\`\`json\n${JSON.stringify({ summary: 'One issue.', findings: [{ priority, file: 'b.txt', line: 1, title: 'Bad line', explanation: 'why', suggestion: 'fix' }] })}\n\`\`\``

describe('review diff selection', () => {
  it('diffs HEAD against the merge base with --base, defaulting to main', async () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(path.join(repo, 'main-only.txt'), 'later on main\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'main moves on')
    git(repo, 'checkout', '-q', 'feature')
    for (const base of ['main', undefined]) {
      const d = await reviewDiff(repo, base ? { base } : {})
      expect(d.target).toMatch(/^main \(merge base [0-9a-f]{12}\)$/)
      expect(d.diff).toContain('+feature line')
      expect(d.diff).not.toContain('main-only')
    }
  })

  it('--uncommitted covers tracked edits and lists untracked files', async () => {
    const repo = makeRepo()
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    writeFileSync(path.join(repo, 'new.txt'), 'x\n')
    const d = await reviewDiff(repo, { uncommitted: true })
    expect(d.diff).toContain('+changed')
    expect(d.diff).not.toContain('feature line')
    expect(d.untracked).toEqual(['new.txt'])
  })

  it('caps a large diff and summarizes the remaining files', () => {
    const file = (n: string, lines: number) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n${'+x\n'.repeat(lines)}`
    const capped = capDiff(file('small.ts', 2) + file('big.ts', 500), 200)
    expect(capped).toContain('diff --git a/small.ts')
    expect(capped).toContain('big.ts (+500 -0)')
    expect(capped).not.toContain('diff --git a/big.ts')
  })

  it('parses the last json block and sorts by priority', () => {
    const parsed = parseFindings('```json\n{"findings":[]}\n```\n```json\n{"summary":"s","findings":[{"priority":"p3","file":"x"},{"priority":"P0","file":"y","line":2},{"priority":"high"}]}\n```')
    expect(parsed?.findings.map((f) => f.priority)).toEqual(['P0', 'P1', 'P3'])
    expect(parsed?.findings[0]).toMatchObject({ file: 'y', line: 2 })
    expect(parseFindings('no json here')).toBeNull()
  })
})

describe('hesdor review', () => {
  it('sends the diff read-only and exits 5 on a finding at the threshold (json schema)', async () => {
    const repo = makeRepo()
    const provider = new ScriptedProvider([answer(findingsJson('P1'))])
    const outFile = path.join(repo, 'review.md')
    const { code, out } = await capture(() => runReview('', flags({ outputFormat: 'json', outputFile: outFile }), { provider, cwd: repo }))
    expect(code).toBe(5)
    const prompt = provider.requests[0]!.find((m) => m.role === 'user')!.content
    expect(prompt).toContain('+feature line')
    expect(provider.requests[0]![0]!.content).toMatch(/ask/i) // ask-mode system prompt
    const r = JSON.parse(out.trim()) as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual(
      ['blocking', 'cost_usd', 'error', 'error_category', 'findings', 'session_id', 'severity', 'status', 'steps', 'summary', 'target', 'type', 'usage'].sort(),
    )
    expect(r).toMatchObject({ type: 'review', status: 'completed', severity: 'P1', blocking: 1, summary: 'One issue.', error: null })
    expect(r.findings).toEqual([{ priority: 'P1', file: 'b.txt', line: 1, title: 'Bad line', explanation: 'why', suggestion: 'fix' }])
    expect(readFileSync(outFile, 'utf8')).toContain('**P1** `b.txt:1` Bad line')
  })

  it('exits 0 when findings are below --severity, 1 on an unparsable answer, 1 outside git', async () => {
    const repo = makeRepo()
    const below = await capture(() => runReview('', flags({ severity: 'P0' }), { provider: new ScriptedProvider([answer(findingsJson('P2'))]), cwd: repo }))
    expect(below.code).toBe(0)
    expect(below.out).toContain('0 finding(s) at or above P0')

    const garbled = await capture(() => runReview('', flags({ outputFormat: 'json' }), { provider: new ScriptedProvider([answer('all good!')]), cwd: repo }))
    expect(garbled.code).toBe(1)
    expect(JSON.parse(garbled.out)).toMatchObject({ type: 'review', status: 'failed', error_category: 'parse' })

    const plain = mkdtempSync(path.join(tmpdir(), 'hesdor-nogit-'))
    const outside = await capture(() => runReview('', flags({ outputFormat: 'json' }), { provider: new ScriptedProvider([]), cwd: plain }))
    expect(outside.code).toBe(1)
    expect(JSON.parse(outside.out)).toMatchObject({ type: 'review', status: 'failed', error_category: 'workspace' })
  })

  it('makes no model call when there is nothing to review', async () => {
    const repo = makeRepo()
    const provider = new ScriptedProvider([])
    const { code } = await capture(() => runReview('', flags({ uncommitted: true }), { provider, cwd: repo }))
    expect(code).toBe(0)
    expect(provider.requests).toHaveLength(0)
  })
})

describe('flags', () => {
  it('parses review and --worktree flags', () => {
    expect(parseArgs(['review', '--base', 'origin/dev', '--severity', 'p2', 'auth'])).toMatchObject({ command: 'review', prompt: 'auth', flags: { base: 'origin/dev', severity: 'P2' } })
    expect(parseArgs(['run', '--worktree=w1', 'fix it'])).toMatchObject({ prompt: 'fix it', flags: { worktree: 'w1' } })
    expect(parseArgs(['run', '--worktree', 'cleanup'])).toMatchObject({ prompt: 'cleanup', flags: { worktree: '' } })
    expect(() => parseArgs(['run', '--worktree=../x', 'go'])).toThrow(/invalid worktree name/)
    expect(() => parseArgs(['review', '--base', '--output=x'])).toThrow(/invalid --base/)
    expect(() => parseArgs(['review', '--worktree'])).toThrow(/run, ask and plan/)
  })
})

describe('--worktree', () => {
  it('runs in a new worktree on hesdor/<name>, keeps it when changed and leaves the main checkout alone', async () => {
    const repo = makeRepo()
    const provider = new ScriptedProvider([call('write_file', { path: 'made.txt', content: 'hi\n' }), answer('done')])
    const { code } = await capture(() => runHeadless('build', 'make a file', flags({ yes: true, worktree: 'w1' }), { provider, cwd: repo }))
    expect(code).toBe(0)
    const wt = path.join(repo, '.hesdor', 'worktrees', 'w1')
    expect(readFileSync(path.join(wt, 'made.txt'), 'utf8')).toBe('hi\n')
    expect(existsSync(path.join(repo, 'made.txt'))).toBe(false)
    expect(git(wt, 'branch', '--show-current').trim()).toBe('hesdor/w1')
    expect(git(repo, 'status', '--porcelain')).toBe('') // .hesdor/worktrees is ignored
  })

  it('removes an unchanged worktree and its branch; refuses outside git', async () => {
    const repo = makeRepo()
    const { code } = await capture(() => runHeadless('ask', 'hi', flags({ worktree: 'w2' }), { provider: new ScriptedProvider([answer('ok')]), cwd: repo }))
    expect(code).toBe(0)
    expect(existsSync(path.join(repo, '.hesdor', 'worktrees', 'w2'))).toBe(false)
    expect(git(repo, 'branch', '--list', 'hesdor/w2').trim()).toBe('')

    const plain = mkdtempSync(path.join(tmpdir(), 'hesdor-nogit-'))
    const outside = await capture(() => runHeadless('ask', 'hi', flags({ worktree: '', outputFormat: 'json' }), { provider: new ScriptedProvider([]), cwd: plain }))
    expect(outside.code).toBe(1)
    expect(outside.out).toContain('--worktree needs a Git repository')
  })
})
