import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '@hesdor/providers'
import type { ChatMessage, ModelProvider, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { createDefaultRegistry } from './registry.js'
import { runAgentLoop } from './loop.js'
import type { ToolContext } from './context.js'
import type { RunEvent } from '@hesdor/protocol'

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []

  constructor(private readonly steps: StreamChunk[][]) {}

  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left — loop should have stopped')
    for (const chunk of step) yield chunk
  }
}

function testCtx(root: string, mode: ToolContext['mode'], opts?: { approvals?: boolean }): {
  ctx: ToolContext
  events: RunEvent[]
} {
  const events: RunEvent[] = []
  return {
    events,
    ctx: {
      root,
      mode,
      model: 'fake-model',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      requestApproval: () => Promise.resolve(opts?.approvals ?? false),
      approvalsEnabled: opts?.approvals ?? false,
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

function toolCallChunks(id: string, name: string, argsJson: string): StreamChunk[] {
  // Split arguments across two deltas to exercise accumulation.
  const half = Math.max(1, Math.floor(argsJson.length / 2))
  return [
    { type: 'tool_call', index: 0, id, name, argumentsDelta: argsJson.slice(0, half) },
    { type: 'tool_call', index: 0, argumentsDelta: argsJson.slice(half) },
    { type: 'finish', reason: 'tool_calls' },
  ]
}

describe('runAgentLoop event ordering', () => {
  it('emits the full protocol sequence for a read-then-answer run', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([
      toolCallChunks('t1', 'read_file', JSON.stringify({ path: 'package.json' })),
      [
        { type: 'text', text: 'It is ' },
        { type: 'text', text: 'a package.' },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const { ctx, events } = testCtx(root, 'ask')

    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: 'test',
      userPrompt: 'what is this?',
    })

    expect(result.status).toBe('completed')
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'assistant.message',
      'tool.started',
      'tool.completed',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'run.completed',
    ])

    const started = events.find((e) => e.type === 'tool.started')
    assert(started && started.type === 'tool.started')
    expect(started.name).toBe('read_file')
    expect(started.summary).toContain('package.json')

    // Plain text with a header and cat -n style line numbers, not JSON.
    const toolResult = provider.requests[1]?.find((m) => m.role === 'tool_result')
    expect(toolResult?.content).toMatch(/^package\.json \(lines 1-\d+ of \d+\)\n1\t\{/)
  })

  it('accumulates streamed argument fragments before validation', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([toolCallChunks('t9', 'read_file', '{"path":"package.json","limit":3}')])
    const { ctx, events } = testCtx(root, 'ask')

    await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })

    expect(events.some((e) => e.type === 'tool.completed' && e.name === 'read_file')).toBe(true)
  })
})

describe('hard permission enforcement', () => {
  it('refuses WRITE tools in ask mode and reports the refusal to the model', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([
      toolCallChunks('w1', 'write_file', JSON.stringify({ path: 'evil.txt', content: 'x' })),
      [{ type: 'finish', reason: 'stop' }],
    ])
    const { ctx, events } = testCtx(root, 'ask')

    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: '',
      userPrompt: 'write something',
    })

    expect(result.status).toBe('completed')
    const failed = events.find((e) => e.type === 'tool.failed')
    expect(failed).toBeDefined()

    const toolResult = result.messages.find((m) => m.role === 'tool_result')
    expect(toolResult?.isError).toBe(true)
    expect(toolResult?.content).toContain('permission denied')

    // Nothing was written.
    await expect(import('node:fs/promises').then((fs) => fs.stat(`${root}/evil.txt`))).rejects.toThrow()
  })

  it('blocks destructive commands without approval even in build mode', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([
      toolCallChunks('r1', 'run_command', JSON.stringify({ command: 'git reset --hard' })),
      [{ type: 'finish', reason: 'stop' }],
    ])
    const { ctx, events } = testCtx(root, 'build') // approvals disabled

    await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })

    const failed = events.find((e) => e.type === 'tool.failed')
    assert(failed && failed.type === 'tool.failed')
    expect(failed.error.toLowerCase()).toContain('blocked')
  })
})

