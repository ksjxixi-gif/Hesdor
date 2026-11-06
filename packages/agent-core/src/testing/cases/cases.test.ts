import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentMode, AgentResult, ModelProvider, RunEvent } from '@hesdor/protocol'
import type { ToolContext } from '../../context.js'
import { stopAllJobs } from '../../exec.js'
import { runAgentLoop } from '../../loop.js'
import { createDefaultRegistry } from '../../registry.js'
import { loadCassette, RecordingProvider, ReplayProvider } from '../replay.js'

/**
 * Regression suite (report §9, G5): hand-authored cassettes replayed through the real
 * agent loop and real tools in a throwaway Git repository. Each cassette's `match`
 * blocks pin what the loop must send back to the model, so drift fails loudly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = 'export function greet(name: string): string {\n  return `hello ${name}`\n}\n'
const repos: string[] = []

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-case-'))
  repos.push(root)
  const all = { 'src/app.ts': SAMPLE, 'README.md': '# demo\n', ...files }
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), content)
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@hesdor.dev')
  git('config', 'user.name', 'Hesdor Test')
  git('config', 'core.autocrlf', 'false')
  git('add', '.')
  git('commit', '-m', 'initial')
  return root
}

interface CaseRun {
  result: AgentResult
  events: RunEvent[]
  subEvents: RunEvent[]
  replay: ReplayProvider
  ctx: ToolContext
  root: string
}

async function runCase(
  name: string,
  opts: {
    prompt: string
    mode?: AgentMode
    files?: Record<string, string>
    /** Called for every event; may abort the run or touch the repo. */
    onEvent?: (event: RunEvent, run: { root: string; abort: () => void }) => void
  },
): Promise<CaseRun> {
  const root = makeRepo(opts.files)
  const replay = new ReplayProvider(loadCassette(path.join(HERE, `${name}.json`)))
  const registry = createDefaultRegistry()
  const controller = new AbortController()
  const events: RunEvent[] = []
  const subEvents: RunEvent[] = []
  const ctx: ToolContext = {
    root,
    mode: opts.mode ?? 'build',
    model: replay.model,
    signal: controller.signal,
    emit: (event) => {
      events.push(event)
      opts.onEvent?.(event, { root, abort: () => controller.abort() })
    },
    requestApproval: () => Promise.resolve(false),
    approvalsEnabled: false,
    state: { activeChild: null, snapshots: [], redo: [] },
    // Same shape as the CLI's explore wiring (packages/cli/src/run.ts): read-only tools, ask mode, own state.
    subagent: async (task, maxSteps = 5) => {
      const sub = await runAgentLoop({
        provider: replay,
        registry: registry.readOnly(),
        ctx: { ...ctx, mode: 'ask', emit: (e) => subEvents.push(e), state: { activeChild: null, snapshots: [], redo: [] } },
        systemPrompt: 'subagent',
        userPrompt: task,
        maxSteps,
      })
      const last = sub.messages.filter((m) => m.role === 'assistant' && m.content).at(-1)
      return last?.content ?? sub.error ?? 'subagent produced no answer'
    },
  }
  const result = await runAgentLoop({ provider: replay, registry, ctx, systemPrompt: 'test', userPrompt: opts.prompt })
  return { result, events, subEvents, replay, ctx, root }
}

const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), 'utf8')
const types = (events: RunEvent[]): string[] => events.map((e) => e.type)
const failedTools = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: 'tool.failed' }> => e.type === 'tool.failed')

/** Surface the loop's own error first: it explains an unused cassette better than the count does. */
function done(result: AgentResult, replay: ReplayProvider): void {
  if (result.status === 'failed') throw new Error(`run failed: ${result.error}`)
  replay.assertDone()
}

