#!/usr/bin/env node
// Smoke test for a standalone binary: node scripts/release/smoke-binary.mjs <path-to-hesdor-binary> [version]
// Runs --version, --help, doctor, and a headless run against the scripted fake model from scripts/screens
// (temp repo, temp config dir), and checks the agent's fix landed on disk. Exits non-zero on any failure.
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { FIX_TURNS, makeWorkspace, startFakeModel } from '../screens/fixture.mjs'

const [bin, version] = process.argv.slice(2)
if (!bin) throw new Error('usage: smoke-binary.mjs <binary> [version]')
const BIN = path.resolve(bin)

function run(args, opts) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(BIN, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, code, ms: Math.round(performance.now() - started) }))
  })
}

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) {
    console.log(detail)
    process.exitCode = 1
  }
}

const ws = makeWorkspace('hesdor-smoke-')
// The fake model's run_command turn runs `npm test`; plain `node --test` avoids needing npm on the PATH.
const model = await startFakeModel(
  FIX_TURNS.map((t) => (t.tools?.[0]?.name === 'run_command' ? { tools: [{ name: 'run_command', args: { command: 'node --test' } }] } : t)),
  { delayMs: 10 },
)
const opts = { cwd: ws.repo, env: ws.env }
const provider = ['-p', 'openai-compatible', '--base-url', model.baseUrl, '-m', 'demo-model']
try {
  const v = await run(['--version'], opts)
  check(`--version (${v.ms} ms): ${v.out.trim()}`, v.code === 0 && (!version || v.out.trim() === `hesdor ${version}`), v.out)
  const h = await run(['--help'], opts)
  check('--help', h.code === 0 && h.out.includes('Usage:'), h.out)
  const d = await run(['doctor', ...provider], opts)
  check('doctor', d.out.length > 0 && !/Error: Cannot find|ERR_|is not a function/.test(d.out), d.out)
  const r = await run(['run', 'Fix the slugify bug and run the tests', ...provider, '--output-format', 'text'], opts)
  const fixed = readFileSync(path.join(ws.repo, 'src/slug.js'), 'utf8').includes('/\\s+/g')
  check(`headless run (exit ${r.code}, ${model.requests()} model requests, fix applied: ${fixed})`, r.code === 0 && fixed, r.out)
} finally {
  await model.close()
  rmSync(ws.tmp, { recursive: true, force: true })
}
