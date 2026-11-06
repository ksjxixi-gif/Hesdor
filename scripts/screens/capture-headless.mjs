#!/usr/bin/env node
// Captures the built CLI (run `pnpm build` first) and writes SVG screenshots to docs/assets/screens/:
//   headless-run.svg   hesdor run --output-format text against a scripted model (stdout + stderr)
//   doctor.svg         hesdor doctor
//   policy-check.svg   hesdor policy check git push --force
//   help.svg           the first 30 lines of hesdor --help
// The model is a local fake server (fixture.mjs); config lives in a temp dir, never your real profile.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ansiToSvg } from './ansi-to-svg.mjs'
import { CLI_DIR, FIX_TURNS, makeWorkspace, OUT_DIR, startFakeModel, tidyPaths } from './fixture.mjs'

const BIN = path.join(CLI_DIR, 'bin/hesdor.js')
const COLS = 96

/** Runs the CLI and returns stdout and stderr interleaved in arrival order. */
function hesdor(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, code }))
  })
}

const quote = (a) => (/[\s"']/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)
/** A shell prompt line, so each image shows the command that produced it. */
const promptLine = (args) => `\x1b[32m~/slugs\x1b[0m \x1b[1m$\x1b[0m hesdor ${args.map(quote).join(' ')}\n`

const ws = makeWorkspace()
const model = await startFakeModel(FIX_TURNS)
mkdirSync(OUT_DIR, { recursive: true })
const providerArgs = ['-p', 'openai-compatible', '--base-url', model.baseUrl, '-m', 'demo-model']

const shots = [
  { file: 'headless-run.svg', title: 'hesdor run', args: ['run', 'Fix the slugify bug and run the tests'], extra: providerArgs },
  { file: 'doctor.svg', title: 'hesdor doctor', args: ['doctor'], extra: providerArgs },
  { file: 'policy-check.svg', title: 'hesdor policy check', args: ['policy', 'check', 'git', 'push', '--force'] },
  { file: 'help.svg', title: 'hesdor --help', args: ['--help'], maxLines: 30 },
]

try {
  for (const shot of shots) {
    const { out, code } = await hesdor([...shot.args, ...(shot.extra ?? [])], { cwd: ws.repo, env: ws.env })
    let body = tidyPaths(out, ws).replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (shot.maxLines) body = body.split('\n').slice(0, shot.maxLines).join('\n')
    // The provider flags only point at the fake server; the prompt line shows the command a user types.
    const svg = ansiToSvg(promptLine(shot.args) + body + '\n', { cols: COLS, title: shot.title })
    writeFileSync(path.join(OUT_DIR, shot.file), svg)
    console.log(`${shot.file}: exit ${code}, ${body.split('\n').length} lines`)
  }
  console.log(`model requests: ${model.requests()}`)
} finally {
  await model.close()
  rmSync(ws.tmp, { recursive: true, force: true })
}