describe('validation failures', () => {
  it('rejects unknown tools', async () => {
    const provider = new ScriptedProvider([toolCallChunks('u1', 'not_a_tool', '{}')])
    const { ctx, events } = testCtx(process.cwd(), 'build')
    await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })
    const failed = events.find((e): e is Extract<RunEvent, { type: 'tool.failed' }> => e.type === 'tool.failed')
    expect(failed?.error).toContain('unknown tool')
  })

  it('rejects invalid tool arguments via the Zod schema', async () => {
    const provider = new ScriptedProvider([toolCallChunks('v1', 'read_file', '{"limit": -5}')])
    const { ctx, events } = testCtx(process.cwd(), 'build')
    await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })
    const failed = events.find((e): e is Extract<RunEvent, { type: 'tool.failed' }> => e.type === 'tool.failed')
    expect(failed?.error).toContain('invalid arguments')
  })
})

describe('plugin hooks', () => {
  it('lets plugins deny tool calls before execution', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([
      toolCallChunks('p1', 'read_file', '{"path":"package.json"}'),
      [{ type: 'finish', reason: 'stop' }],
    ])
    const { ctx, events } = testCtx(root, 'build')
    const seen: string[] = []

    await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: '',
      userPrompt: '',
      plugins: [
        {
          name: 'guard',
          file: 'guard.mjs',
          hooks: {
            event: (event) => seen.push(event.type),
            'tool.execute.before': () => Promise.resolve({ deny: 'not allowed' }),
          },
        },
      ],
    })

    const failed = events.find((e): e is Extract<RunEvent, { type: 'tool.failed' }> => e.type === 'tool.failed')
    expect(failed?.error).toContain('blocked by plugin "guard"')
    // Event hooks observed the whole lifecycle.
    expect(seen).toContain('run.started')
    expect(seen).toContain('tool.failed')
  })
})

describe('explore subagent hook', () => {
  it('delegates to ctx.subagent and returns its synthesis', async () => {
    const root = process.cwd()
    const provider = new ScriptedProvider([
      toolCallChunks('x1', 'explore', '{"task":"trace auth flows"}'),
      [{ type: 'text', text: 'done investigating' }, { type: 'finish', reason: 'stop' }],
    ])
    const { ctx } = testCtx(root, 'ask')
    ctx.subagent = (task, maxSteps) => Promise.resolve(`sub=(${task},${maxSteps})`)

    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: '',
      userPrompt: 'delegate',
    })

    const toolResult = result.messages.find((m) => m.role === 'tool_result')
    expect(toolResult?.content).toContain('sub=(trace auth flows,5)')
  })
})

describe('step budget', () => {
  const reads = (n: number): StreamChunk[][] =>
    Array.from({ length: n }, (_, i) => toolCallChunks(`r${i}`, 'read_file', JSON.stringify({ path: 'package.json', limit: i + 1 })))

  it('stops after maxSteps, then asks once for a summary and reports max_steps', async () => {
    const provider = new ScriptedProvider([
      ...reads(4),
      // The model tries another tool in the summary turn: the call is dropped, the text kept.
      [{ type: 'text', text: 'Did X, Y remains.' }, ...toolCallChunks('late', 'list_files', '{}')],
    ])
    const { ctx, events } = testCtx(process.cwd(), 'build')

    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: '',
      userPrompt: '',
      maxSteps: 4,
    })

    expect(result.status).toBe('max_steps')
    expect(provider.requests).toHaveLength(5)
    expect(provider.requests[4]!.at(-1)!.content).toContain('step budget is used up')
    const last = result.messages.at(-1)!
    expect(last).toMatchObject({ role: 'assistant', content: 'Did X, Y remains.' })
    expect(last.toolCalls).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', steps: 4 })
  })

  it('adds a wrap-up notice to the tool result at 80% of the budget', async () => {
    const provider = new ScriptedProvider([...reads(5), [{ type: 'text', text: 'summary' }]])
    const { ctx } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '', maxSteps: 5 })
    const results = result.messages.filter((m) => m.role === 'tool_result')
    expect(results.map((m) => m.content.includes('4 of 5 tool steps used'))).toEqual([false, false, false, true, false])
  })
})

