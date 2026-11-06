#!/usr/bin/env node
// Renders the built TUI (run `pnpm build` first) with a fake stdin/stdout at 120x30 against a scripted model
// and writes SVG screenshots of its frames to docs/assets/screens/:
//   tui-diff-review.svg  the diff review of the agent's first edit
//   tui-approval.svg     the approval prompt for a command outside the safe list
//   tui-main.svg         the main screen after the answered prompt
//   tui-rewind.svg       the /rewind checkpoint picker
//   tui-goal.svg         a /goal run judged met by the evaluator
//   tui-mcp.svg          the /mcp server list (a local demo stdio server)
//   tui-elicit.svg       an MCP elicitation form
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ansiToSvg } from './ansi-to-svg.mjs'
import { CLI_DIR, FIX_TURNS, makeWorkspace, OUT_DIR, startFakeModel, tidyPaths } from './fixture.mjs'

const COLS = 120
const ROWS = 30

const ws = makeWorkspace('hesdor-tui-')
// Set before Ink and its color library load: config dir, fake key, and full color in a non-TTY process.
for (const k of Object.keys(process.env)) if (!(k in ws.env)) delete process.env[k]
Object.assign(process.env, ws.env, { FORCE_COLOR: '3' })
Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true })
mkdirSync(path.join(ws.config, 'hesdor'), { recursive: true })
writeFileSync(
  path.join(ws.config, 'hesdor', 'mcp.json'),
  JSON.stringify({ mcp: { docs: { command: 'node', args: [path.join(import.meta.dirname, 'mcp-demo-server.mjs')] } } }),
)

// The TUI asks before `node --test` (not on the safe list), so the run shows an approval prompt.
const turns = FIX_TURNS.map((t) => (t.tools?.[0]?.name === 'run_command' ? { tools: [{ name: 'run_command', args: { command: 'node --test' } }] } : t))
turns.push({ text: 'Ran the test suite: 2 passed, 0 failed.' })
const model = await startFakeModel(turns, {
  intercept: (body) =>
    body.includes('You judge whether a coding agent has reached a goal') ? { text: JSON.stringify({ verdict: 'met', reason: 'node --test passes' }) } : undefined,
})

// dist/ui is unbundled, so give it the version the bundle would inject at build time.
globalThis.__HESDOR_VERSION__ = JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version
const imp = (p) => import(pathToFileURL(path.join(CLI_DIR, p)).href)
const React = (await imp('node_modules/react/index.js')).default
const { render } = await imp('node_modules/ink/build/index.js')
const { App } = await imp('dist/ui/App.js')
const { createSession } = await imp('dist/session.js')

class Stdout extends EventEmitter {
  columns = COLS
  rows = ROWS
  isTTY = true
  last = ''
  write = (frame) => {
    this.last = frame
    return true
  }
}
class Stdin extends EventEmitter {
  isTTY = true
  data = null
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data
    this.data = null
    return d
  }
  type(s) {
    this.data = s
    this.emit('readable')
    this.emit('data', s)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const stdout = new Stdout()
const stdin = new Stdin()

/** Waits until the screen shows `text` (approval prompts also need their 300 ms arming delay). */
async function waitFor(text, ms = 8000) {
  const end = Date.now() + ms
  while (!plain(stdout.last).includes(text)) {
    if (Date.now() > end) throw new Error(`timed out waiting for "${text}"; screen:\n${plain(stdout.last)}`)
    await sleep(50)
  }
  await sleep(450)
}
async function type(s) {
  for (const ch of s) {
    stdin.type(ch)
    await sleep(8)
  }
}
async function submit(s) {
  await type(s)
  await sleep(100)
  stdin.type('\r')
}
function shot(file, title) {
  const frame = tidyPaths(stdout.last, ws).replace(/\n$/, '')
  writeFileSync(path.join(OUT_DIR, file), ansiToSvg(frame, { cols: COLS, rows: ROWS, title }))
  console.log(`wrote ${file}`)
}

const session = await createSession({ root: ws.repo, trust: async () => false, warn: (m) => console.log('[session]', m) })
const flags = { yes: false, debug: false, force: false, version: false, help: false, provider: 'openai-compatible', baseUrl: model.baseUrl, model: 'demo-model' }
const app = render(
  React.createElement(App, { info: session.info, flags, providerId: 'openai-compatible', initialModel: 'demo-model', session, keySource: 'local' }),
  { stdout, stdin, stderr: stdout, exitOnCtrlC: false, debug: true, patchConsole: false },
)
const title = 'hesdor · ~/slugs'

try {
  await sleep(600)
  await submit('Fix the slugify bug and run the tests')
  await waitFor('src/slug.js', 10000)
  await waitFor('replace', 10000)
  await sleep(800)
  shot('tui-diff-review.svg', title)
  stdin.type('y')
  await waitFor('node --test', 10000)
  shot('tui-approval.svg', title)
  stdin.type('y')
  await waitFor('Both tests pass', 15000)
  shot('tui-main.svg', title)

  await submit('/goal node --test passes')
  await waitFor('goal met', 15000)
  shot('tui-goal.svg', title)

  await submit('/rewind')
  await sleep(1500)
  shot('tui-rewind.svg', title)
  stdin.type('\x1b')
  await sleep(300)

  // The palette lists MCP prompt commands (/mcp__docs__summarize) before the built-in /mcp: move down to it.
  await type('/mcp')
  await sleep(150)
  stdin.type('\x1b[B')
  await sleep(150)
  stdin.type('\r')
  await sleep(1500)
  shot('tui-mcp.svg', title)
  stdin.type('\x1b')
  await sleep(300)

  if (typeof session.onElicit !== 'function') throw new Error('App did not install session.onElicit')
  const answer = session.onElicit('deploy', {
    message: 'Which environment should I deploy to?',
    requestedSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', title: 'Target', enum: ['staging', 'production'] },
        replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 5, default: 2 },
      },
      required: ['target'],
    },
  })
  await sleep(1000)
  shot('tui-elicit.svg', title)
  stdin.type('\x1b')
  await answer
  console.log(`model requests: ${model.requests()}`)
} finally {
  stdin.type('\x03')
  await Promise.race([app.waitUntilExit(), sleep(2000)])
  session.dispose()
  await model.close()
  rmSync(ws.tmp, { recursive: true, force: true, maxRetries: 5 })
  process.exit(0)
}
