import path from 'node:path'

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
  return abs
}

/** Relative POSIX-style path (for display and gitignore matching). */
export function toRel(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/')
}
