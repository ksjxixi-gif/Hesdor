import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, undoLastChange } from './index.js'
import type { ToolContext } from './context.js'
import { parseV4A, usesV4APatch } from './tools/patch-v4a.js'

function setup(files: Record<string, string>, review?: ToolContext['reviewChange']): { ctx: ToolContext; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-v4a-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  return {
    root,
    ctx: {
      root,
      mode: 'build',
      model: 'gpt-6.1-sol',
      signal: new AbortController().signal,
      emit: () => {},
      requestApproval: () => Promise.resolve(true),
      approvalsEnabled: true,
      ...(review ? { reviewChange: review } : {}),
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

const registry = createDefaultRegistry().forModel('gpt-6.1-sol')
const patch = (ctx: ToolContext, input: string) => registry.get('apply_patch')!.execute({ input }, ctx)
const read = (root: string, name: string) => readFileSync(path.join(root, name), 'utf8')

const SRC = 'function a() {\n  return 1\n}\n\nfunction b() {\n  return 1\n}\n'

describe('V4A apply_patch', () => {
  it('adds, updates, deletes and moves files in one patch', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC, 'old.ts': 'bye\n', 'mv.ts': 'x\ny\n' })
    const out = await patch(
      ctx,
      [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+hello',
        '+world',
        '*** Update File: a.ts',
        '@@ function b() {',
        '-  return 1',
        '+  return 2',
        '*** Delete File: old.ts',
        '*** Update File: mv.ts',
        '*** Move to: moved/mv.ts',
        ' x',
        '-y',
        '+z',
        '*** End Patch',
      ].join('\n'),
    )
    expect(read(root, 'src/new.ts')).toBe('hello\nworld\n')
    expect(read(root, 'a.ts')).toBe(SRC.replace('function b() {\n  return 1', 'function b() {\n  return 2'))
    expect(existsSync(path.join(root, 'old.ts'))).toBe(false)
    expect(existsSync(path.join(root, 'mv.ts'))).toBe(false)
    expect(read(root, 'moved/mv.ts')).toBe('x\nz\n')
    expect(out).toContain('M a.ts')
    expect(ctx.state.snapshots).toHaveLength(5) // add, update, delete, move dest + source
  })

  it('applies several hunks in order and strips a heredoc wrapper', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC })
    await patch(
      ctx,
      ['apply_patch <<"EOF"', '*** Begin Patch', '*** Update File: a.ts', '@@', ' function a() {', '-  return 1', '+  return 10', '@@', ' function b() {', '-  return 1', '+  return 20', '*** End Patch', 'EOF'].join('\n'),
    )
    expect(read(root, 'a.ts')).toBe(SRC.replace('return 1', 'return 10').replace(/return 1\n}\n$/, 'return 20\n}\n'))
  })

  it('writes nothing when one hunk does not match, and points to write_file on the second failure', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC, 'b.ts': 'keep\n' })
    const bad = ['*** Begin Patch', '*** Update File: b.ts', '-keep', '+changed', '*** Update File: a.ts', '-  return 99', '+  return 3', '*** End Patch'].join('\n')
    await expect(patch(ctx, bad)).rejects.toThrow(/not found/)
    expect(read(root, 'b.ts')).toBe('keep\n')
    expect(read(root, 'a.ts')).toBe(SRC)
    await expect(patch(ctx, bad)).rejects.toThrow(/write_file/)
  })

  it('keeps CRLF line endings and the BOM', async () => {
    const { ctx, root } = setup({ 'w.ts': '﻿one\r\ntwo\r\nthree\r\n' })
    await patch(ctx, ['*** Begin Patch', '*** Update File: w.ts', ' one', '-two', '+2', '+2b', '*** End Patch'].join('\n'))
    expect(read(root, 'w.ts')).toBe('﻿one\r\n2\r\n2b\r\nthree\r\n')
  })

  it('matches context that differs only in whitespace, and an end-of-file hunk', async () => {
    const { ctx, root } = setup({ 'a.ts': 'x\n    y   \nx\n' })
    await patch(ctx, ['*** Begin Patch', '*** Update File: a.ts', '  y', '-x', '+END', '*** End of File', '*** End Patch'].join('\n'))
    expect(read(root, 'a.ts')).toBe('x\n    y   \nEND\n')
  })

  it('refuses .git paths and paths outside the repository', async () => {
    const { ctx } = setup({ 'a.ts': SRC })
    await expect(patch(ctx, '*** Begin Patch\n*** Add File: .git/hooks/pre-commit\n+evil\n*** End Patch')).rejects.toThrow(/\.git/)
    await expect(patch(ctx, '*** Begin Patch\n*** Add File: ../x.ts\n+x\n*** End Patch')).rejects.toThrow(/outside/)
  })

  it('writes nothing when the user rejects one file of the patch', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC, 'b.ts': 'keep\n' }, async (req) => req.path !== 'b.ts')
    const p = ['*** Begin Patch', '*** Update File: a.ts', '-function a() {', '+function A() {', '*** Update File: b.ts', '-keep', '+gone', '*** End Patch'].join('\n')
    await expect(patch(ctx, p)).rejects.toThrow(/rejected/)
    expect(read(root, 'a.ts')).toBe(SRC)
    expect(read(root, 'b.ts')).toBe('keep\n')
  })

  it('refuses a file that changed since it was read', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC })
    await createDefaultRegistry().get('read_file')!.execute({ path: 'a.ts' }, ctx)
    writeFileSync(path.join(root, 'a.ts'), `${SRC}// more\n`)
    await expect(patch(ctx, '*** Begin Patch\n*** Update File: a.ts\n-function a() {\n+function A() {\n*** End Patch')).rejects.toThrow(/changed since you read it/)
  })

  it('undo restores each file', async () => {
    const { ctx, root } = setup({ 'a.ts': SRC })
    await patch(ctx, '*** Begin Patch\n*** Update File: a.ts\n-function a() {\n+function A() {\n*** End Patch')
    await undoLastChange(ctx)
    expect(read(root, 'a.ts')).toBe(SRC)
  })

  it('rejects malformed patches', () => {
    expect(() => parseV4A('*** Update File: a.ts\n-x')).toThrow(/Begin Patch/)
    expect(() => parseV4A('*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch')).toThrow(/must start with "\+"/)
    expect(() => parseV4A('*** Begin Patch\n*** Update File: a\n-x\n')).toThrow(/End Patch/)
  })
})

