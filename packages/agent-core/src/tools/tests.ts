import { realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { checksFor, stripAnsi, type TestKind, type TestRunner } from '../checks.js'
import { execStreaming } from '../exec.js'
import { realPathOf, safeResolve, toRel } from '../paths.js'
import { wrapCommand } from '../sandbox.js'
import { authorize } from './shell.js'
import { defineTool } from './types.js'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 600_000
const MAX_FAILURES = 20
const MAX_OUTPUT_LINES = 5000
const TAIL_LINES = 40

export interface TestFailure {
  name: string
  /** file:line(:col) as the runner printed it. */
  location?: string
  message?: string
}

/** Extra argv that narrows a run to a path and/or test name, in the runner's own syntax. */
export function filterArgs(runner: TestRunner, file?: string, name?: string): string[] {
  const out: string[] = []
  switch (runner.kind) {
    case 'vitest':
    case 'jest':
      if (file) out.push(file)
      if (name) out.push('-t', name)
      break
    case 'mocha':
      if (file) out.push(file)
      if (name) out.push('--grep', name)
      break
    case 'node':
      // node stops reading options at the first file, so the pattern goes first.
      if (name) out.push(`--test-name-pattern=${name}`)
      if (file) out.push(file)
      break
    case 'pytest':
      if (file) out.push(file)
      if (name) out.push('-k', name)
      break
    case 'go': {
      const dir = file ? (file.endsWith('.go') ? path.posix.dirname(file) : file) : undefined
      if (dir) out.push(dir === '.' ? './...' : `./${dir}`)
      else if (runner.source === 'go.mod') out.push('./...')
      if (name) out.push('-run', name)
      break
    }
    case 'cargo':
      if (name) out.push(name) // cargo filters by test name only
      break
    default:
      if (file) out.push(file)
  }
  // npm passes script arguments only after `--`.
  return out.length > 0 && runner.argv[0] === 'npm' ? ['--', ...out] : out
}

/** Text of the first non-empty line after `i` (within a few lines). */
function nextText(lines: string[], i: number): string | undefined {
  for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
    const t = lines[j]!.trim()
    if (t !== '') return t
  }
  return undefined
}

/** First `file:line:col` in parentheses or after ❯ between lines `from` and `to`, skipping node internals. */
function findLocation(lines: string[], from: number, to: number, re: RegExp): string | undefined {
  for (let j = from; j < Math.min(to, lines.length); j++) {
    const m = re.exec(lines[j]!)
    if (m && !/node_modules|node:internal/.test(m[1]!)) return m[1]
  }
  return undefined
}

/** Failed tests parsed from runner output (ANSI already stripped). Empty when the format is unknown. */
/**
 * `node --test` TAP output: a `not ok N - name` line followed by a YAML block (`---` … `...`).
 * Only real test failures count; suites and files fail with `subtestsFailed` and are skipped.
 */
function parseNodeTap(lines: string[]): TestFailure[] {
  const out: TestFailure[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(lines[i]!)
    if (!head) continue
    const field: Record<string, string> = {}
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]!) && !/^\s*(?:not )?ok \d+ /.test(lines[j]!); j++) {
      const kv = /^\s*(location|failureType|name|error):\s*(.*)$/.exec(lines[j]!)
      if (!kv || field[kv[1]!] !== undefined) continue
      // A block scalar (`error: |-`) carries its first line on the next line.
      field[kv[1]!] = /^\|[-+]?$/.test(kv[2]!.trim()) ? (lines[j + 1] ?? '').trim() : kv[2]!.trim().replace(/^'(.*)'$/, '$1')
    }
    if (field.failureType !== 'testCodeFailure') continue
    const message = [field.name, field.error].filter(Boolean).join(': ')
    // TAP escapes backslashes in Windows paths ('C:\\repo\\n.test.mjs:3:1').
    const location = field.location?.replace(/\\\\/g, '\\').replace(/^file:\/\/\/?/, '')
    out.push({ name: head[1]!, ...(location ? { location } : {}), ...(message ? { message } : {}) })
  }
  return out
}

