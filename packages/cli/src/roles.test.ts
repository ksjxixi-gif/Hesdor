import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultRegistry, createOracleTool } from '@hesdor/agent-core'
import { ProviderError } from '@hesdor/providers'
import type { ChatMessage, ModelProvider, ProviderErrorKind, RunEvent, StreamChunk, ToolSpec } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import type { ProviderSelection } from './provider-setup.js'
import { resolveRoles } from './roles.js'
import { runTurn } from './run.js'
import type { TurnOptions } from './run.js'

// runTurn reads user permissions and writes checkpoints under the config dir; keys come from a clean auth store.
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

class ScriptedProvider implements ModelProvider {
  readonly requests: ChatMessage[][] = []
  constructor(
    private readonly steps: Array<StreamChunk[] | Error>,
    readonly name = 'scripted',
    readonly model = 'fake-model',
  ) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    if (step instanceof Error) throw step
    for (const chunk of step) yield chunk
  }
}

const usage = (total: number) => ({ inputTokens: total - 1, outputTokens: 1, totalTokens: total, ready: true as const })
const call = (id: string, name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls', usage: usage(11) },
]
const answer = (text: string, total = 11): StreamChunk[] => [
  { type: 'text', text },
  { type: 'finish', reason: 'stop', usage: usage(total) },
]
const fail = (kind: ProviderErrorKind) =>
  new ProviderError(`boom ${kind}`, { kind, retryAfterMs: 0 })

const root = mkdtempSync(path.join(tmpdir(), 'hesdor-roles-'))
writeFileSync(path.join(root, 'notes.txt'), 'the oracle should see this')

function turn(provider: ModelProvider, extra: Partial<TurnOptions> = {}) {
  const events: RunEvent[] = []
  const result = runTurn({
    provider,
    registry: createDefaultRegistry(),
    plugins: [],
    systemPrompt: 'sys',
    prompt: 'go',
    root,
    mode: 'build',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    requestApproval: () => Promise.resolve(false),
    approvalsEnabled: false,
    state: { activeChild: null, snapshots: [], redo: [] },
    ...extra,
  })
  return { result, events }
}

describe('resolveRoles', () => {
  const flags: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }
  const current: ProviderSelection = { providerId: 'openai', kind: 'openai', model: 'main', apiKey: 'sk-main', keySource: 'environment', envKey: 'OPENAI_API_KEY' }
  const saved = process.env.ANTHROPIC_API_KEY
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  })

  it("uses each provider's own key and never another provider's", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    const roles = await resolveRoles(flags, { roles: { small: 'anthropic/claude-small', subagent: 'mini', fallback: ['openai/backup'] } }, current)
    expect(roles.warnings).toEqual([])
    expect(roles.small).toMatchObject({ name: 'anthropic', model: 'claude-small' })
    // No known prefix: a model id for the current provider.
    expect(roles.subagent).toMatchObject({ name: 'openai', model: 'mini' })
    expect(roles.fallback.map((p) => p.model)).toEqual(['backup'])
    expect(roles.status.map((s) => s.ok)).toEqual([true, true, true])
  })

  it('leaves a role without a key out with a one-line warning', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const roles = await resolveRoles(flags, { roles: { small: 'anthropic/claude-small', oracle: 'anthropic/claude-big' } }, current)
    expect(roles.small).toBeUndefined()
    expect(roles.warnings).toHaveLength(2)
    expect(roles.warnings[0]).toMatch(/small model anthropic\/claude-small is unavailable: anthropic needs an API key \(set ANTHROPIC_API_KEY/)
    expect(roles.status.every((s) => !s.ok)).toBe(true)
  })

  it('reports a malformed role instead of throwing', async () => {
    const roles = await resolveRoles(flags, { roles: { small: 42 as unknown as string } }, current)
    expect(roles.warnings[0]).toMatch(/provider\/model/)
  })

  it('enables the guardian headless only with --guardian (and not with --yes)', async () => {
    const cfg = { roles: { small: 'mini' }, guardian: { enabled: true } }
    expect((await resolveRoles(flags, cfg, current)).guardian).toBeDefined()
    expect((await resolveRoles(flags, cfg, current, { headless: true })).guardian).toBeUndefined()
    expect((await resolveRoles({ ...flags, guardian: true }, cfg, current, { headless: true })).guardian?.headless).toBe(true)
    expect((await resolveRoles({ ...flags, guardian: true, yes: true }, cfg, current, { headless: true })).guardian).toBeUndefined()
    // Without a model it is off, with a warning.
    const off = await resolveRoles(flags, { guardian: { enabled: true } }, current)
    expect(off.guardian).toBeUndefined()
    expect(off.warnings[0]).toMatch(/guardian is off/)
  })
})

