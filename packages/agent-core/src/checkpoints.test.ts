import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@hesdor/protocol'
import { checkpointTurn, endTurnCheckpoint, listCheckpoints, rewindFiles } from './checkpoints.js'
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
