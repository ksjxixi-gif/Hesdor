import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@hesdor/protocol'
import { getPreset } from '@hesdor/providers'
import type { CliFlags } from '../args.js'
import { promptImages } from '../images.js'
import type { TurnResult } from '../run.js'
import {
  addTurn,
  coerceField,
  continuingTurn,
  displayWidth,
  expandCommand,
  formContent,
  formFields,
  goalNotice,
  imageNotices,
  modelForProvider,
  paletteTarget,
  profileModelNote,
  providerRefusal,
  rewindableCheckpoints,
  rewindChat,
  runFlags,
  scopeAfterRewind,
  selectionProblem,
  turnNotice,
  wrapText,
  managedLock,
} from './logic.js'

const flags: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }

describe('addTurn', () => {
  it('sums usage and cost across turns and keeps the latest context size', () => {
    const one = addTurn({}, { usage: { ready: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }, costUsd: 0.01, contextTokens: 110 })
    const two = addTurn(one, { usage: { ready: true, inputTokens: 200, outputTokens: 20 }, costUsd: 0.02, contextTokens: 330 })
    expect(two.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 50 })
    expect(two.costUsd).toBeCloseTo(0.03)
    expect(two.contextTokens).toBe(330)
  })

  it('leaves cost unknown when no turn had a price, and keeps context when a turn reports none', () => {
    const s = addTurn({ contextTokens: 5 }, {})
    expect(s.costUsd).toBeUndefined()
    expect(s.contextTokens).toBe(5)
  })
})

describe('runFlags', () => {
  it('lets the session provider and model beat -p/-m (CLI-5)', () => {
    const f = runFlags({ ...flags, provider: 'groq', model: 'old' }, 'groq', 'openrouter', 'x/y')
    expect(f).toMatchObject({ provider: 'openrouter', model: 'x/y' })
  })

  it('keeps --base-url only for the provider it was given with', () => {
    const f = { ...flags, baseUrl: 'http://localhost:1234/v1' }
    expect(runFlags(f, 'local', 'local', 'm').baseUrl).toBe('http://localhost:1234/v1')
    expect(runFlags(f, 'local', 'openai', 'm').baseUrl).toBeUndefined()
  })

  it('uses the session effort, which can clear the launch --effort', () => {
    expect(runFlags({ ...flags, effort: 'high' }, 'p', 'p', 'm', 'low').effort).toBe('low')
    expect(runFlags({ ...flags, effort: 'high' }, 'p', 'p', 'm', undefined).effort).toBeUndefined()
  })
})

describe('modelForProvider', () => {
  it("uses the target provider's saved model, else its preset default, never the old one", () => {
    expect(modelForProvider({ provider: 'openai', models: { groq: 'llama-x' } }, 'groq')).toBe('llama-x')
    expect(modelForProvider({ provider: 'openai', model: 'gpt-legacy' }, 'groq')).toBe(getPreset('groq')!.defaultModel)
    expect(modelForProvider({}, 'my-gateway')).toBe('local-model')
  })
})

describe('paletteTarget (CLI-12)', () => {
  const filtered = [{ name: 'resume' }, { name: 'reload' }]
  it('runs the highlighted command for a bare prefix', () => {
    expect(paletteTarget('/re', filtered, 1)).toBe('reload')
    expect(paletteTarget('/', filtered, 0)).toBe('resume')
  })
  it('runs typed input with arguments or without matches', () => {
    expect(paletteTarget('/resume 2', filtered, 1)).toBeUndefined()
    expect(paletteTarget('/zzz', [], 0)).toBeUndefined()
  })
})

describe('rewindChat', () => {
  it('drops the checkpoint turn and everything after it, returning its prompt', () => {
    const history = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'd' },
    ]
    expect(rewindChat(history, { turnIndex: 2, prompt: 'c' })).toEqual({ history: history.slice(0, 2), prompt: 'c' })
  })
})

describe('rewind scope', () => {
  const cp = (sessionId: string, turnIndex: number) => ({ sessionId, turnIndex })
  const all = [cp('B', 4), cp('A', 6), cp('A', 4), cp('A', 2), cp('A', 0), cp('X', 0)]

  it('offers only the session own checkpoints without a rewind', () => {
    expect(rewindableCheckpoints(all, 'A', [])).toEqual([cp('A', 6), cp('A', 4), cp('A', 2), cp('A', 0)])
  })

  it('carries the old session checkpoints up to the rewound turn into the new session', () => {
    const scope = scopeAfterRewind([], 'A', 4)
    expect(rewindableCheckpoints(all, 'B', scope)).toEqual([cp('B', 4), cp('A', 4), cp('A', 2), cp('A', 0)])
  })

  it('narrows earlier sessions on a second rewind to an older turn', () => {
    const scope = scopeAfterRewind(scopeAfterRewind([], 'A', 4), 'B', 2)
    expect(scope).toEqual([
      { sessionId: 'A', maxTurn: 2 },
      { sessionId: 'B', maxTurn: 2 },
    ])
    expect(rewindableCheckpoints(all, 'C', scope)).toEqual([cp('A', 2), cp('A', 0)])
  })
})

