import { describe, expect, it } from 'vitest'
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

    const finalAssistant = provider.requests[1]?.find((m) => m.role === 'tool_result')
    expect(finalAssistant?.content).toContain('"path"')
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
  it('stops after maxSteps and reports max_steps', async () => {
    const endless: StreamChunk[] = toolCallChunks('loop', 'list_files', '{}')
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => [...endless]))
    const { ctx } = testCtx(process.cwd(), 'build')

    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx,
      systemPrompt: '',
      userPrompt: '',
      maxSteps: 4,
    })

    expect(result.status).toBe('max_steps')
    expect(provider.requests).toHaveLength(4)
  })
})

function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}
