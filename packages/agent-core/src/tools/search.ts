import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { GitIgnoreMatcher } from '../ignore.js'
import { safeResolve, toRel } from '../paths.js'
import { defineTool } from './types.js'

export interface SearchMatch {
  file: string
  line: number
  text: string
}

export interface SearchResult {
  pattern: string
  matches: SearchMatch[]
  truncated: boolean
  engine: 'ripgrep' | 'fallback'
}

interface SearchOutcome {
  matches: SearchMatch[]
  truncated: boolean
  engine: 'ripgrep' | 'fallback'
}

let ripgrepChecked = false
let ripgrepAvailable = false

/** Whether `rg` is on PATH. Cached; reported by `hesdor doctor` too. */
export async function hasRipgrep(): Promise<boolean> {
  if (!ripgrepChecked) {
    ripgrepChecked = true
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('rg', ['--version'], { timeout: 5000, windowsHide: true }, (err) =>
          err ? reject(err) : resolve(),
        )
      })
      ripgrepAvailable = true
    } catch {
      ripgrepAvailable = false
    }
  }
  return ripgrepAvailable
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const vimgrepLine = /^(.+):(\d+):\d+:(.*)$/

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Search file contents across the repository with a regular expression (or plain text). Skips ignored paths like node_modules and .git. Returns file, line number and matching text.',
  risk: 'READ',
  schema: z.object({
    pattern: z.string().min(1).describe('Regular expression or plain text to find'),
    subdir: z.string().optional().describe('Optional subdirectory scope'),
    max_results: z.number().int().positive().max(1000).optional().describe('Cap on returned matches (default 100)'),
  }),
  async execute(input, ctx: ToolContext): Promise<SearchResult> {
    const max = input.max_results ?? 100
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch {
      regex = new RegExp(escapeLiteral(input.pattern))
    }
    const searchRoot = safeResolve(ctx.root, input.subdir && input.subdir.trim() !== '' ? input.subdir : '.')

    let result: SearchOutcome
    if (await hasRipgrep()) {
      result = await ripgrepSearch(searchRoot, input.pattern, max)
    } else {
      result = await fallbackSearch(ctx.root, searchRoot, regex, max)
    }
    return { pattern: input.pattern, ...result }
  },
})

async function ripgrepSearch(root: string, pattern: string, max: number): Promise<SearchOutcome> {
  const args = [
    '--vimgrep',
    '--no-messages',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    '50',
    '-e',
    pattern,
    '.',
  ]
  const stdout = await new Promise<string>((resolve) => {
    execFile('rg', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 30000, windowsHide: true }, (err, out) => {
      // rg exits 1 on "no matches" — that is a valid result.
      resolve(err && !out ? '' : out)
    })
  })

  const matches: SearchMatch[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = vimgrepLine.exec(line)
    if (!m) continue
    matches.push({ file: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) })
    if (matches.length >= max) break
  }
  return { matches, truncated: matches.length >= max, engine: 'ripgrep' as const }
}

async function fallbackSearch(
  repoRoot: string,
  searchRoot: string,
  regex: RegExp,
  max: number,
): Promise<SearchOutcome> {
  const matcher = await GitIgnoreMatcher.load(repoRoot)
  const baseRel = toRel(repoRoot, searchRoot)
  const matches: SearchMatch[] = []
  let truncated = false

  const walk = async (relDir: string): Promise<void> => {
    if (truncated) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(path.join(repoRoot, relDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (matcher.ignored(rel, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        await walk(rel)
      } else if (entry.isFile()) {
        let content: string
        try {
          const buf = await readFile(path.join(repoRoot, rel))
          content = buf.subarray(0, 1024 * 1024).toString('utf8')
        } catch {
          continue
        }
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 300) })
            if (matches.length >= max) {
              truncated = true
              return
            }
          }
        }
      }
    }
  }

  await walk(baseRel === '' ? '' : baseRel)
  return { matches, truncated, engine: 'fallback' as const }
}
