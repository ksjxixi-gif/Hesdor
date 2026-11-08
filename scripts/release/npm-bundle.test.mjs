// node --test scripts/release   (needs `pnpm build` first)
// The npm build is code-split (dist/bundle.js + dist/chunks/): the CLI still starts from bin/hesdor.js,
// --version/--help/doctor never load Ink, the MCP SDK or the ACP SDK, a headless run works against a
// fake model, and the npm tarball carries every chunk.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { CLI_DIR, FIX_TURNS, makeWorkspace, startFakeModel } from '../screens/fixture.mjs'

const BIN = path.join(CLI_DIR, 'bin/hesdor.js')
const DIST = path.join(CLI_DIR, 'dist')
const built = existsSync(path.join(DIST, 'bundle.js')) && existsSync(path.join(DIST, 'chunks'))

const hesdor = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })

/** Files loaded by static imports from `entry` (dynamic import() chunks excluded). */
function staticClosure(entry) {
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from\s*"(\.[^"]+)"/gm)) visit(path.resolve(path.dirname(file), m[1]))
  }
  visit(entry)
  return [...seen]
}
const chunk = (name) => path.join(DIST, 'chunks', readdirSync(path.join(DIST, 'chunks')).find((f) => f.startsWith(`${name}-`)))

describe('npm bundle', { skip: !built && 'run pnpm build first' }, () => {
  let ws
  let model
  before(async () => {
    ws = makeWorkspace('hesdor-bundle-')
    model = await startFakeModel(FIX_TURNS, { delayMs: 0 })
  })
  after(async () => {
    await model?.close()
    if (ws) rmSync(ws.tmp, { recursive: true, force: true })
  })

  test('startup, doctor and headless runs load no Ink, React, MCP SDK or ACP SDK', () => {
    const startup = staticClosure(path.join(DIST, 'bundle.js'))
    assert.ok(startup.length <= 2, `--version/--help should load bundle.js and args only, got ${startup.length} files`)
    for (const file of [...startup, ...staticClosure(chunk('doctor')), ...staticClosure(chunk('headless'))]) {
      const src = readFileSync(file, 'utf8')
      assert.doesNotMatch(src, /from\s*"(ink|react|ink-text-input)"/, file)
      assert.doesNotMatch(src, /node_modules\/\.pnpm\/@(modelcontextprotocol|agentclientprotocol)/, file)
    }
  })

  test('--version, --help and doctor', async () => {
    const { version } = JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'))
    assert.equal((await hesdor(['--version'], { cwd: ws.repo, env: ws.env })).out.trim(), `hesdor ${version}`)
    const help = await hesdor(['--help'], { cwd: ws.repo, env: ws.env })
    assert.equal(help.code, 0)
    assert.match(help.out, /hesdor checkpoints prune \[--all\]/)
    const doctor = await hesdor(['doctor', '-p', 'openai-compatible', '--base-url', model.baseUrl, '-m', 'demo-model'], { cwd: ws.repo, env: ws.env })
    assert.match(doctor.out, /Node\.js/)
    assert.match(doctor.out, /Repository/)
  })

  test('headless run against a fake model', async () => {
    const r = await hesdor(['run', 'Fix the slugify bug and run the tests', '-p', 'openai-compatible', '--base-url', model.baseUrl, '-m', 'demo-model', '-y'], {
      cwd: ws.repo,
      env: ws.env,
    })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Both tests pass/)
    assert.match(readFileSync(path.join(ws.repo, 'src/slug.js'), 'utf8'), /\\s\+/)
  })

  test('npm pack lists bin, bundle.js and every chunk', () => {
    // --ignore-scripts: prepack would rebuild; this checks the files list against the current build.
    const [pack] = JSON.parse(execFileSync('npm pack --dry-run --json --ignore-scripts', { cwd: CLI_DIR, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }))
    const files = new Set(pack.files.map((f) => f.path.replaceAll('\\', '/')))
    for (const f of ['bin/hesdor.js', 'dist/bundle.js', 'LICENSE', 'README.md', ...readdirSync(path.join(DIST, 'chunks')).map((c) => `dist/chunks/${c}`)]) {
      assert.ok(files.has(f), `${f} missing from the tarball`)
    }
    assert.ok(![...files].some((f) => f === 'dist/cli.js' || f.startsWith('src/')), 'tsc output or sources leaked into the tarball')
  })
})
