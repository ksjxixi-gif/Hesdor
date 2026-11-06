// Shared setup for the screenshot captures: a throwaway git repository, a config directory that is not
// your real profile, and a scripted OpenAI-compatible server (node:http, SSE) standing in for a model.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CLI_DIR = path.join(ROOT, 'packages/cli')
export const OUT_DIR = path.join(ROOT, 'docs/assets/screens')

/** A small project with one bug for the agent to fix. */
const FILES = {
  'package.json': JSON.stringify({ name: 'slugs', version: '1.0.0', type: 'module', scripts: { test: 'node --test --test-reporter=spec' } }, null, 2) + '\n',
  'src/slug.js': "export function slugify(title) {\n  return title.toLowerCase().replace(' ', '-')\n}\n",
  'test/slug.test.js':
    "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { slugify } from '../src/slug.js'\n\n" +
    "test('lowercases', () => assert.equal(slugify('Hello'), 'hello'))\n" +
    "test('joins every word with a dash', () => assert.equal(slugify('Ship It Now'), 'ship-it-now'))\n",
  'README.md': '# slugs\n\nTurns titles into URL slugs.\n',
}

/** Creates the temp repo and points the config dir at a temp folder. Returns paths and the env to use. */
export function makeWorkspace(prefix = 'hesdor-screens-') {
  const tmp = mkdtempSync(path.join(os.tmpdir(), prefix))
  const config = path.join(tmp, 'config')
  const repo = path.join(tmp, 'slugs')
  mkdirSync(config, { recursive: true })
  for (const [file, content] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), content)
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init'])
  const env = {
    ...process.env,
    APPDATA: config, // keep config, sessions and checkpoints out of the real profile
    XDG_CONFIG_HOME: config,
    HESDOR_NO_UPDATE_CHECK: '1',
    OPENAI_COMPATIBLE_API_KEY: 'sk-demo-not-a-real-key',
  }
  for (const k of Object.keys(env)) if (k.startsWith('HESDOR_') && k !== 'HESDOR_NO_UPDATE_CHECK') delete env[k]
  return { tmp, repo, config, env }
}

/**
 * Scripted model: the n-th chat request gets turns[n] ({ text?, tools?: [{ name, args }] }); requests past
 * the end get the last turn's text only. `intercept(body)` may answer a request (a side call such as the
 * goal evaluator) without using up a turn. GET /models lists `demo-model`.
 */
export async function startFakeModel(turns, { delayMs = 120, intercept } = {}) {
  let n = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'demo-model' }] }))
        return
      }
      let turn = intercept?.(body)
      if (!turn) {
        turn = n < turns.length ? turns[n] : { text: turns.at(-1)?.text ?? 'Done.' }
        n++
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`)
        if (turn.text) for (const piece of turn.text.match(/[\s\S]{1,24}/g)) send({ content: piece })
        const tools = turn.tools ?? []
        tools.forEach((t, i) =>
          send({ tool_calls: [{ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] }),
        )
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: tools.length > 0 ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1800 + n * 400, completion_tokens: 60, total_tokens: 1860 + n * 400 },
          })}\n\n`,
        )
        res.end('data: [DONE]\n\n')
      }, delayMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests: () => n,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** The agent's side of the demo: find the bug, read it, fix it, run the tests, report. */
export const FIX_TURNS = [
  { text: "I'll find the slug helper first.\n", tools: [{ name: 'search_files', args: { pattern: 'slugify' } }] },
  { tools: [{ name: 'read_file', args: { path: 'src/slug.js' } }] },
  {
    text: '`replace` with a string pattern only swaps the first space. Switching to a regex.\n',
    tools: [{ name: 'apply_patch', args: { path: 'src/slug.js', edits: [{ find: ".replace(' ', '-')", replace: ".trim().replace(/\\s+/g, '-')" }] } }],
  },
  { tools: [{ name: 'run_command', args: { command: 'npm test' } }] },
  {
    text:
      'Fixed `slugify` in `src/slug.js`: it replaced only the first space. ' +
      'It now replaces every run of whitespace with one dash. Both tests pass.',
  },
]

/** Replaces temp paths in captured output with a short, stable path. */
export function tidyPaths(text, ws) {
  const variants = (p) => [p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\')]
  for (const p of variants(ws.repo)) text = text.replaceAll(p, '~/slugs')
  for (const p of variants(ws.config)) text = text.replaceAll(p, '~/.config')
  return text
}