describe('profileModelNote', () => {
  it('notes a session-only model when the profile picked the main model', () => {
    const eff = { profile: { name: 'balanced' }, sources: { provider: 'profile', profile: 'user' } }
    expect(profileModelNote(eff, 'gpt-x')).toBe(
      'profile balanced picks the model at each start: gpt-x applies to this session; to keep it, use `hesdor config set profile none` or start with -m gpt-x',
    )
    expect(profileModelNote({ ...eff, sources: { provider: 'profile', profile: 'env' } }, 'gpt-x')).not.toContain('config set')
  })

  it('says nothing without a profile or when -p/-m chose the model', () => {
    expect(profileModelNote({ sources: {} }, 'm')).toBeUndefined()
    expect(profileModelNote({ profile: { name: 'economy' }, sources: { provider: 'flag' } }, 'm')).toBeUndefined()
  })
})

describe('wrapText', () => {
  it('wraps at word boundaries, hard-wraps long words and keeps blank lines', () => {
    expect(wrapText('hello brave new world', 11)).toEqual(['hello brave', 'new world'])
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('counts wide characters as two columns', () => {
    expect(displayWidth('日本')).toBe(4)
    expect(wrapText('日本語テキスト', 6)).toEqual(['日本語', 'テキス', 'ト'])
    for (const row of wrapText('漢字 and words mixed 漢字漢字漢字', 8)) expect(displayWidth(row)).toBeLessThanOrEqual(8)
  })
})

describe('providerRefusal / selectionProblem', () => {
  it('refuses providers outside the managed allow list or other than a locked provider', () => {
    expect(providerRefusal({ allowedProviders: ['openai'] }, 'groq')).toMatch(/not allowed by managed settings/)
    expect(providerRefusal({ allowedProviders: ['openai'] }, 'openai')).toBeUndefined()
    expect(providerRefusal({ provider: 'openai' }, 'groq')).toMatch(/locked to "openai"/)
    expect(providerRefusal({}, 'groq')).toBeUndefined()
  })

  it('reports a missing credential after the managed check', () => {
    expect(selectionProblem({}, { providerId: 'groq', keySource: 'environment' })).toBeUndefined()
    expect(selectionProblem({}, { providerId: 'groq', keySource: 'none', envKey: 'GROQ_API_KEY' })).toMatch(/no API key for groq .*GROQ_API_KEY/)
    expect(selectionProblem({}, { providerId: 'chatgpt', keySource: 'none' })).toMatch(/not signed in to ChatGPT/)
    expect(selectionProblem({ allowedProviders: [] }, { providerId: 'groq', keySource: 'none' })).toMatch(/not allowed/)
  })
})

describe('expandCommand', () => {
  it('fills $ARGUMENTS, or awaits an MCP prompt expansion', async () => {
    expect(await expandCommand({ template: 'fix $ARGUMENTS now' }, 'the bug')).toBe('fix the bug now')
    expect(await expandCommand({ template: 'unused', expand: async (a) => `server text for ${a}` }, 'x')).toBe('server text for x')
  })
})

describe('images', () => {
  it('attaches @-mentioned workspace images and notes text-only models', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-ui-img-'))
    writeFileSync(path.join(root, 'shot.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]))
    const images = await promptImages([], 'what is in @shot.png and @missing.png?', root, root)
    expect(images).toHaveLength(1)
    expect(imageNotices(images.length, 'm', true)).toEqual([{ text: '📎 1 image attached', tone: 'info' }])
    expect(imageNotices(2, 'm', false).map((n) => n.tone)).toEqual(['info', 'warn'])
    expect(imageNotices(0, 'm', false)).toEqual([])
  })
})

describe('turnNotice / goalNotice', () => {
  it('turns a ChatGPT plan quota error into "Usage limit reached" with the manage-usage link', () => {
    const n = turnNotice({ status: 'failed', error: 'ChatGPT plan usage limit reached', errorKind: 'quota_exhausted' }, 'chatgpt')
    expect(n?.text).toMatch(/^Usage limit reached · Manage usage: https:\/\//)
    expect(turnNotice({ status: 'failed', error: 'billing', errorKind: 'quota_exhausted' }, 'openai')?.text).toBe('billing')
    expect(turnNotice({ status: 'completed' }, 'openai')).toBeUndefined()
    expect(turnNotice({ status: 'budget_exceeded' }, 'openai', 2)?.text).toMatch(/\$2/)
  })

  it('summarizes the goal outcome', () => {
    expect(goalNotice({ status: 'met', reason: 'tests pass', turns: 2 })).toEqual({ text: 'goal met after 2 turns: tests pass', tone: 'success' })
    expect(goalNotice({ status: 'cancelled', reason: 'cancelled', turns: 1 }).tone).toBe('warn')
    expect(goalNotice({ status: 'failed', reason: 'boom', turns: 1 }).tone).toBe('error')
  })
})

describe('continuingTurn', () => {
  it('continues the shared history across goal turns and passes images only to the first', async () => {
    const history = { current: [{ role: 'user', content: 'earlier' }] as ChatMessage[] }
    const seen: Array<{ prompt: string; len: number; first: boolean }> = []
    const after: TurnResult[] = []
    const turn = continuingTurn(
      async (prompt, h, emit, first) => {
        seen.push({ prompt, len: h.length, first })
        emit({ type: 'assistant.delta', text: 'x' })
        const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, ...h, { role: 'user', content: prompt }, { role: 'assistant', content: 'ok' }]
        return { status: 'completed', messages, steps: 1, text: 'ok' }
      },
      history,
      (r) => after.push(r),
    )
    const events: string[] = []
    await turn('one', (e) => events.push(e.type))
    await turn('two', () => {})
    expect(seen).toEqual([
      { prompt: 'one', len: 1, first: true },
      { prompt: 'two', len: 3, first: false },
    ])
    expect(history.current.map((m) => m.content)).toEqual(['earlier', 'one', 'ok', 'two', 'ok'])
    expect(after).toHaveLength(2)
    expect(events).toEqual(['assistant.delta'])
  })
})

describe('elicitation forms', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2, default: 'Ada' },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      ratio: { type: 'number' },
      ok: { type: 'boolean', default: true },
      color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] },
      size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }] },
      tags: { type: 'array', items: { type: 'string', enum: ['a'] } },
    },
    required: ['name', 'age', 'color'],
  }

  it('builds fields with defaults, choices and ranges, and lists unsupported ones', () => {
    const { fields, unsupported } = formFields(schema)
    expect(fields.map((f) => [f.key, f.kind, f.required, f.initial])).toEqual([
      ['name', 'string', true, 'Ada'],
      ['age', 'integer', true, ''],
      ['ratio', 'number', false, ''],
      ['ok', 'boolean', false, 'true'],
      ['color', 'enum', true, ''],
      ['size', 'enum', false, ''],
    ])
    expect(fields[0]).toMatchObject({ label: 'Name', min: 2 })
    expect(fields[1]).toMatchObject({ min: 0, max: 150 })
    expect(fields[4]!.options).toEqual([
      { value: 'r', label: 'Red' },
      { value: 'g', label: 'Green' },
    ])
    expect(fields[5]!.options).toEqual([
      { value: '', label: '(no answer)' },
      { value: 's', label: 'Small' },
    ])
    expect(unsupported).toEqual([{ key: 'tags', required: false }])
    expect(formFields(undefined)).toEqual({ fields: [], unsupported: [] })
  })

  it('coerces and validates values', () => {
    const f = Object.fromEntries(formFields(schema).fields.map((x) => [x.key, x]))
    expect(coerceField(f.age!, ' 42 ')).toEqual({ ok: true, value: 42 })
    expect(coerceField(f.age!, '4.5')).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) })
    expect(coerceField(f.age!, '200')).toMatchObject({ ok: false, error: expect.stringMatching(/at most 150/) })
    expect(coerceField(f.age!, 'x')).toMatchObject({ ok: false })
    expect(coerceField(f.age!, '')).toMatchObject({ ok: false, error: 'age is required' })
    expect(coerceField(f.ratio!, '')).toEqual({ ok: true, value: undefined })
    expect(coerceField(f.ratio!, '0.5')).toEqual({ ok: true, value: 0.5 })
    expect(coerceField(f.ok!, 'false')).toEqual({ ok: true, value: false })
    expect(coerceField(f.ok!, 'yes')).toEqual({ ok: true, value: true })
    expect(coerceField(f.color!, 'Green')).toEqual({ ok: true, value: 'g' })
    expect(coerceField(f.color!, 'blue')).toMatchObject({ ok: false, error: expect.stringMatching(/one of Red, Green/) })
    expect(coerceField(f.name!, 'A')).toMatchObject({ ok: false, error: expect.stringMatching(/at least 2/) })
  })

  it('builds the accepted content, leaving out empty optional fields', () => {
    const { fields } = formFields(schema)
    expect(formContent(fields, { name: 'Ada', age: '36', ok: 'true', color: 'r', ratio: '', size: '' })).toEqual({
      ok: true,
      content: { name: 'Ada', age: 36, ok: true, color: 'r' },
    })
    expect(formContent(fields, { name: 'Ada', color: 'r' })).toMatchObject({ ok: false, error: 'age is required' })
  })
})

describe('managedLock', () => {
  it('refuses changes only to keys an admin locked', () => {
    expect(managedLock({ mode: 'plan' }, 'mode')).toMatch(/mode is locked to "plan"/)
    expect(managedLock({ mode: 'plan' }, 'effort')).toBeUndefined()
    expect(managedLock(undefined, 'mode')).toBeUndefined()
  })
})
