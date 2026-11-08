import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@hesdor/protocol'
import { autoPruneCheckpoints, checkpointTurn, endTurnCheckpoint, listCheckpoints, pruneAllCheckpoints, pruneCheckpoints, rewindFiles } from './checkpoints.js'
import { diffHead, getStatus, GIT_HARDENING } from './git.js'

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  return repo
}

const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0d, 0x0a])

describe('turn checkpoints', () => {
  it('snapshots outside the project and rewinds tool, shell, binary and manual changes', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    writeFileSync(path.join(root, '.gitignore'), 'build/\n')
    writeFileSync(path.join(root, 'a.txt'), 'one\r\ntwo\n') // mixed EOLs must survive exactly
    writeFileSync(path.join(root, 'b.txt'), 'b0\n')
    writeFileSync(path.join(root, 'logo.png'), BINARY)
    mkdirSync(path.join(root, 'build'))
    writeFileSync(path.join(root, 'build', 'out.js'), 'ignored')
    const gitBefore = readdirSync(path.join(root, '.git')).sort()

    // turn 0: the agent edits a file, a shell command creates one, the binary changes
    const first = await checkpointTurn(root, 's1', 0, { baseDir, prompt: 'make changes' })
    if (!('checkpoint' in first)) throw new Error(first.skipped)
    writeFileSync(path.join(root, 'a.txt'), 'changed by write_file\n')
    execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('made-by-shell.txt', 'x')"], { cwd: root })
    writeFileSync(path.join(root, 'logo.png'), Buffer.from('not a png'))
    writeFileSync(path.join(root, 'build', 'out.js'), 'rebuilt')
    await endTurnCheckpoint(root, 's1', 0, { baseDir })

    // between turns the user edits b.txt by hand; then turn 1 starts (another session too)
    writeFileSync(path.join(root, 'b.txt'), 'edited by the user\n')
    await checkpointTurn(root, 's1', 2, { baseDir, prompt: 'second' })
    await checkpointTurn(root, 'other', 0, { baseDir })

    const list = await listCheckpoints(root, { baseDir, sessionId: 's1' })
    expect(list.map((c) => [c.turnIndex, c.prompt])).toEqual([
      [2, 'second'],
      [0, 'make changes'],
    ])
    expect(list[1]!.id).toBe(first.checkpoint.id)
    expect(await listCheckpoints(root, { baseDir })).toHaveLength(3)

    const res = await rewindFiles(root, first.checkpoint.id, { baseDir })
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('one\r\ntwo\n')
    expect(readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('b0\n')
    expect(readFileSync(path.join(root, 'logo.png')).equals(BINARY)).toBe(true)
    expect(existsSync(path.join(root, 'made-by-shell.txt'))).toBe(false)
    expect(readFileSync(path.join(root, 'build', 'out.js'), 'utf8')).toBe('rebuilt') // ignored: untouched
    expect(res.deleted).toEqual(['made-by-shell.txt'])
    expect(res.restored.sort()).toEqual(['a.txt', 'b.txt', 'logo.png'])
    expect(res.drift).toEqual(['b.txt'])

    // the project's own repository is untouched
    expect(readdirSync(path.join(root, '.git')).sort()).toEqual(gitBefore)
    expect(readdirSync(baseDir)).toEqual(['checkpoints'])

    // the backup undoes the rewind
    await rewindFiles(root, res.backupId, { baseDir })
    expect(readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('edited by the user\n')
    expect(existsSync(path.join(root, 'made-by-shell.txt'))).toBe(true)
  })

  it('skips huge workspaces and says so once', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    writeFileSync(path.join(root, 'a.txt'), 'a')
    writeFileSync(path.join(root, 'b.txt'), 'b')
    const events: RunEvent[] = []
    const res = await checkpointTurn(root, 's', 0, { baseDir, maxFiles: 1, emit: (e) => events.push(e) })
    expect('skipped' in res && res.skipped).toMatch(/more than 1 files/)
    await checkpointTurn(root, 's', 1, { baseDir, maxFiles: 1, emit: (e) => events.push(e) })
    expect(events).toEqual([{ type: 'checkpoint.skipped', reason: expect.stringMatching(/checkpoints are off/) }])
    expect(await listCheckpoints(root, { baseDir })).toEqual([])
  })

  it('rejects unknown checkpoint ids', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    await checkpointTurn(root, 's', 0, { baseDir })
    await expect(rewindFiles(root, 'deadbeef', { baseDir })).rejects.toThrow(/no checkpoint/)
    await expect(rewindFiles(root, '--help', { baseDir })).rejects.toThrow(/invalid checkpoint id/)
  })
})