describe('loop detection', () => {
  it('refuses the 3rd identical call, and counts again after an edit', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-loopdet-'))
    const same = (id: string): StreamChunk[] => toolCallChunks(id, 'list_files', '{}')
    const provider = new ScriptedProvider([
      same('a'),
      same('b'),
      same('c'),
      toolCallChunks('w', 'write_file', JSON.stringify({ path: 'x.txt', content: 'x' })),
      same('d'),
      [{ type: 'text', text: 'ok' }],
    ])
    const { ctx } = testCtx(root, 'build', { approvals: true })
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })
    const byId = new Map(result.messages.filter((m) => m.role === 'tool_result').map((m) => [m.toolCallId, m]))
    expect(byId.get('b')!.isError).toBe(false)
    expect(byId.get('c')!.isError).toBe(true)
    expect(byId.get('c')!.content).toContain('you are looping')
    expect(byId.get('d')!.isError).toBe(false)
  })

  it('refuses the 5th edit to the same path once', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-loopedit-'))
    const write = (i: number): StreamChunk[] => toolCallChunks(`w${i}`, 'write_file', JSON.stringify({ path: 'f.txt', content: `v${i}` }))
    const provider = new ScriptedProvider([...[1, 2, 3, 4, 5, 6].map(write), [{ type: 'text', text: 'done' }]])
    const { ctx } = testCtx(root, 'build', { approvals: true })
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })
    const errors = result.messages.filter((m) => m.role === 'tool_result').map((m) => m.isError)
    expect(errors).toEqual([false, false, false, false, true, false])
    expect(result.messages.find((m) => m.toolCallId === 'w5')!.content).toContain('edit #5 to f.txt')
  })
})

describe('tool specs', () => {
  it('sends the same name-sorted tool list in every mode', async () => {
    const seen: string[] = []
    const provider: ModelProvider = {
      name: 'spy',
      model: 'm',
      // eslint-disable-next-line require-yield
      async *stream(_messages, tools) {
        seen.push(JSON.stringify(tools))
        return
      },
    }
    for (const mode of ['build', 'plan', 'ask'] as const) {
      const { ctx } = testCtx(process.cwd(), mode)
      await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: '', userPrompt: '' })
    }
    expect(new Set(seen).size).toBe(1)
    const names = (JSON.parse(seen[0]!) as ToolSpec[]).map((t) => t.name)
    expect(names).toEqual([...names].sort())
    expect(names).toContain('write_file')
  })
})

describe('context compaction', () => {
  const big = 'x'.repeat(40_000) // about 10k tokens each

  it('prunes old tool outputs, then summarizes when still too big, keeping pairing valid', async () => {
    const history: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `task ${i} ${big}` })
      history.push({ role: 'assistant', content: '', toolCalls: [{ id: `h${i}`, name: 'list_files', argumentsJson: '{}' }] })
      history.push({ role: 'tool_result', toolCallId: `h${i}`, content: big })
      history.push({ role: 'assistant', content: `done ${i}` })
    }
    const provider = new ScriptedProvider([
      [{ type: 'text', text: '## Goal\nship it' }, { type: 'finish', reason: 'stop' }], // the summary request
      [{ type: 'text', text: 'answer' }, { type: 'finish', reason: 'stop' }],
    ])
    const { ctx, events } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: 'sys',
      userPrompt: 'next',
      history,
      contextWindow: 100_000,
    })
    expect(result.status).toBe('completed')
    expect(result.compacted).toBe(true)
    // The summary request has no tools in its history and its own system prompt.
    expect(provider.requests[0]![0]!.content).toContain('handoff summary')
    const sent = provider.requests[1]!
    expect(sent[0]).toEqual({ role: 'system', content: 'sys' })
    expect(sent[1]!.content).toMatch(/^\[summary of the earlier conversation\]\n## Goal/)
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'next' })
    // Every kept tool result still follows its call.
    for (const [i, m] of sent.entries()) {
      if (m.role === 'tool_result') expect(sent.slice(0, i).some((a) => a.toolCalls?.some((c) => c.id === m.toolCallId))).toBe(true)
    }
    const ev = events.find((e) => e.type === 'context.compacted')
    expect(ev).toMatchObject({ type: 'context.compacted', phase: 'summary' })
    assert(ev?.type === 'context.compacted')
    expect(ev.afterTokens).toBeLessThan(ev.beforeTokens)
  })

  it('compacts and retries once when the provider reports a context overflow', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'older follow-up' },
      { role: 'assistant', content: 'ok' },
    ]
    let calls = 0
    const requests: ChatMessage[][] = []
    const provider: ModelProvider = {
      name: 'overflow',
      model: 'm',
      async *stream(messages) {
        requests.push([...messages])
        calls++
        if (calls === 1) throw Object.assign(new Error('prompt is too long'), { kind: 'context_overflow', retryable: false })
        if (calls === 2) {
          yield { type: 'text', text: 'summary' }
          return
        }
        yield { type: 'text', text: 'fine now' }
      },
    }
    const { ctx, events } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 's', userPrompt: 'now', history })
    expect(result.status).toBe('completed')
    expect(calls).toBe(3)
    expect(requests[2]!.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
    expect(events.some((e) => e.type === 'context.compacted')).toBe(true)
  })

  it('fails with the overflow error when there is nothing to compact', async () => {
    const provider: ModelProvider = {
      name: 'overflow',
      model: 'm',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw Object.assign(new Error('prompt is too long'), { kind: 'context_overflow', retryable: false })
      },
    }
    const { ctx } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 's', userPrompt: 'hi' })
    expect(result.status).toBe('failed')
    expect(result.error).toBe('prompt is too long')
  })
})

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