export function parseFailures(kind: TestKind, lines: string[]): TestFailure[] {
  const out: TestFailure[] = []
  const starts = (re: RegExp): number[] => lines.flatMap((l, i) => (re.test(l) ? [i] : []))
  const blockEnd = (all: number[], k: number): number => all[k + 1] ?? lines.length

  if (kind === 'vitest') {
    const at = starts(/^\s*FAIL\s+\S/)
    at.forEach((i, k) => {
      const name = lines[i]!.replace(/^\s*FAIL\s+/, '').trim()
      const message = nextText(lines, i)
      const location = findLocation(lines, i + 1, blockEnd(at, k), /❯\s+(\S+:\d+:\d+)/)
      out.push({ name, ...(location ? { location } : {}), ...(message ? { message } : {}) })
    })
  } else if (kind === 'jest') {
    const at = starts(/^\s*● (?!Console$)/)
    at.forEach((i, k) => {
      const name = lines[i]!.replace(/^\s*● /, '').trim()
      const message = nextText(lines, i)
      const location = findLocation(lines, i + 1, blockEnd(at, k), /\(([^()\s]+:\d+:\d+)\)/)
      out.push({ name, ...(location ? { location } : {}), ...(message ? { message } : {}) })
    })
  } else if (kind === 'pytest') {
    for (const line of lines) {
      const m = /^(?:FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(line.trim())
      if (!m) continue
      const [nodeid, message] = [m[1]!, m[2]]
      const file = nodeid.split('::')[0]!
      const test = nodeid.split('::').at(-1)!
      // The traceback section `____ test ____` holds `file:line: Error`.
      const section = lines.findIndex((l) => new RegExp(`^_{3,} .*\\b${test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.* _{3,}$`).test(l))
      const hit = lines.slice(Math.max(0, section)).find((l) => l.startsWith(`${file}:`) && /^\S+:\d+:/.test(l))
      const location = hit ? /^(\S+?:\d+):/.exec(hit)![1] : undefined
      out.push({ name: nodeid, ...(location ? { location } : {}), ...(message ? { message } : {}) })
    }
  } else if (kind === 'go') {
    lines.forEach((line, i) => {
      const m = /^\s*--- FAIL: (\S+)/.exec(line)
      if (!m) return
      const detail = lines.slice(i + 1, i + 6).map((l) => /^\s+(\S+\.go:\d+): (.*)$/.exec(l)).find(Boolean)
      out.push({ name: m[1]!, ...(detail ? { location: detail[1]!, message: detail[2]! } : {}) })
    })
  } else if (kind === 'cargo') {
    lines.forEach((line, i) => {
      const m = /^---- (\S+) stdout ----$/.exec(line.trim())
      if (!m) return
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const old = /panicked at '(.*)', (\S+:\d+:\d+)/.exec(lines[j]!)
        const now = /panicked at (\S+:\d+:\d+):?$/.exec(lines[j]!)
        if (old) return void out.push({ name: m[1]!, location: old[2]!, message: old[1]! })
        if (now) return void out.push({ name: m[1]!, location: now[1]!, ...(nextText(lines, j) ? { message: nextText(lines, j)! } : {}) })
      }
      out.push({ name: m[1]! })
    })
  } else if (kind === 'node') {
    const section = lines.findIndex((l) => /^\s*✖ failing tests:/.test(l))
    if (section < 0) out.push(...parseNodeTap(lines)) // Node < 23 prints TAP when stdout is not a terminal
    if (section >= 0) {
      let location: string | undefined
      for (let i = section + 1; i < lines.length; i++) {
        const loc = /^\s*test at (\S+:\d+:\d+)/.exec(lines[i]!)
        if (loc) location = loc[1]!.replace(/^file:\/\/\/?/, '')
        const fail = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(lines[i]!)
        if (fail) {
          const message = nextText(lines, i)
          out.push({ name: fail[1]!, ...(location ? { location } : {}), ...(message ? { message } : {}) })
          location = undefined
        }
      }
    }
  }
  // Runners repeat failures in summaries: keep the first of each.
  const seen = new Set<string>()
  return out.filter((f) => !seen.has(f.name) && seen.add(f.name))
}

const MAX_MESSAGE = 300

