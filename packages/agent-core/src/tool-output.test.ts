import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@hesdor/protocol'
import { PRUNED, pruneToolResults } from './compact.js'
import type { ToolContext } from './context.js'
import { createDefaultRegistry } from './registry.js'
import { capOutput, formatToolResult } from './tool-output.js'

function ctxFor(root: string): ToolContext {
  return {
    root,
    mode: 'ask',
    model: 'test',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(false),
    approvalsEnabled: false,
    state: { activeChild: null, snapshots: [], redo: [] },
  }
}

describe('formatToolResult', () => {
  it('renders objects as plain text: scalars as key lines, multi-line text and arrays as blocks', () => {
    const text = formatToolResult('run_command', { command: 'npm test', exitCode: 1, timedOut: false, stdout: 'a\nb', stderr: '' })
    expect(text).toBe('command: npm test\nexitCode: 1\ntimedOut: false\nstderr: (empty)\nstdout:\na\nb')
    expect(formatToolResult('search_files', { pattern: 'x', matches: [{ file: 'a.ts', line: 3, text: 'x()' }], truncated: false })).toBe(
      'pattern: x\ntruncated: false\nmatches (1):\na.ts:3: x()',
    )
    expect(formatToolResult('git_diff', { diff: 'diff --git a b' })).toBe('diff --git a b')
    expect(formatToolResult('explore', 'answer')).toBe('answer')
  })

  it('numbers read_file lines cat -n style and says how to continue', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-fmt-'))
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n')
    const read = createDefaultRegistry().get('read_file')!
    const res = await read.execute({ path: 'a.txt', offset: 2, limit: 1 }, ctxFor(root))
    expect(formatToolResult('read_file', res)).toBe('a.txt (lines 2-2 of 3)\n2\ttwo\n[… 1 more lines; read_file with offset 3 continues …]')
  })

  it('gives every file in read_files a fair share of the budget', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-fair-'))
    writeFileSync(path.join(root, 'big.txt'), `${Array.from({ length: 1500 }, (_, i) => `line ${i} ${'y'.repeat(80)}`).join('\n')}\n`)
    writeFileSync(path.join(root, 'small.txt'), 'tiny\n')
    const res = (await createDefaultRegistry().get('read_files')!.execute({ paths: ['big.txt', 'small.txt'] }, ctxFor(root))) as {
      files: Array<{ path: string; truncated?: boolean; content?: string }>
    }
    expect(res.files[0]!.truncated).toBe(true)
    expect(res.files[1]).toMatchObject({ path: 'small.txt', content: 'tiny', truncated: false })
    const text = formatToolResult('read_files', res)
    expect(text).toContain('small.txt (lines 1-1 of 1)\n1\ttiny')
    expect(text.length).toBeLessThan(70 * 1024)
  })
})

describe('capOutput', () => {
  it('keeps head and tail, marks the cut, and spills the full text to .hesdor/out', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-cap-'))
    const full = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join('\n')
    const out = await capOutput(full, root, 'call/1', 2000)
    expect(out.length).toBeLessThan(2200)
    expect(out.startsWith('row 0\n')).toBe(true)
    expect(out.endsWith('row 999')).toBe(true)
    const marker = /\[… (\d+) lines omitted, full output saved to (\.hesdor\/out\/\S+\.txt); read_file it/.exec(out)
    expect(marker).not.toBeNull()
    const kept = out.split('\n').length - 1 // minus the marker line
    expect(Number(marker![1]) + kept).toBe(1000)
    expect(readFileSync(path.join(root, marker![2]!), 'utf8')).toBe(full)
    expect(readFileSync(path.join(root, '.hesdor/out/.gitignore'), 'utf8')).toBe('*\n')
    // The agent can read the spill file back.
    const read = await createDefaultRegistry().get('read_file')!.execute({ path: marker![2]!, offset: 500, limit: 1 }, ctxFor(root))
    expect(read).toMatchObject({ content: 'row 499' })
  })

  it('leaves short output alone', async () => {
    expect(await capOutput('short', '/nonexistent', 'x')).toBe('short')
  })
})

describe('pruneToolResults', () => {
  it('replaces only old tool outputs and keeps every call paired with its result', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 's' }]
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', argumentsJson: '{}' }] })
      msgs.push({ role: 'tool_result', toolCallId: `c${i}`, content: 'z'.repeat(40_000) })
    }
    const { messages, pruned } = pruneToolResults(msgs, 25_000)
    expect(pruned).toBe(3)
    expect(messages.map((m) => m.role)).toEqual(msgs.map((m) => m.role))
    expect(messages.map((m) => m.toolCallId)).toEqual(msgs.map((m) => m.toolCallId))
    expect(messages.filter((m) => m.content === PRUNED).map((m) => m.toolCallId)).toEqual(['c0', 'c1', 'c2'])
    expect(msgs[2]!.content).not.toBe(PRUNED) // the input is not mutated
  })
})