afterAll(async () => {
  await stopAllJobs()
  for (const root of repos) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('replay regression cases', () => {
  it('read-then-edit: read_file then apply_patch, usage summed over steps', async () => {
    const { result, replay, root } = await runCase('read-then-edit', { prompt: 'Rename greet to welcome' })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(read(root, 'src/app.ts')).toBe(SAMPLE.replace('greet(', 'welcome('))
    expect(result.usage).toMatchObject({ inputTokens: 3000, outputTokens: 112, totalTokens: 3112 })
    // The text streamed before the tool call is kept on the assistant turn.
    expect(result.messages.find((m) => m.role === 'assistant')?.content).toBe('Let me look at the file first.')
  })

  it('crlf-edit: an LF patch on a CRLF file keeps CRLF line endings', async () => {
    const { result, replay, root } = await runCase('crlf-edit', {
      prompt: 'change line two',
      files: { 'notes.txt': 'line one\r\nline two\r\nline three\r\n' },
    })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(read(root, 'notes.txt')).toBe('line one\r\nline 2\r\nline three\r\n')
  })

  it('background-job: start, read output, stop', async () => {
    const { result, replay, ctx } = await runCase('background-job', {
      prompt: 'start the server and check it',
      files: { 'server.js': "console.log('ready')\nsetInterval(() => console.log('tick'), 100)\n" },
    })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(ctx.state.jobs?.get('job1')?.running).toBe(false)
  })

  it('policy-refusal: a blocked rm -rf is reported to the model, which recovers with delete_file', async () => {
    const { result, replay, events, root } = await runCase('policy-refusal', {
      prompt: 'clean the build output',
      files: { 'build/out.txt': 'artifact\n' },
    })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(failedTools(events).map((e) => e.name)).toEqual(['run_command'])
    expect(existsSync(path.join(root, 'build/out.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'build'))).toBe(true) // rm -rf never ran
  })

  it('truncated-tool-call: a call cut by the token limit is not run and is stored as {}', async () => {
    const { result, replay, events, root } = await runCase('truncated-tool-call', { prompt: 'write big.txt' })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(read(root, 'big.txt')).toBe('part one\n')
    const firstTurn = result.messages.find((m) => m.role === 'assistant')
    expect(firstTurn?.toolCalls).toEqual([{ id: 'c1', name: 'write_file', argumentsJson: '{}' }])
    expect(failedTools(events)[0]?.error).toContain('cut off')
  })

  it('rate-limit-retry: a 429 before output is retried once and the run completes', async () => {
    const { result, replay, events } = await runCase('rate-limit-retry', { prompt: 'say hello' })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(events.filter((e) => e.type === 'provider.retry')).toEqual([
      { type: 'provider.retry', attempt: 1, maxAttempts: 4, delayMs: 0, reason: 'rate limited' },
    ])
    expect(types(events).filter((t) => t === 'assistant.delta')).toHaveLength(1) // nothing streamed twice
  })

  it('cancel-mid-batch: cancelling after the first write skips the second and keeps history valid', async () => {
    const { result, replay, root } = await runCase('cancel-mid-batch', {
      prompt: 'write a and b',
      onEvent: (event, run) => {
        if (event.type === 'file.changed') run.abort()
      },
    })
    done(result, replay)
    expect(result.status).toBe('cancelled')
    expect(read(root, 'a.txt')).toBe('A\n')
    expect(existsSync(path.join(root, 'b.txt'))).toBe(false)
    const results = result.messages.filter((m) => m.role === 'tool_result')
    expect(results.map((m) => [m.toolCallId, m.isError])).toEqual([
      ['c1', false],
      ['c2', true],
    ])
    expect(results[1]?.content).toContain('cancelled')
  })

  it('plan-mode-write: the runtime refuses a write in plan mode and nothing is written', async () => {
    const { result, replay, root } = await runCase('plan-mode-write', { prompt: 'plan the rename', mode: 'plan' })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(existsSync(path.join(root, 'PLAN.md'))).toBe(false)
    expect(result.messages.at(-1)?.content).toContain('Plan:')
  })

  it('explore-subagent: the read-only subagent answers and the main agent uses it', async () => {
    const { result, replay, subEvents } = await runCase('explore-subagent', { prompt: 'Where is greet defined?' })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(result.messages.at(-1)?.content).toBe('It is in src/app.ts, line 1.')
    // Request 2 is the subagent's first: only READ tools are offered.
    const subTools = replay.requests[1]!.tools
    expect(subTools).toContain('search_files')
    expect(subTools).not.toContain('write_file')
    expect(subTools).not.toContain('run_command')
    expect(subEvents.some((e) => e.type === 'tool.completed' && e.name === 'search_files')).toBe(true)
  })

  it('stale-edit: apply_patch refuses a file changed since it was read; re-read keeps the outside edit', async () => {
    let touched = false
    const { result, replay, root } = await runCase('stale-edit', {
      prompt: 'say hi instead of hello',
      onEvent: (event, run) => {
        if (!touched && event.type === 'tool.completed' && event.name === 'read_file') {
          touched = true
          appendFileSync(path.join(run.root, 'src/app.ts'), '// edited outside the agent\n')
        }
      },
    })
    done(result, replay)
    expect(result.status).toBe('completed')
    expect(read(root, 'src/app.ts')).toBe(`${SAMPLE.replace('hello', 'hi')}// edited outside the agent\n`)
  })
})

describe('ReplayProvider', () => {
  it('fails loudly on a request beyond the cassette', async () => {
    const replay = new ReplayProvider({ name: 'one-shot', interactions: [{ chunks: [{ type: 'finish', reason: 'stop' }] }] })
    const drain = async () => {
      for await (const _ of replay.stream([{ role: 'user', content: 'x' }], [], new AbortController().signal)) {
        // drain
      }
    }
    await drain()
    await expect(drain()).rejects.toThrow(/unexpected request #2/)
    expect(() => replay.assertDone()).toThrow(/unexpected request #2/)
  })

  it('fails loudly when the request does not match, and the loop reports it as a failed run', async () => {
    const replay = new ReplayProvider({
      name: 'mismatch',
      interactions: [{ match: { role: 'user', contains: ['expected prompt'] }, chunks: [{ type: 'finish', reason: 'stop' }] }],
    })
    const result = await runAgentLoop({
      provider: replay,
      registry: createDefaultRegistry(),
      ctx: {
        root: process.cwd(),
        mode: 'ask',
        model: 'm',
        signal: new AbortController().signal,
        emit: () => {},
        requestApproval: () => Promise.resolve(false),
        approvalsEnabled: false,
        state: { activeChild: null, snapshots: [], redo: [] },
      },
      systemPrompt: '',
      userPrompt: 'something else',
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('does not contain "expected prompt"')
    expect(() => replay.assertDone()).toThrow(/does not contain/)
  })

  it('RecordingProvider output replays to the same run (chunks, errors and retries included)', async () => {
    for (const name of ['read-then-edit', 'rate-limit-retry']) {
      const source = loadCassette(path.join(HERE, `${name}.json`))
      const recorder = new RecordingProvider(new ReplayProvider(source), name)
      const run = async (provider: ModelProvider) => {
        const events: RunEvent[] = []
        const result = await runAgentLoop({
          provider,
          registry: createDefaultRegistry(),
          ctx: {
            root: makeRepo(),
            mode: 'build',
            model: 'm',
            signal: new AbortController().signal,
            emit: (e) => events.push(e),
            requestApproval: () => Promise.resolve(false),
            approvalsEnabled: false,
            state: { activeChild: null, snapshots: [], redo: [] },
          },
          systemPrompt: 'test',
          userPrompt: name === 'read-then-edit' ? 'Rename greet to welcome' : 'say hello',
        })
        return { status: result.status, events: types(events) }
      }
      const recorded = await run(recorder)
      expect(recorder.cassette.interactions.map((i) => i.chunks)).toEqual(source.interactions.map((i) => i.chunks ?? []))
      expect(recorder.cassette.interactions.map((i) => i.error)).toEqual(source.interactions.map((i) => i.error))
      const replay = new ReplayProvider(structuredClone(recorder.cassette))
      expect(await run(replay)).toEqual(recorded)
      replay.assertDone()
    }
  })

  it('throws when a cassette is not fully used', () => {
    const replay = new ReplayProvider({ name: 'unused', interactions: [{ chunks: [] }] })
    expect(() => replay.assertDone()).toThrow(/used 0 of 1/)
  })
})
