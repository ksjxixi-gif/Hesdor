import { realpathSync } from 'node:fs'
import path from 'node:path'
import { PermissionDeniedError } from './policy.js'

export class PathSafetyError extends Error {
  readonly input: string
  constructor(input: string) {
    super(`path is outside the repository root: "${input}"`)
    this.name = 'PathSafetyError'
    this.input = input
  }
}

/** True when `target` is `root` itself or lies underneath it. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Resolve a model-provided path against the repository root and refuse
 * anything that would escape it: `../` traversal, absolute external paths,
 * drive letters pointing elsewhere. Never trust model-generated paths.
 */
export function safeResolve(root: string, input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PathSafetyError(String(input))
  }
  const abs = path.resolve(root, input)
  if (!isInside(root, abs)) throw new PathSafetyError(input)
  // Lexically inside is not enough: a symlink or junction in the repo can point anywhere.
  if (!isInside(realPathOf(root), realPathOf(abs))) throw new PathSafetyError(input)
  return abs
}

/**
 * Real path of `p`, following symlinks and junctions on its longest existing
 * prefix (the rest may not exist yet, e.g. a file about to be created).
 * shortcut: checked before the operation, so a link swapped in between can still race; re-check at write time if that matters.
 */
export function realPathOf(p: string): string {
  const tail: string[] = []
  let current = path.resolve(p)
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(p)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Refuse agent writes to paths that change how git or Hesdor itself behaves
 * (`.git/hooks` runs on the user's next commit). No approval can unlock these.
 */
export function assertWritable(root: string, abs: string): void {
  const first = toRel(root, abs).split('/')[0]?.toLowerCase()
  if (first === '.git') {
    throw new PermissionDeniedError(`refusing to write ${toRel(root, abs)}: the .git directory is off limits, use git commands instead`)
  }
}

/** Relative POSIX-style path (for display and gitignore matching). */
export function toRel(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/')
}
