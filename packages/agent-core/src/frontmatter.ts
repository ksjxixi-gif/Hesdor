/**
 * Frontmatter of SKILL.md and command files. A YAML subset: top-level
 * `key: value` with plain, 'single' and "double" quoted scalars, multi-line
 * plain scalars, folded `>` and literal `|` block scalars (with `-`/`+`
 * chomping), comments, a UTF-8 BOM and CRLF. Nested maps and lists are skipped.
 * shortcut: no flow collections, anchors or nested values; add a YAML dependency if a field needs them.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trimEnd() !== '---') return { meta: {}, body: text }
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end < 0) return { meta: {}, body: text }
  return { meta: parseMap(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') }
}

function parseMap(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(lines[i]!)
    if (!m) continue
    // A value's continuation: following blank or indented lines.
    let j = i + 1
    while (j < lines.length && (lines[j]!.trim() === '' || /^[ \t]/.test(lines[j]!))) j++
    const rest = lines.slice(i + 1, j)
    i = j - 1
    const value = m[2]!.trim()
    const block = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(value)
    if (block) meta[m[1]!] = blockScalar(rest, block[1] === '>', block[2]!)
    else if (value !== '') meta[m[1]!] = flowScalar([value, ...rest.map((l) => l.trim())])
    // An empty value starts a nested map or list: skipped.
  }
  return meta
}

/** YAML folding: a single line break becomes a space, n breaks become n-1 newlines. */
const fold = (text: string): string => text.replace(/\n+/g, (breaks) => (breaks.length === 1 ? ' ' : '\n'.repeat(breaks.length - 1)))

function blockScalar(lines: string[], folded: boolean, chomp: string): string {
  const indent = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length))
  const content = lines.map((l) => l.slice(indent)).join('\n').replace(/\s+$/, '')
  const value = folded ? fold(content) : content
  return chomp === '-' || value === '' ? value : `${value}\n`
}

function flowScalar(lines: string[]): string {
  const first = lines[0]!
  if (first.startsWith('"') || first.startsWith("'")) {
    const joined = fold(lines.join('\n').replace(/\s+$/, ''))
    const double = /^"((?:[^"\\]|\\.)*)"/s.exec(joined)
    if (double) {
      try {
        return JSON.parse(`"${double[1]!.replace(/\n/g, '\\n')}"`) as string
      } catch {
        return double[1]!
      }
    }
    const single = /^'((?:[^']|'')*)'/s.exec(joined)
    if (single) return single[1]!.replace(/''/g, "'")
  }
  // Plain scalar: ` #` starts a comment, as in YAML.
  return fold(lines.map((l) => l.replace(/(^|\s)#.*$/, '').trim()).join('\n').replace(/\s+$/, ''))
}
