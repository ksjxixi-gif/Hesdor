import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from './context.js'
import { execStreaming, type ExecResult } from './exec.js'
import { GIT_HARDENING } from './git.js'
import { toRel } from './paths.js'
import { decideCommand } from './policy.js'
import { wrapCommand } from './sandbox.js'

/**
 * Format-then-check after edits (`checks` in config.json or a trusted project's
 * .hesdor/config.json). Each list is an argv run without a shell; `{file}` is replaced by
 * the edited file's repository path. A list without `{file}` checks the whole project and
 * runs at most once per turn. An empty list turns that kind off; an absent one is detected.
 */
export interface ChecksConfig {
  format?: string[]
  lint?: string[]
  typecheck?: string[]
  /** Test command for run_tests (path and name filters are appended). */
  test?: string[]
  /** Per check run, default 30000. A whole-project check that times out is off for the session. */
  timeoutMs?: number
}

export type CheckKind = 'format' | 'lint' | 'typecheck'

export interface Check {
  kind: CheckKind
  /** Tool name for messages ("prettier"). */
  name: string
  argv: string[]
  /** Files this check applies to; configured checks apply to every file. */
  exts?: RegExp
}

export type TestKind = 'vitest' | 'jest' | 'mocha' | 'node' | 'pytest' | 'go' | 'cargo' | 'other'

export interface TestRunner {
  kind: TestKind
  argv: string[]
  /** Where it came from, for doctor and errors. */
  source: string
}

export interface ResolvedChecks {
  checks: Check[]
  test?: TestRunner
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PROBLEM_LINES = 30
const JS = /\.[mc]?[jt]sx?$/i
const PRETTIER = /\.([mc]?[jt]sx?|json5?|css|scss|less|md|mdx|ya?ml|html|vue|graphql)$/i
const BIOME = /\.([mc]?[jt]sx?|jsonc?|css)$/i
const PY = /\.pyi?$/i

/** Tools colour output when FORCE_COLOR is set even through a pipe; parse without it. */
// eslint-disable-next-line no-control-regex -- ANSI colour codes start with ESC (0x1b)
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '')

const committedBins = new Map<string, boolean>()

/**
 * True when the repository itself commits files under node_modules/.bin. Those come from whoever
 * wrote the repo, not from the user's own install, so they must never run unprompted.
 */
function binsAreCommitted(root: string): boolean {
  let known = committedBins.get(root)
  if (known === undefined) {
    try {
      const out = execFileSync('git', [...GIT_HARDENING, 'ls-files', '--', 'node_modules/.bin'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      known = out.trim() !== ''
    } catch {
      known = false // not a git repo or git missing: node_modules can only be the user's own install
    }
    committedBins.set(root, known)
  }
  return known
}

/** A tool the user installed in node_modules/.bin (the .cmd shim on Windows); never one the repo commits. */
function localBin(root: string, name: string): string | undefined {
  const file = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
  return existsSync(file) && !binsAreCommitted(root) ? file : undefined
}

/** A program on PATH (Windows: .exe/.cmd/.bat), returned by bare name. */
function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d.trim() !== '')
  return dirs.some((d) => exts.some((e) => existsSync(path.join(d, name + e)))) ? name : undefined
}

async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8').catch(() => '')
}

/** Test framework a command line uses. */
export function testKindOf(command: string): TestKind {
  if (/\bvitest\b/.test(command)) return 'vitest'
  if (/\bjest\b/.test(command)) return 'jest'
  if (/\bmocha\b/.test(command)) return 'mocha'
  if (/\bnode\b.*\s--test\b/.test(command)) return 'node'
  if (/\bpytest\b/.test(command)) return 'pytest'
  if (/\bgo\s+test\b/.test(command)) return 'go'
  if (/\bcargo\s+test\b/.test(command)) return 'cargo'
  return 'other'
}

/**
 * Configured checks, else the ones detected from tools already installed and configured in
 * the repository. Detection never installs or downloads anything.
 */
