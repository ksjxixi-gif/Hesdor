import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

export function runGit(args: string[], cwd: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr ? `: ${stderr.trim().slice(0, 400)}` : ''
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
  const out = await runGit(['--no-pager', 'diff', 'HEAD'], root)
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n... (diff truncated)` : out
}

export async function logOneline(root: string, limit = 20): Promise<string[]> {
  const n = Math.min(Math.max(1, limit), 50)
  const out = await runGit(['--no-pager', 'log', `-${n}`, '--oneline', '--decorate=short'], root)
  return out.split(/\r?\n/).filter((l) => l.length > 0)
}