describe('runAgentLoop robustness', () => {
  it('does not store an empty assistant turn', async () => {
    const provider = new ScriptedProvider([[{ type: 'finish', reason: 'stop' }]])
    const { ctx } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 'sys', userPrompt: 'hi' })
    expect(result.status).toBe('completed')
    expect(result.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('stops the remaining tool calls of a step once cancelled', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-loop-'))
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', index: 0, id: 'w1', name: 'write_file', argumentsDelta: JSON.stringify({ path: 'a.txt', content: 'a' }) },
        { type: 'tool_call', index: 1, id: 'w2', name: 'write_file', argumentsDelta: JSON.stringify({ path: 'b.txt', content: 'b' }) },
        { type: 'finish', reason: 'tool_calls' },
      ],
    ])
    const controller = new AbortController()
    const { ctx } = testCtx(root, 'build', { approvals: true })
    ctx.signal = controller.signal
    ctx.emit = (event) => {
      if (event.type === 'tool.completed') controller.abort() // the user presses Esc during call 1
    }
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 'sys', userPrompt: 'go' })
    expect(result.status).toBe('cancelled')
    expect(existsSync(path.join(root, 'a.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'b.txt'))).toBe(false)
    // Every tool call still has a result, so the history stays valid for resume.
    const results = result.messages.filter((m) => m.role === 'tool_result')
    expect(results.map((m) => m.toolCallId)).toEqual(['w1', 'w2'])
    expect(results[1]!.isError).toBe(true)
  })
})

describe('reasoning round-trip', () => {
  it('stores reasoning and provider state on the assistant message and emits reasoning events', async () => {
    const state = { tag: 'scripted', blob: 'sig' }
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', text: 'let me ' },
        { type: 'reasoning', text: 'look' },
        { type: 'provider_state', state },
        ...toolCallChunks('t1', 'read_file', JSON.stringify({ path: 'package.json' })),
      ],
      [{ type: 'text', text: 'done' }, { type: 'finish', reason: 'stop' }],
    ])
    const { ctx, events } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 'sys', userPrompt: 'hi' })
    expect(result.status).toBe('completed')
    const [first, last] = result.messages.filter((m) => m.role === 'assistant')
    expect(first!.reasoning).toBe('let me look')
    expect(first!.providerState).toEqual(state)
    // The next request hands the state back to the provider.
    expect(provider.requests[1]!.find((m) => m.role === 'assistant')!.providerState).toEqual(state)
    expect(events.flatMap((e) => (e.type === 'assistant.reasoning' ? [e.text] : []))).toEqual(['let me ', 'look'])
    expect(last!.reasoning).toBeUndefined()
    expect(last!.providerState).toBeUndefined()
  })
})