export async function resolveChecks(root: string, config: ChecksConfig = {}): Promise<ResolvedChecks> {
  const has = (...files: string[]): boolean => files.some((f) => existsSync(path.join(root, f)))
  let pkg: { scripts?: Record<string, unknown>; prettier?: unknown; eslintConfig?: unknown } = {}
  try {
    pkg = JSON.parse(await readText(path.join(root, 'package.json')) || '{}')
  } catch {
    // unreadable package.json: no Node detection from it
  }
  const pyproject = await readText(path.join(root, 'pyproject.toml'))
  const detected: Check[] = []

  const prettier = localBin(root, 'prettier')
  const prettierConfigured =
    pkg.prettier !== undefined ||
    has('.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.toml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts')
  const biome = localBin(root, 'biome')
  const biomeConfigured = has('biome.json', 'biome.jsonc')
  if (prettier && prettierConfigured) detected.push({ kind: 'format', name: 'prettier', argv: [prettier, '--write', '{file}'], exts: PRETTIER })
  else if (biome && biomeConfigured) detected.push({ kind: 'format', name: 'biome', argv: [biome, 'format', '--write', '{file}'], exts: BIOME })

  const eslint = localBin(root, 'eslint')
  const eslintConfigured =
    pkg.eslintConfig !== undefined ||
    has('eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml')
  const oxlint = localBin(root, 'oxlint')
  if (eslint && eslintConfigured) detected.push({ kind: 'lint', name: 'eslint', argv: [eslint, '{file}'], exts: JS })
  else if (oxlint) detected.push({ kind: 'lint', name: 'oxlint', argv: [oxlint, '{file}'], exts: JS })
  else if (biome && biomeConfigured) detected.push({ kind: 'lint', name: 'biome', argv: [biome, 'lint', '{file}'], exts: BIOME })

  const tsc = localBin(root, 'tsc')
  if (tsc && has('tsconfig.json')) detected.push({ kind: 'typecheck', name: 'tsc', argv: [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], exts: JS })

  const ruff = (/^\[tool\.ruff/m.test(pyproject) || has('ruff.toml', '.ruff.toml')) && onPath('ruff')
  if (ruff) detected.push({ kind: 'format', name: 'ruff', argv: [ruff, 'format', '{file}'], exts: PY })
  else if (/^\[tool\.black/m.test(pyproject) && onPath('black')) detected.push({ kind: 'format', name: 'black', argv: ['black', '-q', '{file}'], exts: PY })
  if (ruff) detected.push({ kind: 'lint', name: 'ruff', argv: [ruff, 'check', '{file}'], exts: PY })

  const checks: Check[] = []
  for (const kind of ['format', 'lint', 'typecheck'] as const) {
    const own = config[kind]
    if (own === undefined || !isStringList(own)) checks.push(...detected.filter((c) => c.kind === kind))
    else if (own.length > 0) checks.push({ kind, name: path.basename(own[0]!).replace(/\.(cmd|bat|exe)$/i, ''), argv: own })
  }

  let test: TestRunner | undefined
  const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : undefined
  if (isStringList(config.test) && config.test.length > 0) {
    test = { kind: testKindOf(config.test.join(' ')), argv: config.test, source: 'checks.test' }
  } else if (script && !/no test specified/.test(script)) {
    // bun's own `bun test` is its runner, not the script.
    const pm = has('pnpm-lock.yaml') ? ['pnpm', 'test'] : has('yarn.lock') ? ['yarn', 'test'] : has('bun.lock', 'bun.lockb') ? ['bun', 'run', 'test'] : ['npm', 'test']
    test = { kind: testKindOf(script), argv: pm, source: `package.json test script (${script})` }
  } else if ((/^\[tool\.pytest/m.test(pyproject) || has('pytest.ini', 'conftest.py')) && onPath('pytest')) {
    test = { kind: 'pytest', argv: ['pytest', '-q'], source: 'pytest' }
  } else if (has('go.mod')) {
    test = { kind: 'go', argv: ['go', 'test'], source: 'go.mod' }
  } else if (has('Cargo.toml')) {
    test = { kind: 'cargo', argv: ['cargo', 'test'], source: 'Cargo.toml' }
  }

  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs! > 0 ? config.timeoutMs! : DEFAULT_TIMEOUT_MS
  return { checks, ...(test ? { test } : {}), timeoutMs }
}

/** Detection once per turn (one AbortSignal per turn), so a tool installed mid-session is picked up next turn. */
const perTurn = new WeakMap<AbortSignal, Promise<ResolvedChecks>>()
export function checksFor(ctx: Pick<ToolContext, 'root' | 'signal' | 'checks'>): Promise<ResolvedChecks> {
  let resolved = perTurn.get(ctx.signal)
  if (!resolved) perTurn.set(ctx.signal, (resolved = resolveChecks(ctx.root, ctx.checks)))
  return resolved
}

/** Whole-project checks already run this turn. */
const ranThisTurn = new WeakMap<AbortSignal, Set<string>>()

const perFile = (c: Check): boolean => c.argv.some((a) => a.includes('{file}'))

/**
 * Checks never prompt: a deny rule turns one off, and so does an ask rule someone wrote for it.
 * Built-in and default asks are fine: the user configured the check or installed the tool.
 */
function allowed(ctx: ToolContext, argv: string[]): boolean {
  const d = decideCommand(argv, ctx.permissions)
  return d.action === 'allow' || (d.action === 'ask' && (d.source === 'built-in' || d.source === 'default'))
}

async function runCheck(ctx: ToolContext, c: Check, rel: string, timeoutMs: number): Promise<ExecResult | undefined> {
  const argv = c.argv.map((a) => a.replaceAll('{file}', rel))
  if (!allowed(ctx, argv)) return undefined
  try {
    // Same OS sandbox as run_command: checks run repository code (configs, plugins).
    const run = wrapCommand(argv, ctx.sandbox, ctx.root, ctx.root)
    return await execStreaming(run.argv, { cwd: ctx.root, signal: ctx.signal, timeoutMs, tailLines: 400 })
  } catch {
    return undefined // cancelled, sandbox required but missing, or an argument cmd.exe cannot take safely
  }
}

const LOCATION = /:\d+:\d+|\(\d+,\d+\)|^\s*\d+:\d+\s/

/** Lines that name a problem location; a failing run without any gives its last lines. */
function problemLines(r: ExecResult): string[] {
  const all = [...r.stdoutTail, ...r.stderrTail].map((l) => stripAnsi(l).trimEnd()).filter((l) => l.trim() !== '')
  const hits = all.filter((l) => LOCATION.test(l))
  return hits.length > 0 || r.exitCode === 0 ? hits : all.slice(-5)
}

/** Lines of `after` not in `before`, ignoring numbers (positions shift when lines are added). */
export function newProblems(after: string[], before: string[]): string[] {
  const key = (l: string): string => l.replace(/\d+/g, '#').trim()
  const seen = new Map<string, number>()
  for (const l of before) seen.set(key(l), (seen.get(key(l)) ?? 0) + 1)
  return after.filter((l) => {
    const n = seen.get(key(l)) ?? 0
    if (n > 0) seen.set(key(l), n - 1)
    return n === 0
  })
}

const stateOf = (ctx: ToolContext): NonNullable<ToolContext['state']['checks']> =>
  (ctx.state.checks ??= { baselines: new Map(), off: new Set() })

/** Detected checks that apply to `rel` and are not switched off. */
async function applicableChecks(ctx: ToolContext, rel: string): Promise<{ resolved?: ResolvedChecks; list: Check[] }> {
  try {
    const resolved = await checksFor(ctx)
    return { resolved, list: resolved.checks.filter((c) => (c.exts?.test(rel) ?? true) && !stateOf(ctx).off.has(c.name)) }
  } catch {
    return { list: [] } // detection is best-effort
  }
}

/**
 * Write a file, then format it and run lint/typecheck, returning what to append to the tool
 * result. Per-file lint output is compared with a run before the write (or the previous run),
 * so only new problems are reported. Checks never fail the edit.
 */
export async function writeWithChecks(
  ctx: ToolContext,
  abs: string,
  write: () => Promise<void>,
): Promise<{ formatted?: string; checks?: string }> {
  await checkBefore(ctx, abs)
  await write()
  return checkAfter(ctx, abs)
}

/** Before writing an existing file: record per-file lint output once, so checkAfter reports only new problems. */
export async function checkBefore(ctx: ToolContext, abs: string): Promise<void> {
  const rel = toRel(ctx.root, abs)
  const { resolved, list } = await applicableChecks(ctx, rel)
  if (!resolved || !existsSync(abs)) return
  const baselines = stateOf(ctx).baselines
  for (const c of list) {
    const key = `${c.kind}:${c.name}:${rel}`
    if (c.kind !== 'lint' || !perFile(c) || baselines.has(key)) continue
    const r = await runCheck(ctx, c, rel, resolved.timeoutMs)
    if (r && !r.timedOut) baselines.set(key, problemLines(r))
  }
}

/** After a write: format the file, then lint/typecheck it. Call before recording the file's stamp. */
export async function checkAfter(ctx: ToolContext, abs: string): Promise<{ formatted?: string; checks?: string }> {
  const rel = toRel(ctx.root, abs)
  const { resolved, list: applicable } = await applicableChecks(ctx, rel)
  if (!resolved || applicable.length === 0) return {}
  const baselines = stateOf(ctx).baselines

  let formatted: string | undefined
  const report: string[] = []
  for (const c of applicable) {
    if (ctx.signal.aborted) break
    const whole = !perFile(c)
    if (whole) {
      const ran = ranThisTurn.get(ctx.signal) ?? new Set<string>()
      ranThisTurn.set(ctx.signal, ran)
      if (ran.has(c.name)) continue
      ran.add(c.name)
    }
    const written = c.kind === 'format' ? await readFile(abs).catch(() => undefined) : undefined
    const r = await runCheck(ctx, c, rel, resolved.timeoutMs)
    if (!r) continue
    if (r.timedOut || r.exitCode === 127) {
      // Too slow or not runnable: off for the rest of the session instead of costing every edit.
      stateOf(ctx).off.add(c.name)
      report.push(`${c.kind} (${c.name}) ${r.timedOut ? `took over ${resolved.timeoutMs} ms` : 'could not start'}; skipped for this session`)
      continue
    }
    if (c.kind === 'format') {
      if (written && (await keepLineEndings(abs, written))) formatted = c.name
      if (r.exitCode !== 0) report.push(`format (${c.name}) failed:`, ...problemLines(r).slice(0, 5))
      continue
    }
    const key = whole ? `${c.kind}:${c.name}` : `${c.kind}:${c.name}:${rel}`
    const lines = problemLines(r)
    const before = baselines.get(key)
    // First whole-project run: nothing to compare with, so only this file's lines count.
    const fresh = before ? newProblems(lines, before) : whole ? lines.filter((l) => l.replace(/\\/g, '/').includes(rel)) : lines
    baselines.set(key, lines)
    if (fresh.length > 0) report.push(`${c.kind} (${c.name}) new problems${whole ? '' : ` in ${rel}`}:`, ...fresh)
  }
  const out: { formatted?: string; checks?: string } = {}
  if (formatted) out.formatted = `${formatted} reformatted ${rel}; read it again before the next apply_patch`
  if (report.length > 0) {
    out.checks = report.length > MAX_PROBLEM_LINES
      ? [...report.slice(0, MAX_PROBLEM_LINES), `[… ${report.length - MAX_PROBLEM_LINES} more lines]`].join('\n')
      : report.join('\n')
  }
  return out
}

/**
 * After a formatter ran: true when it changed the file. A CRLF file the formatter turned into LF
 * gets its CRLF back (Windows checkouts with autocrlf), so formatting never churns every line.
 */
async function keepLineEndings(abs: string, written: Buffer): Promise<boolean> {
  const now = await readFile(abs).catch(() => undefined)
  if (!now || now.equals(written)) return false
  const before = written.toString('utf8')
  const after = now.toString('utf8')
  const crlf = before.split('\r\n').length - 1
  if (crlf > before.split('\n').length - 1 - crlf && !after.includes('\r\n')) {
    const restored = after.replace(/\n/g, '\r\n')
    await writeFile(abs, restored, 'utf8')
    return restored !== before
  }
  return true
}