describe('apply_patch format per model', () => {
  const schemaOf = (model: string) =>
    JSON.stringify(createDefaultRegistry().forModel(model).specs().find((s) => s.name === 'apply_patch')!.parametersJsonSchema)

  it('gives OpenAI GPT-5+/Codex models V4A and keeps find/replace for the rest', () => {
    for (const m of ['gpt-6.1-sol', 'gpt-5', 'openai/gpt-5.5', 'gpt-5.3-codex', 'codex-mini-latest']) expect(usesV4APatch(m)).toBe(true)
    for (const m of ['claude-sonnet-5-5', 'grok-5', 'gpt-4.1', 'openai/gpt-oss-120b', 'gemini-3.8-flash']) expect(usesV4APatch(m)).toBe(false)
    expect(schemaOf('gpt-6.1-sol')).toContain('"input"')
    expect(schemaOf('claude-sonnet-5-5')).toContain('"edits"')
  })

  it('keeps the same sorted tool names and a byte-stable list for one model', () => {
    const a = createDefaultRegistry().forModel('gpt-6.1-sol').specs()
    const b = createDefaultRegistry().forModel('gpt-6.1-sol').specs()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.map((s) => s.name)).toEqual(createDefaultRegistry().specs().map((s) => s.name))
  })
})

describe('editedPaths', () => {
  it('reads a plain path or the file headers of a V4A patch', async () => {
    const { editedPaths } = await import('./loop.js')
    expect(editedPaths({ path: 'a.ts' })).toEqual(['a.ts'])
    const input = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: b.md\n+hi\n*** End Patch'
    expect(editedPaths({ input })).toEqual(['src/a.ts', 'b.md'])
    expect(editedPaths({ command: 'ls' })).toEqual([])
  })
})