describe('provider retries (real OpenAI-compatible adapter, mocked fetch)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const ok = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

  function run(responses: Array<() => Response>, signal?: AbortSignal) {
    const fetchMock = vi.fn()
    for (const r of responses) fetchMock.mockImplementationOnce(() => Promise.resolve(r()))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, events } = testCtx(process.cwd(), 'ask')
    if (signal) ctx.signal = signal
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://x.test/v1', model: 'm' })
    const result = runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 's', userPrompt: 'u' })
    return { fetchMock, events, ctx, result }
  }

  /** Drive fake setTimeout until the run settles; Response bodies still stream on real ticks. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false
    void p.finally(() => (done = true))
    while (!done) {
      await vi.advanceTimersByTimeAsync(1000)
      await new Promise((r) => setImmediate(r))
    }
    return p
  }

  it('waits for Retry-After on a 429, then succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchMock, events, result } = run([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      () => new Response(ok),
    ])
    const res = await settle(result)
    expect(res.status).toBe('completed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.filter((e) => e.type === 'provider.retry')).toEqual([
      { type: 'provider.retry', attempt: 1, maxAttempts: 4, delayMs: 2000, reason: 'rate limited' },
    ])
    expect(events.filter((e) => e.type === 'assistant.delta')).toHaveLength(1)
  })

  it('gives up after 4 attempts on repeated 500s with a classified error and hint', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchMock, events, result } = run(Array.from({ length: 4 }, () => () => new Response('boom', { status: 500 })))
    const res = await settle(result)
    expect(res.status).toBe('failed')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(events.filter((e) => e.type === 'provider.retry').map((e) => e.type === 'provider.retry' && e.reason)).toEqual([
      'provider overloaded',
      'provider overloaded',
      'provider overloaded',
    ])
    expect(res.error).toContain('HTTP 500')
    expect(res.error).toContain('hint: the provider is overloaded')
  })

  it('does not retry a 401', async () => {
    const { fetchMock, events, result } = run([() => new Response('{"error":"invalid api key"}', { status: 401 })])
    const res = await result
    expect(res.status).toBe('failed')
    expect(res.error).toContain('hesdor setup')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'provider.retry')).toBe(false)
  })

  it('cancels when aborted during the backoff wait', async () => {
    const controller = new AbortController()
    const { fetchMock, ctx, result } = run(
      [() => new Response('', { status: 429, headers: { 'retry-after': '30' } }), () => new Response(ok)],
      controller.signal,
    )
    const emit = ctx.emit
    ctx.emit = (event) => {
      emit(event)
      if (event.type === 'provider.retry') setImmediate(() => controller.abort())
    }
    const res = await result
    expect(res.status).toBe('cancelled')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never retries once output has streamed', async () => {
    const partial = `data: ${JSON.stringify({ choices: [{ delta: { content: 'par' } }] })}\n\n`
    const { fetchMock, result } = run([() => new Response(partial), () => new Response(ok)])
    const res = await result
    expect(res.status).toBe('failed')
    expect(res.error).toContain('stream ended unexpectedly')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('output token limit', () => {
  it('does not run a tool call whose JSON was cut off, tells the model, and continues', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-trunc-'))
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', index: 0, id: 'w1', name: 'write_file', argumentsDelta: '{"path":"big.txt","content":"aaaa' },
        { type: 'finish', reason: 'length' },
      ],
      [{ type: 'text', text: 'split it' }, { type: 'finish', reason: 'stop' }],
    ])
    const { ctx } = testCtx(root, 'build', { approvals: true })
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 's', userPrompt: 'u' })
    expect(result.status).toBe('completed')
    expect(existsSync(path.join(root, 'big.txt'))).toBe(false)
    const second = provider.requests[1]!
    expect(second.find((m) => m.role === 'assistant')!.toolCalls![0]!.argumentsJson).toBe('{}')
    const toolResult = second.find((m) => m.role === 'tool_result')!
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toContain('max output token limit')
    expect(toolResult.content).toContain('apply_patch')
  })

  it('flags a final answer cut off by the token limit', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'half an ans' }, { type: 'finish', reason: 'length' }]])
    const { ctx, events } = testCtx(process.cwd(), 'ask')
    const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx, systemPrompt: 's', userPrompt: 'u' })
    expect(result.truncated).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', truncated: true })
  })
})