export const runTestsTool = defineTool({
  name: 'run_tests',
  description:
    "Run the project's tests and get a compact list of failures (file:line, test name, message). The runner is detected (package.json test script with vitest/jest/mocha/node --test, pytest, go test, cargo test) or set by checks.test in config. Narrow the run with `path` (a test file or directory) and/or `name` (a test name pattern). Prefer this over run_command for tests; run it after changing code.",
  risk: 'EXECUTE',
  schema: z.object({
    path: z.string().optional().describe('Test file or directory inside the repository'),
    name: z.string().optional().describe('Only tests whose name matches this pattern'),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
  }),
  async execute(input, ctx) {
    const runner = (await checksFor(ctx)).test
    if (!runner) {
      throw new Error(
        'no test runner found (package.json "test" script, pytest config, go.mod or Cargo.toml). Set checks.test in config.json, or run the tests with run_command.',
      )
    }
    const file = input.path && input.path.trim() !== '' ? toRel(ctx.root, safeResolve(ctx.root, input.path)) || '.' : undefined
    const name = input.name && input.name.trim() !== '' ? input.name : undefined
    // A value starting with "-" would be read as an option (e.g. --config=evil.js).
    if (file?.startsWith('-') || name?.startsWith('-')) throw new Error('path and name must not start with "-"')
    const argv = [...runner.argv, ...filterArgs(runner, file, name)]
    const command = argv.join(' ')
    const run = wrapCommand(argv, ctx.sandbox, ctx.root, ctx.root)
    await authorize(argv, command, ctx, run.sandboxed)

    const lines: string[] = []
    let dropped = 0
    const push = (line: string): void => {
      lines.push(stripAnsi(line))
      if (lines.length > MAX_OUTPUT_LINES) {
        lines.shift()
        dropped++
      }
    }
    const result = await execStreaming(run.argv, {
      cwd: ctx.root,
      signal: ctx.signal,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      tailLines: 1,
      onStdoutLine: (line) => {
        push(line)
        ctx.emit({ type: 'command.output', stream: 'stdout', line })
      },
      onStderrLine: (line) => {
        push(line)
        ctx.emit({ type: 'command.output', stream: 'stderr', line })
      },
      onSpawn: (child) => {
        ctx.state.activeChild = child
      },
    })
    ctx.state.activeChild = null

    const passed = result.exitCode === 0 && !result.timedOut
    const failures = passed ? [] : parseFailures(runner.kind, lines)
    const text = lines.filter((l) => l.trim() !== '')
    // Strip the root only as a prefix; runners may report its real path (macOS: /var -> /private/var).
    // Node's own realpath keeps Windows 8.3 short names (C:\Users\RUNNER~1) while the native one expands them,
    // so accept both, compared case-insensitively on Windows.
    const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
    const jsReal = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const roots = [...new Set([ctx.root, realPathOf(ctx.root), jsReal(ctx.root)])].map((r) => fold(`${r.replace(/\\/g, '/')}/`))
    const relLoc = (loc: string): string => {
      const l = loc.replace(/\\/g, '/')
      const r = roots.find((p) => fold(l).startsWith(p))
      return r ? l.slice(r.length) : l
    }
    return {
      command,
      result: result.timedOut ? 'timed out' : passed ? 'passed' : 'failed',
      exitCode: result.exitCode,
      ...(failures.length > 0
        ? {
            failures: failures.slice(0, MAX_FAILURES).map((f) => {
              const where = f.location ? `${relLoc(f.location)} ` : ''
              const msg = f.message ? `: ${f.message.slice(0, MAX_MESSAGE)}` : ''
              return `${where}${f.name}${msg}`
            }),
            ...(failures.length > MAX_FAILURES ? { moreFailures: failures.length - MAX_FAILURES } : {}),
          }
        : {}),
      // Passing runs end with the runner's summary; unparsed failures need the raw tail.
      output: (passed || failures.length > 0 ? text.slice(-5) : text.slice(-TAIL_LINES)).join('\n') +
        (dropped > 0 && !passed && failures.length === 0 ? `\n[${dropped} earlier lines not kept]` : ''),
    }
  },
})
