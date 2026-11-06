#!/usr/bin/env node
// Performance budgets (report G8). Needs a build first: pnpm build
//
//   node scripts/bench.mjs            cold start + diff
//   node scripts/bench.mjs --json     machine-readable output
//
// Cold start: median of 10 runs of `hesdor --version` and `hesdor --help` (packages/cli/bin/hesdor.js).
// Diff: unifiedDiff (packages/cli/dist/diff.js, the TUI review diff) on files of 2k, 5k and 20k lines
// with a few scattered edits, each in its own process with a time and heap limit.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bin = `${root}packages/cli/bin/hesdor.js`
const diffJs = `${root}packages/cli/dist/diff.js`
const json = process.argv.includes('--json')
const RUNS = 10
const DIFF_TIMEOUT_MS = 60_000
const DIFF_HEAP_MB = 4096

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// Child mode: time one diff and print JSON.
if (process.argv[2] === '--diff-child') {
  const lines = Number(process.argv[3])
  const { unifiedDiff } = await import(pathToFileURL(diffJs).href)
  const before = Array.from({ length: lines }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`).join('\n') + '\n'
  const after = before
    .split('\n')
    .map((l, i) => (i % Math.floor(lines / 5) === 7 ? `${l} // edited` : l))
    .join('\n')
  const t = performance.now()
  const out = unifiedDiff(before, after)
  const ms = performance.now() - t
  console.log(JSON.stringify({ ms, outLines: out.length, heapMb: Math.round(process.memoryUsage().rss / 1048576) }))
  process.exit(0)
}

for (const [file, hint] of [[bin, 'packages/cli/bin'], [`${root}packages/cli/dist/bundle.js`, 'pnpm build'], [diffJs, 'pnpm build']]) {
  if (!existsSync(file)) {
    console.error(`missing ${file} (${hint})`)
    process.exit(1)
  }
}

function coldStart(arg) {
  const times = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    execFileSync(process.execPath, [bin, arg], { stdio: 'ignore', env: { ...process.env, NO_COLOR: '1' } })
    times.push(performance.now() - t)
  }
  return { medianMs: Math.round(median(times)), minMs: Math.round(Math.min(...times)), maxMs: Math.round(Math.max(...times)) }
}

function diffBench(lines) {
  const t = performance.now()
  const r = spawnSync(process.execPath, [`--max-old-space-size=${DIFF_HEAP_MB}`, fileURLToPath(import.meta.url), '--diff-child', String(lines)], {
    encoding: 'utf8',
    timeout: DIFF_TIMEOUT_MS,
  })
  const wall = Math.round(performance.now() - t)
  if (r.status === 0) {
    const res = JSON.parse(r.stdout.trim().split('\n').at(-1))
    return { lines, ok: true, ms: Math.round(res.ms), rssMb: res.heapMb, outLines: res.outLines }
  }
  const why = r.error?.code === 'ETIMEDOUT' ? `timeout after ${DIFF_TIMEOUT_MS} ms` : /heap|memory/i.test(r.stderr) ? `out of memory (${DIFF_HEAP_MB} MB heap)` : `exit ${r.status ?? r.signal}`
  return { lines, ok: false, wallMs: wall, error: why }
}

const node = process.version
const version = coldStart('--version')
const help = coldStart('--help')
const diffs = [2000, 5000, 20000].map(diffBench)

if (json) {
  console.log(JSON.stringify({ node, platform: process.platform, coldStart: { version, help }, diff: diffs }, null, 2))
} else {
  console.log(`node ${node} on ${process.platform}`)
  console.log(`cold start --version: median ${version.medianMs} ms (min ${version.minMs}, max ${version.maxMs}, n=${RUNS})`)
  console.log(`cold start --help:    median ${help.medianMs} ms (min ${help.minMs}, max ${help.maxMs}, n=${RUNS})`)
  for (const d of diffs) {
    console.log(d.ok ? `diff ${d.lines} lines: ${d.ms} ms, rss ${d.rssMb} MB, ${d.outLines} output lines` : `diff ${d.lines} lines: FAILED (${d.error})`)
  }
}
