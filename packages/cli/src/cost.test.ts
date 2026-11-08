import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getModelInfo, requestCostUsd } from '@hesdor/providers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliFlags } from './args.js'
import { runHeadless } from './headless.js'
import type { ChatMessage, ModelProvider, StreamChunk, ToolSpec, Usage } from '@hesdor/protocol'

// Sessions and config land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

/** Replays one chunk list per model call; `name`/`model` pick the catalog entry used for prices. */
class ScriptedProvider implements ModelProvider {
  readonly requests: ChatMessage[][] = []
  constructor(
    private readonly steps: StreamChunk[][],
    readonly name = 'anthropic',
    readonly model = 'claude-sonnet-5-5',
  ) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages)
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    for (const chunk of step) yield chunk
  }
}

const usage: Usage = { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 50, totalTokens: 1050, ready: true }
const call = (id: string, name: string, args: object, u: Usage = usage): StreamChunk[] => [
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls', usage: u },
]
const answer = (text: string, u: Usage = usage): StreamChunk[] => [
  { type: 'text', text },
  { type: 'finish', reason: 'stop', usage: u },
]
const flags = (extra: Partial<CliFlags> = {}): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, outputFormat: 'json', ...extra })

async function run(provider: ScriptedProvider, f: CliFlags) {
  const out: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const code = await runHeadless('ask', 'hello', f, { provider, cwd })
  vi.restoreAllMocks()
  return { code, result: JSON.parse(out.join('').trim().split('\n').at(-1)!) as Record<string, unknown> }
}

const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-cost-'))
const perRequest = requestCostUsd(usage, getModelInfo('anthropic', 'claude-sonnet-5-5'))!
afterEach(() => vi.restoreAllMocks())

describe('run cost', () => {
  it('sums catalog-priced requests of the main loop and the explore subagent into cost_usd', async () => {
    const provider = new ScriptedProvider([call('p1', 'explore', { task: 'list files' }), answer('sub answer'), answer('final')])
    const { code, result } = await run(provider, flags())
    expect(code).toBe(0)
    expect(perRequest).toBeGreaterThan(0)
    expect(result.cost_usd).toBeCloseTo(3 * perRequest, 12)
  })

  it('prefers a cost the provider reported', async () => {
    const { result } = await run(new ScriptedProvider([answer('hi', { ...usage, costUsd: 0.25 })]), flags())
    expect(result.cost_usd).toBe(0.25)
  })

  it('is null when no price is known', async () => {
    const { result } = await run(new ScriptedProvider([answer('hi')], 'scripted', 'fake-model'), flags())
    expect(result).toMatchObject({ status: 'completed', cost_usd: null })
  })
})

describe('--max-budget-usd', () => {
  it('stops before the next request once the budget is spent, with exit code 4', async () => {
    const provider = new ScriptedProvider([call('c1', 'list_files', {}), answer('never sent')])
    const { code, result } = await run(provider, flags({ maxBudgetUsd: perRequest / 2 }))
    expect(code).toBe(4)
    expect(provider.requests).toHaveLength(1)
    expect(result).toMatchObject({ status: 'budget_exceeded', steps: 1 })
    expect(result.cost_usd).toBeCloseTo(perRequest, 12)
  })

  it('counts the --goal evaluator cost against the budget', async () => {
    const verdict = answer('{"verdict": "not_yet", "reason": "more"}')
    const provider = new ScriptedProvider([answer('one'), verdict, answer('never sent')])
    const { code, result } = await run(provider, flags({ goal: 'done', maxBudgetUsd: 1.5 * perRequest }))
    expect(code).toBe(4)
    expect(provider.requests).toHaveLength(2)
    expect(result.cost_usd).toBeCloseTo(2 * perRequest, 12)
  })

  it('runs to completion under the budget', async () => {
    const { code } = await run(new ScriptedProvider([call('c1', 'list_files', {}), answer('done')]), flags({ maxBudgetUsd: 100 }))
    expect(code).toBe(0)
  })

  it('refuses a budget for a model without known prices', async () => {
    const provider = new ScriptedProvider([answer('hi')], 'scripted', 'fake-model')
    const { code, result } = await run(provider, flags({ maxBudgetUsd: 1 }))
    expect(code).toBe(1)
    expect(provider.requests).toHaveLength(0)
    expect(result).toMatchObject({ status: 'failed', error_category: 'usage' })
  })
})
