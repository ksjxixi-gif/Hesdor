import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inside, readTextFile, writeTextFile } from './fs-handlers.js'
import type { EditorFiles } from './fs-handlers.js'

const root = mkdtempSync(path.join(tmpdir(), 'hesdor-vsc-'))
const a = path.join(root, 'src', 'a.ts')

/** A fake editor: `open` holds buffers, `disk` the saved files, `written` what the agent wrote. */
function fake(open: Record<string, string>, disk: Record<string, string>) {
  const written: Record<string, string> = {}
  const files: EditorFiles = {
    roots: () => [root],
    openText: (f) => open[f],
    readDisk: async (f) => {
      if (!(f in disk)) throw new Error('ENOENT')
      return disk[f]!
    },
    write: async (f, c) => {
      written[f] = c
    },
  }
  return { files, written }
}

describe('fs handlers', () => {
  it('reads the open buffer before the disk, and slices by line and limit', async () => {
    const { files } = fake({ [a]: 'one\ntwo\nthree\n' }, { [a]: 'saved\n' })
    expect(await readTextFile(files, { sessionId: 's', path: a })).toEqual({ content: 'one\ntwo\nthree\n' })
    expect(await readTextFile(files, { sessionId: 's', path: a, line: 2, limit: 1 })).toEqual({ content: 'two' })
    const disk = fake({}, { [a]: 'saved\n' }).files
    expect(await readTextFile(disk, { sessionId: 's', path: a })).toEqual({ content: 'saved\n' })
  })

  it('writes through the editor', async () => {
    const { files, written } = fake({}, {})
    expect(await writeTextFile(files, { sessionId: 's', path: a, content: 'x' })).toEqual({})
    expect(written).toEqual({ [a]: 'x' })
  })

  it('refuses paths outside the workspace or relative ones', async () => {
    const { files, written } = fake({}, {})
    const outside = path.join(path.dirname(root), 'elsewhere.txt')
    await expect(readTextFile(files, { sessionId: 's', path: outside })).rejects.toThrow(/outside the workspace/)
    await expect(writeTextFile(files, { sessionId: 's', path: path.join(root, '..', 'x'), content: '' })).rejects.toThrow(/outside/)
    await expect(readTextFile(files, { sessionId: 's', path: 'src/a.ts' })).rejects.toThrow(/outside/)
    expect(written).toEqual({})
  })

  it('treats the root itself and sibling prefixes as outside', () => {
    expect(inside([root], root)).toBe(false)
    expect(inside([root], `${root}-other${path.sep}f`)).toBe(false)
    expect(inside([root], a)).toBe(true)
  })
})
