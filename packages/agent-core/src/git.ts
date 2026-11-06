import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * Prepended to every git call Hesdor makes itself: a repository's config must not make
 * Hesdor run programs (fsmonitor runs on `git status`; hooks on commit-like commands).
 */
export const GIT_HARDENING = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=']

export function runGit(args: string[], cwd: string, timeoutMs = 20000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_HARDENING, ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr ? `: ${stderr.trim().slice(0, 400)}` : ''
          if (/not a git repository/i.test(stderr)) {
            reject(new GitError(`git is unavailable: ${cwd} is not a Git repository`))
            return
          }
          reject(new GitError(`git ${args.join(' ')} failed${detail}`))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

/**
 * Walk upward until a `.git` entry (directory or worktree file) is found.
 * Returns null when the start directory is not inside a repository.
 */
export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function getBranch(root: string): Promise<string | null> {
  try {
    const out = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim()
    if (out !== 'HEAD') return out
  } catch {
    // fall through: detached HEAD or unborn branch
  }
  // Unborn branches still have a name; rev-parse fails on them.
  try {
    return (await runGit(['symbolic-ref', '--short', 'HEAD'], root)).trim() || null
  } catch {
    return null
  }
}

export interface GitStatusInfo {
  branch: string | null
  entries: string[]
  truncated: boolean
}

export async function getStatus(root: string): Promise<GitStatusInfo> {
  const branch = await getBranch(root)
  try {
    const out = await runGit(['status', '--porcelain=v1'], root)
    const lines = out.split(/\r?\n/).filter((l) => l.length > 0)
    return {
      branch,
      entries: lines.slice(0, 100),
      truncated: lines.length > 100,
    }
  } catch {
    return { branch, entries: [], truncated: false }
  }
}

/** Unified diff of tracked changes against HEAD (staged + unstaged). */
export async function diffHead(root: string, maxBytes = 100_000): Promise<string> {
  // No external diff drivers or textconv filters: both run programs named in git config.
  const out = await runGit(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'], root)
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n... (diff truncated)` : out
}

export async function logOneline(root: string, limit = 20): Promise<string[]> {
  const n = Math.min(Math.max(1, limit), 50)
  const out = await runGit(['--no-pager', 'log', `-${n}`, '--oneline', '--decorate=short'], root)
  return out.split(/\r?\n/).filter((l) => l.length > 0)
}

export interface Worktree {
  path: string
  branch: string
  /** Commit the branch started from. */
  base: string
}

/** A fresh worktree at `<root>/.hesdor/worktrees/<name>` on a new branch `hesdor/<name>` from HEAD. */
export async function createWorktree(root: string, name: string): Promise<Worktree> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new GitError(`invalid worktree name "${name}" (letters, digits, . _ -)`)
  }
  const base = (await runGit(['rev-parse', '--verify', 'HEAD'], root)).trim()
  const dir = path.join(root, '.hesdor', 'worktrees')
  await mkdir(dir, { recursive: true })
  // Hides the nested checkouts from the main repo's status, search and commits without editing its .gitignore.
  if (!existsSync(path.join(dir, '.gitignore'))) await writeFile(path.join(dir, '.gitignore'), '*\n')
  const wt: Worktree = { path: path.join(dir, name), branch: `hesdor/${name}`, base }
  await runGit(['worktree', 'add', '-b', wt.branch, wt.path, base], root)
  return wt
}

/** Removes the worktree and its branch only when nothing was changed or committed there; returns whether it did. */
export async function removeWorktreeIfUnchanged(root: string, wt: Worktree): Promise<boolean> {
  const status = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], wt.path)
  const head = (await runGit(['rev-parse', 'HEAD'], wt.path)).trim()
  if (status.trim() !== '' || head !== wt.base) return false
  await runGit(['worktree', 'remove', wt.path], root) // without --force git itself refuses a dirty worktree
  await runGit(['branch', '-D', wt.branch], root) // safe: the branch still points at its start commit
  return true
}