describe('fallback chain', () => {
  it('switches to the next model after retries on overloaded and emits provider.fallback', async () => {
    const main = new ScriptedProvider([fail('overloaded'), fail('overloaded'), fail('overloaded'), fail('overloaded')], 'main', 'm1')
    const backup = new ScriptedProvider([call('c1', 'list_files', {}), answer('done')], 'backup', 'b1')
    const { result, events } = turn(main, { roles: { fallback: [backup] } })
    const r = await result
    expect(r.status).toBe('completed')
    expect(main.requests).toHaveLength(4)
    // The rest of the turn stays on the fallback model.
    expect(backup.requests).toHaveLength(2)
    expect(events.filter((e) => e.type === 'provider.retry')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'provider.fallback')).toEqual([{ type: 'provider.fallback', from: 'main/m1', to: 'backup/b1', reason: 'overloaded' }])
  })

  it('switches at once on quota_exhausted', async () => {
    const main = new ScriptedProvider([fail('quota_exhausted')], 'main', 'm1')
    const backup = new ScriptedProvider([answer('done')], 'backup', 'b1')
    const { result, events } = turn(main, { roles: { fallback: [backup] } })
    expect((await result).status).toBe('completed')
    expect(events.some((e) => e.type === 'provider.retry')).toBe(false)
  })

  it.each(['auth', 'bad_request'] as const)('does not fall back on %s', async (kind) => {
    const backup = new ScriptedProvider([answer('never')])
    const { result, events } = turn(new ScriptedProvider([fail(kind)]), { roles: { fallback: [backup] } })
    expect(await result).toMatchObject({ status: 'failed', errorKind: kind })
    expect(backup.requests).toHaveLength(0)
    expect(events.some((e) => e.type === 'provider.fallback')).toBe(false)
  })
})

describe('small model compaction', () => {
  it('summarizes with roles.small and counts its usage', async () => {
    const history: ChatMessage[] = []
    for (let i = 0; i < 6; i++) history.push({ role: 'user', content: `question ${i} ${'x'.repeat(200)}` }, { role: 'assistant', content: `answer ${i}` })
    const main = new ScriptedProvider([fail('context_overflow'), answer('done')])
    const small = new ScriptedProvider([answer('the summary', 5)], 'small', 's1')
    const { result, events } = turn(main, { history, roles: { small } })
    const r = await result
    expect(r.status).toBe('completed')
    expect(small.requests).toHaveLength(1)
    expect(small.requests[0]![1]!.content).toMatch(/question 0/)
    expect(events.some((e) => e.type === 'context.compacted' && e.phase === 'summary')).toBe(true)
    expect(r.usage?.totalTokens).toBe(16)
  })
})

describe('oracle tool', () => {
  function oracleTurn(main: ScriptedProvider, oracle: ScriptedProvider) {
    const registry = createDefaultRegistry()
    registry.register(createOracleTool('other/oracle-model'))
    const specs: string[] = []
    const providerFor = (spec: string): Promise<ModelProvider> => {
      specs.push(spec)
      return Promise.resolve(oracle)
    }
    return { ...turn(main, { registry, providerFor }), specs }
  }

  it('attaches files, returns the answer and adds its usage to the turn', async () => {
    const main = new ScriptedProvider([call('o1', 'oracle', { question: 'is this right?', paths: ['notes.txt'] }), answer('ok', 31)])
    const oracle = new ScriptedProvider([answer('looks right', 21)], 'other', 'oracle-model')
    const { result, specs } = oracleTurn(main, oracle)
    const r = await result
    expect(specs).toEqual(['other/oracle-model'])
    const sent = oracle.requests[0]!.at(-1)!.content
    expect(sent).toMatch(/is this right\?/)
    expect(sent).toMatch(/<file path="notes.txt">\nthe oracle should see this/)
    expect(main.requests[1]!.at(-1)!.content).toMatch(/looks right/)
    expect(r.usage?.totalTokens).toBe(11 + 31 + 21)
  })

  it('refuses paths outside the workspace without calling the oracle', async () => {
    const main = new ScriptedProvider([call('o1', 'oracle', { question: 'look', paths: ['../outside.txt'] }), answer('ok')])
    const oracle = new ScriptedProvider([answer('never')])
    const { result, events } = oracleTurn(main, oracle)
    await result
    expect(oracle.requests).toHaveLength(0)
    expect(events.some((e) => e.type === 'tool.failed' && e.name === 'oracle')).toBe(true)
  })
})
