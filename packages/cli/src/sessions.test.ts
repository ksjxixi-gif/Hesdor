import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSessions, loadSession, newSessionId, saveSession, titleFrom } from './sessions.js'

const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-sessions-'))
// Keep transcripts out of the developer's real profile (each test file runs in its own worker).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

describe('sessions', () => {
  it('saves, lists newest-first and loads transcripts', async () => {
    const idA = newSessionId()
    const idB = newSessionId()
    expect(idA).not.toBe(idB)

    await saveSession(repo, {
      id: idA,
      title: 'first task',
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'done' },
      ],
    })
    // ensure distinct updatedAt ordering
    await new Promise((r) => setTimeout(r, 20))
    await saveSession(repo, {
      id: idB,
      title: 'second task',
      messages: [{ role: 'user', content: 'second task' }],
    })

    const metas = await listSessions(repo)
    expect(metas.length).toBeGreaterThanOrEqual(2)
    expect(metas[0]!.id).toBe(idB)
    expect(metas[0]!.title).toBe('second task')

    const loaded = await loadSession(metas.find((m) => m.id === idA)!.file)
    expect(loaded?.title).toBe('first task')
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.repo.toLowerCase()).toBe(path.resolve(repo).toLowerCase())
  })

  it('skips empty transcripts and corrupt files', async () => {
    await saveSession(repo, { id: newSessionId(), title: '', messages: [] })
    const metas = await listSessions(repo)
    expect(metas.every((m) => m.messageCount > 0)).toBe(true)

    const { writeFile } = await import('node:fs/promises')
    const { configDir } = await import('./config.js')
    void configDir
    // corrupt file inside the same sessions dir
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha1').update(path.resolve(repo).toLowerCase()).digest('hex').slice(0, 12)
    const { join } = await import('node:path')
    const globalDir = (await import('./config.js')).configDir()
    const dir = join(globalDir, 'sessions', hash)
    await writeFile(join(dir, 'corrupt.json'), '{not json')
    const afterCorrupt = await listSessions(repo)
    expect(afterCorrupt.length).toBe(metas.length)
  })
})

describe('titleFrom', () => {
  it('uses the first user message, collapsed and capped', () => {
    expect(titleFrom([{ role: 'user', content: 'hello\n  world  this is long'.repeat(5) }]).length).toBeLessThanOrEqual(61)
    expect(titleFrom([])).toBe('(untitled)')
  })
})

describe('session index, resume and linked ids', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-index-'))

  it('keeps an index, finds sessions by id or prefix, and records parent links', async () => {
    const { findSession } = await import('./sessions.js')
    await expect(findSession(root)).rejects.toThrow(/no saved session/)
    const parent = newSessionId()
    await saveSession(root, { id: parent, title: 'parent', messages: [{ role: 'user', content: 'parent' }] })
    await new Promise((r) => setTimeout(r, 5))
    const child = `zz${newSessionId()}`
    await saveSession(root, { id: child, title: 'child', parentId: parent, messages: [{ role: 'user', content: 'summary' }] })

    const metas = await listSessions(root)
    expect(metas.map((m) => m.id)).toEqual([child, parent])
    expect(metas[0]).toMatchObject({ parentId: parent, messageCount: 1 })

    expect((await findSession(root)).id).toBe(child)
    expect((await findSession(root, 'zz')).id).toBe(child)
    expect((await findSession(root, parent)).messages[0]!.content).toBe('parent')
    await expect(findSession(root, '../x')).rejects.toThrow(/invalid session id/)
    await expect(findSession(root, 'nope')).rejects.toThrow(/no session/)

    // Saving again keeps createdAt and the parent link; the index stays one entry per id.
    const before = metas[0]!.createdAt
    await saveSession(root, { id: child, title: 'child', messages: [{ role: 'user', content: 'summary' }, { role: 'assistant', content: 'ok' }] })
    const after = await listSessions(root)
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ id: child, createdAt: before, parentId: parent, messageCount: 2 })
  })

  it('rebuilds a missing index from the transcripts', async () => {
    const { rm } = await import('node:fs/promises')
    const dir = path.dirname((await listSessions(root))[0]!.file)
    await rm(path.join(dir, 'index.json'))
    expect((await listSessions(root)).map((m) => m.title).sort()).toEqual(['child', 'parent'])
  })
})
