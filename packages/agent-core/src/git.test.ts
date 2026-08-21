import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findGitRoot, getBranch, getStatus } from './git.js'

const repo = mkdtempSync(path.join(tmpdir(), 'hesdor-git-'))
execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
execFileSync('git', ['config', 'user.email', 'test@hesdor.dev'], { cwd: repo })
execFileSync('git', ['config', 'user.name', 'Hesdor Test'], { cwd: repo })
mkdirSync(path.join(repo, 'deeply', 'nested'), { recursive: true })
execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repo })

describe('findGitRoot', () => {
  it('finds the root from nested subdirectories', () => {
    const child = path.join(repo, 'deeply', 'nested')
    expect(findGitRoot(child)).toBe(repo)
  })

  it('returns null outside any repository', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'hesdor-nogit-'))
    expect(findGitRoot(plain)).toBeNull()
  })
})

describe('git helpers', () => {
  it('reports branch and clean status', async () => {
    expect(await getBranch(repo)).toBe('main')
    const status = await getStatus(repo)
    expect(status.branch).toBe('main')
    expect(status.entries).toHaveLength(0)
  })

  it('sees untracked files in status', async () => {
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo })
    writeFileSync(path.join(repo, 'new.txt'), 'hello')
    const status = await getStatus(repo)
    expect(status.entries.some((e) => e.includes('new.txt'))).toBe(true)
  })
})
