import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { toRel } from './paths.js'

interface CompiledPattern {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

/**
 * Pragmatic gitignore subset: comments, `!` negation, trailing-`/` directory
 * patterns, `*`, `?`, `[...]` classes and `**`. Anchoring follows git rules
 * (a slash anywhere except the end anchors the pattern to the root).
 */
export class GitIgnoreMatcher {
  private readonly patterns: CompiledPattern[]

  constructor(rules: string[]) {
    this.patterns = rules.map(parseLine).filter((p): p is CompiledPattern => p !== undefined)
  }

  /** Default ignores plus root .gitignore plus .hesdorignore. */
  static async load(root: string): Promise<GitIgnoreMatcher> {
    const rules = [...DEFAULT_IGNORES]
    for (const file of ['.gitignore', '.hesdorignore']) {
      try {
        const content = await readFile(path.join(root, file), 'utf8')
        rules.push(...content.split(/\r?\n/))
      } catch {
        // absent ignore file is fine
      }
    }
    return new GitIgnoreMatcher(rules)
  }

  ignored(relPosixPath: string, isDir = false): boolean {
    let result = false
    for (const p of this.patterns) {
      if (this.matchesPattern(p, relPosixPath, isDir)) result = !p.negated
    }
    return result
  }

  private matchesPattern(p: CompiledPattern, relPath: string, isDir: boolean): boolean {
    if (p.anchored) return p.regex.test(relPath)
    // Unanchored patterns match at any depth: test every path segment.
    const segs = relPath.split('/')
    for (let i = 0; i < segs.length; i++) {
      const isLast = i === segs.length - 1
      if (p.dirOnly && isLast && !isDir) continue
      if (p.regex.test(segs[i]!)) return true
    }
    return false
  }
}

export const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.hesdor',
]

function parseLine(raw: string): CompiledPattern | undefined {
  let line = raw.replace(/\s+$/, '')
  if (line === '' || line.startsWith('#')) return undefined
  let negated = false
  if (line.startsWith('!')) {
    negated = true
    line = line.slice(1)
  }
  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  if (line === '') return undefined
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)
  if (line === '') return undefined
  return { negated, dirOnly, anchored, regex: globToRegex(line) }
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end > i + 1) {
        re += glob.slice(i, end + 1)
        i = end
      } else {
        re += '\\['
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** Convenience helper used by tools that walk the tree. */
export function relFrom(root: string, abs: string): string {
  return toRel(root, abs)
}
