import { mkdtempSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from './index.js'
import type { ToolContext } from './context.js'

const registry = createDefaultRegistry()
const run = (name: string, input: unknown, ctx: ToolContext) => registry.get(name)!.execute(input, ctx) as Promise<any>

function setup(files: Record<string, string | Buffer>): { ctx: ToolContext; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-fs-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content)
  return {
    root,
    ctx: {
      root,
      mode: 'build',
      model: 'test',
      signal: new AbortController().signal,
      emit: () => {},
      requestApproval: () => Promise.resolve(true),
      approvalsEnabled: true,
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

const SRC = 'function f() {\n    if (x) {\n        call(1)   \n    }\n}\n'

describe('apply_patch whitespace-tolerant fallback', () => {
  it('applies a unique match that differs only in indentation and trailing spaces, keeping the file indentation', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC })
    const res = await run('apply_patch', { path: 'a.ts', edits: [{ find: 'if (x) {\n    call(1)\n}', replace: 'if (y) {\n    call(2)\n}' }] }, ctx)
    expect(res.whitespaceTolerant).toBe(1)
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('function f() {\n    if (y) {\n        call(2)\n    }\n}\n')
  })

  it('refuses an ambiguous tolerant match and names the lines', async () => {
    const { ctx } = setup({ 'a.ts': '  x = 1\n  y\n  x = 1\n' })
    await expect(run('apply_patch', { path: 'a.ts', edits: [{ find: 'x = 1 \n', replace: 'z' }] }, ctx)).rejects.toThrow(
      /matches 2 places \(lines 1, 3\)/,
    )
  })

  it('quotes the nearest lines with line numbers when nothing matches', async () => {
    const { ctx } = setup({ 'a.ts': SRC })
    await expect(
      run('apply_patch', { path: 'a.ts', edits: [{ find: 'if (x) {\n  call(999)\n}', replace: '' }] }, ctx),
    ).rejects.toThrow(/Nearest lines in the file:\n2:     if \(x\) \{\n3:         call\(1\)/)
    // A typo late in a single line still finds the line by its prefix.
    await expect(
      run('apply_patch', { path: 'a.ts', edits: [{ find: 'function f(arg) {', replace: '' }] }, ctx),
    ).rejects.toThrow(/1: function f\(\) \{/)
  })
})

describe('apply_patch freshness check', () => {
  it('refuses a patch when the file changed on disk after the agent read it', async () => {
    const { ctx, root } = setup({ 'a.ts': 'one\ntwo\n' })
    const file = path.join(root, 'a.ts')
    await run('read_file', { path: 'a.ts' }, ctx)
    writeFileSync(file, 'one\ntwo\nthree\n')
    await expect(run('apply_patch', { path: 'a.ts', edits: [{ find: 'two', replace: '2' }] }, ctx)).rejects.toThrow(
      /changed since you read it/,
    )
    // Same size, new mtime still counts as a change.
    await run('read_file', { path: 'a.ts' }, ctx)
    writeFileSync(file, 'ONE\ntwo\nthree\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    await expect(run('apply_patch', { path: 'a.ts', edits: [{ find: 'two', replace: '2' }] }, ctx)).rejects.toThrow(
      /changed since you read it/,
    )
    await run('read_file', { path: 'a.ts' }, ctx)
    await run('apply_patch', { path: 'a.ts', edits: [{ find: 'two', replace: '2' }] }, ctx)
    // The agent's own write refreshes the stamp, so a follow-up patch works without a re-read.
    await run('apply_patch', { path: 'a.ts', edits: [{ find: 'three', replace: '3' }] }, ctx)
    expect(readFileSync(file, 'utf8')).toBe('ONE\n2\n3\n')
  })

  it('does not block files never read in this session', async () => {
    const { ctx } = setup({ 'a.ts': 'one\n' })
    await expect(run('apply_patch', { path: 'a.ts', edits: [{ find: 'one', replace: '1' }] }, ctx)).resolves.toMatchObject({ applied: 1 })
  })
})

describe('read_file limits', () => {
  it('returns a notice for binary files', async () => {
    const { ctx } = setup({ 'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]) })
    expect(await run('read_file', { path: 'img.png' }, ctx)).toMatchObject({ binary: true, bytes: 8, content: '(binary file, not shown)' })
  })

  it('caps by UTF-8 bytes at a line boundary and continues with nextOffset', async () => {
    const line = '漢'.repeat(1000) // 3000 bytes, 1000 UTF-16 units
    const { ctx } = setup({ 'cjk.txt': `${Array.from({ length: 120 }, () => line).join('\n')}\n` })
    const first = await run('read_file', { path: 'cjk.txt' }, ctx)
    expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(first.truncated).toBe(true)
    expect(first.totalLines).toBe(120)
    let shown = first.content.split('\n').length
    expect(first.nextOffset).toBe(shown + 1)
    // Paging with nextOffset reaches every line exactly once.
    let page = first
    while (page.nextOffset) {
      page = await run('read_file', { path: 'cjk.txt', offset: page.nextOffset }, ctx)
      shown += page.content.split('\n').length
    }
    expect(shown).toBe(120)
    expect(page.truncated).toBe(false)
  })

  it('refuses huge files without reading them', async () => {
    const { ctx, root } = setup({ 'big.log': '' })
    truncateSync(path.join(root, 'big.log'), 21 * 1024 * 1024)
    await expect(run('read_file', { path: 'big.log' }, ctx)).rejects.toThrow(/too large for read_file/)
  })
})
