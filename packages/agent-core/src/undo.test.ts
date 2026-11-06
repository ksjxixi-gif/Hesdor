import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, redoLastChange, undoLastChange } from './index.js'
import type { RunEvent } from '@hesdor/protocol'
import type { ToolContext } from './context.js'

function makeCtx(root: string): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = []
  return {
    events,
    ctx: {
      root,
      mode: 'build',
      model: 'test',
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      requestApproval: () => Promise.resolve(true),
      approvalsEnabled: true,
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

describe('undoLastChange', () => {
  it('restores a modified file to its prior content', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-undo-'))
    const registry = createDefaultRegistry()
    const { ctx, events } = makeCtx(root)

    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v1\n' }, ctx)
    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v2\n' }, ctx)
    expect(ctx.state.snapshots).toHaveLength(2)

    const res = await undoLastChange(ctx)
    expect(res.undone).toBe(true)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v1\n')
    expect(events.filter((e) => e.type === 'file.changed').at(-1)).toEqual({
      type: 'file.changed',
      path: 'a.txt',
      op: 'write',
    })
  })

  it('deletes files that were newly created', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-undo2-'))
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx(root)

    await registry.get('write_file')!.execute({ path: 'new.txt', content: 'created' }, ctx)
    await undoLastChange(ctx)

    await expect(import('node:fs/promises').then((fs) => fs.readFile(path.join(root, 'new.txt')))).rejects.toThrow()
  })

  it('reports nothing-to-undo on an empty stack', async () => {
    const { ctx } = makeCtx(mkdtempSync(path.join(tmpdir(), 'hesdor-undo3-')))
    expect((await undoLastChange(ctx)).undone).toBe(false)
  })

  it('redo re-applies an undone change in both directions', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-redo-'))
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx(root)
    const { readFile } = await import('node:fs/promises')

    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v1\n' }, ctx)
    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v2\n' }, ctx)

    await undoLastChange(ctx)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v1\n')

    const redone = await redoLastChange(ctx)
    expect(redone.redone).toBe(true)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v2\n')

    // redo it again: nothing left
    expect((await redoLastChange(ctx)).redone).toBe(false)
    // and the restored v2 state is undoable again
    expect((await undoLastChange(ctx)).undone).toBe(true)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v1\n')
  })

  it('restores binary files byte for byte (overwrite and delete)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-undo-bin-'))
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx(root)
    const { readFile, writeFile } = await import('node:fs/promises')
    // Invalid UTF-8 (0xff, lone continuation bytes) is what a utf8 round-trip corrupts.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28])
    await writeFile(path.join(root, 'logo.png'), png)
    await writeFile(path.join(root, 'font.bin'), png)

    await registry.get('write_file')!.execute({ path: 'logo.png', content: 'oops' }, ctx)
    await registry.get('delete_file')!.execute({ path: 'font.bin' }, ctx)
    await undoLastChange(ctx)
    await undoLastChange(ctx)
    expect((await readFile(path.join(root, 'logo.png'))).equals(png)).toBe(true)
    expect((await readFile(path.join(root, 'font.bin'))).equals(png)).toBe(true)

    // redo puts back the exact bytes captured at undo time, then undo restores the binary again
    await redoLastChange(ctx)
    await redoLastChange(ctx)
    expect(await readFile(path.join(root, 'logo.png'), 'utf8')).toBe('oops')
    await undoLastChange(ctx)
    await undoLastChange(ctx)
    expect((await readFile(path.join(root, 'logo.png'))).equals(png)).toBe(true)
  })

  it('clears redo history after a new mutation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-redo-clear-'))
    const registry = createDefaultRegistry()
    const { ctx } = makeCtx(root)

    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v1' }, ctx)
    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v2' }, ctx)
    await undoLastChange(ctx)
    await registry.get('write_file')!.execute({ path: 'a.txt', content: 'v3' }, ctx)

    expect((await redoLastChange(ctx)).redone).toBe(false)
  })
})