describe('git hardening', () => {
  it("Hesdor's own git calls ignore core.fsmonitor and external diff drivers", async () => {
    expect(GIT_HARDENING).toEqual(['-c', 'core.fsmonitor=', '-c', 'core.hooksPath='])
    const repo = makeRepo()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
    git('config', 'user.email', 't@hesdor.dev')
    git('config', 'user.name', 'T')
    writeFileSync(path.join(repo, 'mon.sh'), '#!/bin/sh\necho ran > MARK\n')
    writeFileSync(path.join(repo, 'ext.sh'), '#!/bin/sh\necho EXTDIFF\n')
    writeFileSync(path.join(repo, 'f.txt'), 'a\n')
    git('add', 'f.txt')
    git('commit', '-q', '-m', 'init')
    git('config', 'core.fsmonitor', 'sh mon.sh')
    git('config', 'diff.external', 'sh ext.sh')
    writeFileSync(path.join(repo, 'f.txt'), 'b\n')

    await getStatus(repo)
    expect(existsSync(path.join(repo, 'MARK'))).toBe(false)
    const diff = await diffHead(repo)
    expect(diff).toContain('diff --git a/f.txt b/f.txt')
    expect(diff).not.toContain('EXTDIFF')
  })
})

describe('checkpoint retention', () => {
  async function turns(root: string, baseDir: string, n: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(root, 'f.txt'), `turn ${i}\n`)
      const r = await checkpointTurn(root, 's', i, { baseDir, prompt: `p${i}` })
      if (!('checkpoint' in r)) throw new Error(r.skipped)
      ids.push(r.checkpoint.id)
      await endTurnCheckpoint(root, 's', i, { baseDir })
    }
    return ids
  }
  const objectCount = (baseDir: string): number => {
    const [repo] = readdirSync(path.join(baseDir, 'checkpoints'))
    const out = execFileSync('git', [`--git-dir=${path.join(baseDir, 'checkpoints', repo!)}`, 'count-objects', '-v'], { encoding: 'utf8' })
    return Number(/^count: (\d+)/m.exec(out)![1]) + Number(/^in-pack: (\d+)/m.exec(out)![1])
  }

  it('keeps the newest N, drops the rest with gc, and old ids still rewind', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    const ids = await turns(root, baseDir, 5)
    const objectsBefore = objectCount(baseDir)
    expect(await pruneCheckpoints(root, { baseDir, keep: 2 })).toEqual({ removed: 3, kept: 2 })
    const left = await listCheckpoints(root, { baseDir })
    expect(left.map((c) => c.prompt)).toEqual(['p4', 'p3'])
    expect(objectCount(baseDir)).toBeLessThan(objectsBefore)
    // A session that listed checkpoints before the prune still rewinds by the old id.
    writeFileSync(path.join(root, 'f.txt'), 'later\n')
    await rewindFiles(root, ids[3]!.slice(0, 12), { baseDir })
    expect(readFileSync(path.join(root, 'f.txt'), 'utf8')).toBe('turn 3\n')
    await expect(rewindFiles(root, ids[0]!, { baseDir })).rejects.toThrow(/no checkpoint/)
    // Nothing more to drop: a no-op.
    expect(await pruneCheckpoints(root, { baseDir, keep: 2 })).toEqual({ removed: 0, kept: 2 })
  })

  it('drops checkpoints older than maxAgeDays', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    await turns(root, baseDir, 2)
    expect(await pruneCheckpoints(root, { baseDir, now: Date.now() + 29 * 86_400_000 })).toEqual({ removed: 0, kept: 2 })
    expect(await pruneCheckpoints(root, { baseDir, now: Date.now() + 31 * 86_400_000 })).toEqual({ removed: 2, kept: 0 })
    expect(await listCheckpoints(root, { baseDir })).toEqual([])
    // The store still works afterwards.
    await turns(root, baseDir, 1)
    expect(await listCheckpoints(root, { baseDir })).toHaveLength(1)
  })

  it('auto-prunes at most once a day per workspace and never throws', async () => {
    const root = makeRepo()
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    expect(await autoPruneCheckpoints(root, { baseDir })).toBeUndefined() // no store yet
    await turns(root, baseDir, 3)
    expect(await autoPruneCheckpoints(root, { baseDir, keep: 2 })).toEqual({ removed: 1, kept: 2 })
    await turns(root, baseDir, 1)
    expect(await autoPruneCheckpoints(root, { baseDir, keep: 2 })).toBeUndefined() // stamped today
    const [repo] = readdirSync(path.join(baseDir, 'checkpoints'))
    const stamp = path.join(baseDir, 'checkpoints', repo!, 'hesdor-pruned')
    const yesterday = new Date(Date.now() - 25 * 3_600_000)
    utimesSync(stamp, yesterday, yesterday)
    expect(await autoPruneCheckpoints(root, { baseDir, keep: 2 })).toEqual({ removed: 1, kept: 2 })
  })

  it('prune --all covers every workspace, deleted ones too, and nothing outside the store', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'hesdor-cp-store-'))
    const a = makeRepo()
    const b = makeRepo()
    await turns(a, baseDir, 3)
    await turns(b, baseDir, 2)
    rmSync(b, { recursive: true, force: true })
    writeFileSync(path.join(baseDir, 'checkpoints', 'stray.txt'), 'not a repo')
    const r = await pruneAllCheckpoints({ baseDir, keep: 1 })
    expect(r).toMatchObject({ removed: 3, kept: 2, repos: 2, failed: [] })
    expect(readFileSync(path.join(baseDir, 'checkpoints', 'stray.txt'), 'utf8')).toBe('not a repo')
    expect(await listCheckpoints(a, { baseDir })).toHaveLength(1)
  })
})
