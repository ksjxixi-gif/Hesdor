import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, undoLastChange } from './index.js'
import type { RunEvent, ToolContext } from '@hesdor/protocol'

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
      state: { activeChild: null, snapshots: [] },
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
})
