import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSessions, loadSession, newSessionId, saveSession, titleFrom } from './sessions.js'

const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-sessions-'))

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
