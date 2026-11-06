import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliFlags } from './args.js'
import { runHeadless } from './headless.js'
import type { ChatMessage, ModelProvider, StreamChunk, ToolSpec } from '@hesdor/protocol'

// Sessions and config land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

/** Replays one chunk list per model call, recording the requests it saw. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []
  constructor(private readonly steps: Array<StreamChunk[] | Error>) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    if (step instanceof Error) throw step
    for (const chunk of step) yield chunk
  }
}

const call = (id: string, name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, ready: true } },
]
const answer = (text: string, tokens = 11): StreamChunk[] => [
  { type: 'text', text },
  { type: 'finish', reason: 'stop', usage: { inputTokens: tokens - 1, outputTokens: 1, totalTokens: tokens, ready: true } },
]

const flags = (extra: Partial<CliFlags> = {}): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, ...extra })

/** Run headless in a plain (non-git) temp dir and capture stdout lines. */
async function run(provider: ScriptedProvider, f: CliFlags, cwd: string, prompt = 'hello') {
  const out: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const code = await runHeadless('ask', prompt, f, { provider, cwd })
  write.mockRestore()
  return { code, lines: out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }
}

afterEach(() => vi.restoreAllMocks())

describe('headless machine output', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-headless-'))

  it('stream-json prints init, every event, nested subagent events and a result', async () => {
    const provider = new ScriptedProvider([call('p1', 'explore', { task: 'list files' }), answer('sub answer'), answer('final')])
    const { code, lines } = await run(provider, flags({ outputFormat: 'stream-json' }), cwd)
    expect(code).toBe(0)
    expect(lines[0]).toMatchObject({ type: 'init', provider: 'scripted', model: 'fake-model', mode: 'ask' })
    expect(lines[0]!.tools).toContain('read_file')
    expect(lines.map((l) => l.type)).toEqual(expect.arrayContaining(['run.started', 'tool.started', 'subagent', 'run.completed']))
    const result = lines.at(-1)!
    expect(result).toMatchObject({ type: 'result', status: 'completed', result: 'final', steps: 2, error: null, error_category: null })
    expect(result.session_id).toBe(lines[0]!.session_id)
    expect((result.usage as { totalTokens: number }).totalTokens).toBe(33)
  })

  it('json prints only the result; -o writes the answer; -c continues the latest session', async () => {
    const outFile = path.join(cwd, 'answer.txt')
    const first = await run(new ScriptedProvider([answer('first answer')]), flags({ outputFormat: 'json', outputFile: outFile }), cwd, 'first')
    expect(first.lines).toHaveLength(1)
    expect(first.lines[0]).toMatchObject({ type: 'result', status: 'completed', result: 'first answer' })
    expect(readFileSync(outFile, 'utf8')).toBe('first answer')

    const provider = new ScriptedProvider([answer('second answer')])
    const second = await run(provider, flags({ outputFormat: 'json', continue: true }), cwd, 'second')
    expect(second.lines[0]!.session_id).toBe(first.lines[0]!.session_id)
    expect(provider.requests[0]!.map((m) => m.content)).toEqual(expect.arrayContaining(['first', 'first answer', 'second']))

    const byId = await run(new ScriptedProvider([answer('third')]), flags({ outputFormat: 'json', resume: String(first.lines[0]!.session_id) }), cwd)
    expect(byId.lines[0]!.session_id).toBe(first.lines[0]!.session_id)
  })

  it('exits 3 with an error category when the provider fails', async () => {
    const err = Object.assign(new Error('rate limited'), { kind: 'rate_limit' })
    const { code, lines } = await run(new ScriptedProvider([err]), flags({ outputFormat: 'json' }), cwd)
    expect(code).toBe(3)
    expect(lines[0]).toMatchObject({ status: 'failed', error: 'rate limited', error_category: 'rate_limit' })
  })

  it('reports an unknown session as a failed result', async () => {
    const { code, lines } = await run(new ScriptedProvider([]), flags({ outputFormat: 'json', resume: 'nope' }), cwd)
    expect(code).toBe(1)
    expect(lines[0]).toMatchObject({ status: 'failed', session_id: null, error_category: 'session' })
  })
})
