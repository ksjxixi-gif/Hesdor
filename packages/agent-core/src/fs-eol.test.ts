import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, undoLastChange } from './index.js'
import type { ToolContext } from './context.js'

function setup(name: string, content: string): { ctx: ToolContext; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-eol-'))
  const file = path.join(root, name)
  writeFileSync(file, content)
  return {
    file,
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

const registry = createDefaultRegistry()
const patch = (ctx: ToolContext, edits: Array<{ find: string; replace: string }>, p = 'a.ts') =>
  registry.get('apply_patch')!.execute({ path: p, edits }, ctx)

const CRLF = 'line one\r\nline two\r\nline three\r\n'

describe('line endings and BOM', () => {
  it('applies a multi-line LF patch to a CRLF file and keeps CRLF everywhere', async () => {
    const { ctx, file } = setup('a.ts', CRLF)
    await patch(ctx, [{ find: 'line one\nline two', replace: 'first\nsecond\nextra' }])
    expect(readFileSync(file, 'utf8')).toBe('first\r\nsecond\r\nextra\r\nline three\r\n')
  })

  it('accepts CRLF find text against a CRLF file', async () => {
    const { ctx, file } = setup('a.ts', CRLF)
    await patch(ctx, [{ find: 'two\r\nline three', replace: '2\r\n3' }])
    expect(readFileSync(file, 'utf8')).toBe('line one\r\nline 2\r\n3\r\n')
  })

  it('preserves a UTF-8 BOM and matches text at the start of the file', async () => {
    const { ctx, file } = setup('a.ts', '﻿line one\r\nline two\r\n')
    await patch(ctx, [{ find: 'line one\nline', replace: 'top\nline' }])
    expect(readFileSync(file, 'utf8')).toBe('﻿top\r\nline two\r\n')
  })

  it('leaves LF files byte-for-byte as before, including literal $ sequences', async () => {
    const { ctx, file } = setup('a.ts', 'a\nb\nc\n')
    await patch(ctx, [{ find: 'a\nb', replace: "x $& $' $$" }])
    expect(readFileSync(file, 'utf8')).toBe("x $& $' $$\nc\n")
  })

  it('write_file over a CRLF+BOM file keeps its format; new files are written as given', async () => {
    const { ctx, file } = setup('a.ts', '﻿old\r\nfile\r\n')
    await registry.get('write_file')!.execute({ path: 'a.ts', content: 'new\ncontent\n' }, ctx)
    expect(readFileSync(file, 'utf8')).toBe('﻿new\r\ncontent\r\n')

    await registry.get('write_file')!.execute({ path: 'fresh.ts', content: 'x\ny\n' }, ctx)
    expect(readFileSync(path.join(ctx.root, 'fresh.ts'), 'utf8')).toBe('x\ny\n')
  })

  it('undo after a CRLF patch restores the exact original bytes', async () => {
    const original = '﻿keep\r\nchange me\r\nend'
    const { ctx, file } = setup('a.ts', original)
    await patch(ctx, [{ find: 'keep\nchange me', replace: 'keep\nchanged' }])
    expect(readFileSync(file, 'utf8')).toBe('﻿keep\r\nchanged\r\nend')
    await undoLastChange(ctx)
    expect(readFileSync(file)).toEqual(Buffer.from(original, 'utf8'))
  })

  it('shows the review gate the bytes that will actually be written', async () => {
    const { ctx } = setup('a.ts', CRLF)
    let after: string | null = null
    ctx.reviewChange = (req) => {
      after = req.after
      return Promise.resolve(true)
    }
    await patch(ctx, [{ find: 'line three', replace: 'three' }])
    expect(after).toBe('line one\r\nline two\r\nthree\r\n')
  })
})
