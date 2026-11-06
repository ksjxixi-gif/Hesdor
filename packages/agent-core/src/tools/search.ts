import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { DEFAULT_IGNORES, GitIgnoreMatcher, globToRegex } from '../ignore.js'
import { safeResolve, toRel } from '../paths.js'
import { walkFiles } from './fs.js'
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
  /** Set when the search was cut short or the pattern was searched as plain text. */
  note?: string
}

type SearchOutcome = Omit<SearchResult, 'pattern'>

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

const PLAIN_TEXT_NOTE = 'pattern is not a valid regex; searched it as plain text'

// Lazy path, anchored numbers: a `:12:3:` inside the matched text stays in the text.
const vimgrepLine = /^(.+?):(\d+):\d+:(.*)$/

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Search file contents across the repository with a regular expression (or plain text). Skips ignored paths like node_modules and .git. Returns file, line number and matching text. An invalid regex is searched as plain text.',
  risk: 'READ',
  schema: z.object({
    pattern: z.string().min(1).describe('Regular expression or plain text to find'),
    subdir: z.string().optional().describe('Optional subdirectory scope'),
    max_results: z.number().int().positive().max(1000).optional().describe('Cap on returned matches (default 100)'),
  }),
  async execute(input, ctx: ToolContext): Promise<SearchResult> {
    const max = input.max_results ?? 100
    const searchRoot = safeResolve(ctx.root, input.subdir && input.subdir.trim() !== '' ? input.subdir : '.')
    const result = (await hasRipgrep())
      ? await ripgrepSearch(ctx.root, toRel(ctx.root, searchRoot), input.pattern, max)
      : await fallbackSearch(ctx.root, searchRoot, input.pattern, max)
    return { pattern: input.pattern, ...result }
  },
})

function runRg(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('rg', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      // rg exits 1 on "no matches" (a valid result) and 2 on errors.
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 2
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Runs from the repository root so paths come back repo-relative with forward slashes. */
export async function ripgrepSearch(repoRoot: string, subRel: string, pattern: string, max: number): Promise<SearchOutcome> {
  const ignores = DEFAULT_IGNORES.flatMap((g) => ['--glob', `!${g}`])
  if (existsSync(path.join(repoRoot, '.hesdorignore'))) ignores.push('--ignore-file', '.hesdorignore')
  const base = ['--vimgrep', '--no-messages', '--color', 'never', '--path-separator', '/', '--max-count', '50', ...ignores]
  const target = ['--', subRel === '' ? '.' : subRel]
  let note: string | undefined
  let res = await runRg([...base, '-e', pattern, ...target], repoRoot)
  if (res.code === 2 && /regex/i.test(res.stderr)) {
    // e.g. `useState(`: an invalid regex is almost always meant literally.
    res = await runRg([...base, '--fixed-strings', '-e', pattern, ...target], repoRoot)
    note = PLAIN_TEXT_NOTE
  }

  const matches: SearchMatch[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = vimgrepLine.exec(line)
    if (!m) continue
    matches.push({ file: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), text: m[3]!.slice(0, 300) })
    if (matches.length >= max) break
  }
  return { matches, truncated: matches.length >= max, engine: 'ripgrep', ...(note ? { note } : {}) }
}

const FALLBACK_BUDGET_MS = 10_000

// Plain CommonJS run by `new Worker(..., { eval: true })`, so a catastrophic regex blocks the worker, never the CLI.
const MATCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.source, workerData.flags)
parentPort.on('message', (text) => {
  const lines = text.split(/\\r?\\n/)
  const hits = []
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i)
  parentPort.postMessage(hits)
})
`

/** JS walk used when rg is missing. Regex matching runs in a worker that is terminated after `budgetMs`. */
export async function fallbackSearch(
  repoRoot: string,
  searchRoot: string,
  pattern: string,
  max: number,
  budgetMs = FALLBACK_BUDGET_MS,
): Promise<SearchOutcome> {
  let regex: RegExp
  let note: string | undefined
  try {
    regex = new RegExp(pattern)
  } catch {
    regex = new RegExp(escapeLiteral(pattern))
    note = PLAIN_TEXT_NOTE
  }
  const matcher = await GitIgnoreMatcher.load(repoRoot)
  const matches: SearchMatch[] = []
  let truncated = false
  let timedOut = false

  const deadline = Date.now() + budgetMs
  const worker = new Worker(MATCH_WORKER, { eval: true, workerData: { source: regex.source, flags: regex.flags } })
  let pending: ((hits: number[] | null) => void) | null = null
  worker.on('message', (hits: number[]) => pending?.(hits))
  worker.on('error', () => pending?.(null))
  const matchLines = (text: string): Promise<number[] | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
      pending = (hits) => {
        clearTimeout(timer)
        resolve(hits)
      }
      worker.postMessage(text)
    })

  const walk = async (relDir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(path.join(repoRoot, relDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated || timedOut) return
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (matcher.ignored(rel, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        await walk(rel)
      } else if (entry.isFile()) {
        let buf: Buffer
        try {
          buf = (await readFile(path.join(repoRoot, rel))).subarray(0, 1024 * 1024)
        } catch {
          continue
        }
        if (buf.subarray(0, 8192).includes(0)) continue // binary, like rg
        const content = buf.toString('utf8')
        const hits = await matchLines(content)
        if (hits === null) {
          timedOut = true
          return
        }
        const lines = hits.length > 0 ? content.split(/\r?\n/) : []
        for (const i of hits) {
          matches.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 300) })
          if (matches.length >= max) {
            truncated = true
            return
          }
        }
      }
    }
  }

  try {
    await walk(toRel(repoRoot, searchRoot))
  } finally {
    await worker.terminate()
  }
  if (timedOut) {
    note = `search stopped after ${budgetMs} ms (the regex may backtrack catastrophically); results are partial, simplify the pattern`
  }
  return { matches, truncated: truncated || timedOut, engine: 'fallback', ...(note ? { note } : {}) }
}

export const findFilesTool = defineTool({
  name: 'find_files',
  description:
    'Find files by glob pattern, e.g. "src/**/*.test.ts", "*.md" or "**/*.{ts,tsx}". A pattern without "/" matches file names at any depth. Skips ignored paths. Returns repository-relative paths.',
  risk: 'READ',
  schema: z.object({
    pattern: z.string().min(1).describe('Glob: * ? ** [abc] {a,b}'),
    subdir: z.string().optional().describe('Optional subdirectory; the pattern is matched relative to it'),
    max_results: z.number().int().positive().max(2000).optional().describe('Cap on returned paths (default 200)'),
  }),
  async execute(input, ctx: ToolContext) {
    const subdir = input.subdir && input.subdir.trim() !== '' ? input.subdir : '.'
    const base = toRel(ctx.root, safeResolve(ctx.root, subdir))
    const pattern = input.pattern.replace(/^\.?\//, '')
    const byName = !pattern.includes('/')
    const re = globToRegex(pattern, true)
    const res = await walkFiles(ctx.root, subdir, {
      max: input.max_results ?? 200,
      filter: (rel) => re.test(byName ? rel.slice(rel.lastIndexOf('/') + 1) : base === '' ? rel : rel.slice(base.length + 1)),
    })
    return { pattern: input.pattern, count: res.count, truncated: res.truncated, files: res.files }
  },
})
