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
 * patterns, `*`, `?`, `[...]`/`[!...]` classes, `\` escapes and `**`. Anchoring
 * follows git rules (a slash anywhere except the end anchors the pattern to the root).
 * shortcut: only the root .gitignore is read, not nested ones; add them if users ask.
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
    // Test every ancestor too: a match on a parent directory ignores everything under it.
    const segs = relPath.split('/')
    for (let i = 0; i < segs.length; i++) {
      const isLast = i === segs.length - 1
      if (p.dirOnly && isLast && !isDir) continue
      // Anchored patterns match the path from the root; unanchored ones match one segment at any depth.
      if (p.regex.test(p.anchored ? segs.slice(0, i + 1).join('/') : segs[i]!)) return true
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

/**
 * Compile a glob: `*`, `?`, `**`, `[...]`/`[!...]` classes and `\` escapes.
 * `braces` also expands `{a,b}` alternatives (find_files; gitignore treats `{` literally).
 */
export function globToRegex(glob: string, braces = false): RegExp {
  let re = ''
  let inBraces = false
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '\\' && i + 1 < glob.length) {
      re += escapeRegex(glob[++i]!)
    } else if (c === '*') {
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
      const end = glob.indexOf(']', i + 2) // a `]` right after `[` (or `[!`) is a member, not the end
      if (end > i + 1) {
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
        if (body.startsWith('!')) body = `^/${body.slice(1)}`
        re += `[${body}]`
        i = end
      } else {
        re += '\\['
      }
    } else if (braces && c === '{' && !inBraces && glob.indexOf('}', i) > i) {
      inBraces = true
      re += '(?:'
    } else if (braces && inBraces && c === ',') {
      re += '|'
    } else if (braces && inBraces && c === '}') {
      inBraces = false
      re += ')'
    } else {
      re += escapeRegex(c)
    }
  }
  return new RegExp(`^${re}$`)
}

const escapeRegex = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Convenience helper used by tools that walk the tree. */
export function relFrom(root: string, abs: string): string {
  return toRel(root, abs)
}
