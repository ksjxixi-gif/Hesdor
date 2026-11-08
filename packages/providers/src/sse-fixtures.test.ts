import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider, StreamChunk } from '@hesdor/protocol'
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { OpenAIResponsesProvider } from './openai-responses.js'
import { ProviderError } from './provider.js'
import { sseData } from './sse.js'

/**
 * SSE robustness: every fixture in __fixtures__ (hand-authored or recorded with
 * scripts/record-fixture.mjs) must produce the same StreamChunk sequence however
 * the network splits its bytes, and with LF or CRLF line endings.
 */

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url))
const SEEDS = 20

type Adapter = 'openai-compatible' | 'anthropic' | 'openai-responses'

function makeProvider(adapter: Adapter): ModelProvider {
  if (adapter === 'anthropic') return new AnthropicProvider({ baseUrl: 'http://fixture.test', model: 'm', apiKey: 'k' })
  if (adapter === 'openai-responses') return new OpenAIResponsesProvider({ baseUrl: 'http://fixture.test/v1', model: 'm', apiKey: 'k' })
  return new OpenAICompatibleProvider({ baseUrl: 'http://fixture.test/v1', model: 'm', apiKey: 'k' })
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Split at random byte offsets: mostly tiny pieces (1-8 bytes) with some larger ones. */
function randomCuts(bytes: Uint8Array, seed: number): number[] {
  const next = rng(seed)
  const cuts: number[] = []
  for (let at = 0; at < bytes.length; ) {
    at += next() < 0.7 ? 1 + Math.floor(next() * 8) : 1 + Math.floor(next() * 200)
    if (at < bytes.length) cuts.push(at)
  }
  return cuts
}

/** Split inside every multi-byte UTF-8 character, inside every "data:" prefix and between every CR and LF. */
function hostileCuts(bytes: Uint8Array): number[] {
  const text = Buffer.from(bytes).toString('latin1') // 1 char per byte, so indexes are byte offsets
  const cuts = new Set<number>()
  for (let i = 1; i < bytes.length; i++) {
    if ((bytes[i]! & 0xc0) === 0x80) cuts.add(i) // UTF-8 continuation byte
    if (text[i - 1] === '\r' && text[i] === '\n') cuts.add(i)
  }
  for (let i = text.indexOf('data:'); i >= 0; i = text.indexOf('data:', i + 1)) {
    cuts.add(i + 2)
    cuts.add(i + 5)
  }
  return [...cuts].sort((a, b) => a - b)
}

function split(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const parts: Uint8Array[] = []
  let from = 0
  for (const cut of [...cuts, bytes.length]) {
    if (cut > from) parts.push(bytes.slice(from, cut))
    from = cut
  }
  return parts
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]!)
      else controller.close()
    },
  })
}

/** Run one adapter over a body delivered as `parts`; returns the chunks and the error, if any. */
async function run(adapter: Adapter, parts: Uint8Array[]): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf(parts), { headers: { 'content-type': 'text/event-stream' } })))
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of makeProvider(adapter).stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const toLf = (s: string): string => s.replace(/\r\n/g, '\n')
const toCrlf = (s: string): string => toLf(s).replace(/\n/g, '\r\n')
const adapterOf = (file: string): Adapter =>
  file.startsWith('openai-responses.') ? 'openai-responses' : file.startsWith('anthropic.') ? 'anthropic' : 'openai-compatible'

afterEach(() => {
  vi.unstubAllGlobals()
})

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.sse'))

describe('SSE fixtures survive arbitrary re-chunking', () => {
  it('has fixtures for every adapter', () => {
    expect(new Set(files.map(adapterOf))).toEqual(new Set(['openai-compatible', 'anthropic', 'openai-responses']))
  })

  for (const file of files) {
    const adapter = adapterOf(file)
    // Git may check fixtures out with CRLF on Windows; the baseline is always the LF body in one piece.
    const lf = toLf(readFileSync(path.join(FIXTURES, file), 'utf8'))

    describe(file, () => {
      it('parses in one piece and ends with a finish chunk', async () => {
        const { chunks, error } = await run(adapter, [enc(lf)])
        expect(error).toBeUndefined()
        expect(chunks.at(-1)?.type).toBe('finish')
      })

      it(`gives identical chunks for ${SEEDS} random byte splits, byte-at-a-time, hostile splits, LF and CRLF`, async () => {
        const baseline = await run(adapter, [enc(lf)])
        for (const body of [lf, toCrlf(lf)]) {
          const bytes = enc(body)
          const variants: Array<[string, Uint8Array[]]> = [
            ['whole', [bytes]],
            ['byte-at-a-time', split(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1))],
            ['hostile', split(bytes, hostileCuts(bytes))],
            ...Array.from({ length: SEEDS }, (_, seed): [string, Uint8Array[]] => [`seed ${seed}`, split(bytes, randomCuts(bytes, seed + 1))]),
          ]
          for (const [label, parts] of variants) {
            const got = await run(adapter, parts)
            expect(got, `${file} ${body === lf ? 'LF' : 'CRLF'} ${label}`).toEqual(baseline)
          }
        }
      })
    })
  }
})

/** Fold chunks into what the agent loop would see. */
function fold(chunks: StreamChunk[]) {
  const calls = new Map<number, { id?: string; name?: string; args: string }>()
  let text = ''
  let reasoning = ''
  for (const c of chunks) {
    if (c.type === 'text') text += c.text
    if (c.type === 'reasoning') reasoning += c.text
    if (c.type === 'tool_call') {
      const acc = calls.get(c.index) ?? { args: '' }
      if (c.id) acc.id = c.id
      if (c.name) acc.name = c.name
      acc.args += c.argumentsDelta
      calls.set(c.index, acc)
    }
  }
  const finish = chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish')
  const state = chunks.find((c): c is Extract<StreamChunk, { type: 'provider_state' }> => c.type === 'provider_state')?.state
  return { text, reasoning, calls: [...calls.values()].map((c) => ({ ...c, args: JSON.parse(c.args) as unknown })), finish, state }
}

const fixture = (name: string): Uint8Array => enc(toLf(readFileSync(path.join(FIXTURES, name), 'utf8')))

describe('hand-authored fixtures decode to the expected turn', () => {
  it('openai-compatible: reasoning, unicode text, two tool calls, usage after finish', async () => {
    const { chunks, error } = await run('openai-compatible', [fixture('openai-compatible.tool-calls.sse')])
    expect(error).toBeUndefined()
    const turn = fold(chunks)
    expect(turn.reasoning).toBe('The user wants the greeting localized — check src/i18n.ts first.')
    expect(turn.text).toBe('Héllo — 世界 🚀 مرحبا. Reading two files.')
    expect(turn.calls).toEqual([
      { id: 'call_7Qm1', name: 'read_file', args: { path: 'src/i18n.ts' } },
      { id: 'call_7Qm2', name: 'search_files', args: { pattern: 'greet("ü")' } },
    ])
    expect(turn.finish).toEqual({ type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290, cacheReadTokens: 1024, ready: true } })
  })

  it('anthropic: signed thinking, text, tool_use and cache-aware usage', async () => {
    const { chunks, error } = await run('anthropic', [fixture('anthropic.thinking-tool.sse')])
    expect(error).toBeUndefined()
    const turn = fold(chunks)
    expect(turn.reasoning).toBe('Need to patch the café menu ☕.')
    expect(turn.text).toBe('Updating the menu: crème brûlée 🍮, 抹茶 and شاي.')
    expect(turn.calls).toEqual([{ id: 'toolu_01A', name: 'apply_patch', args: { path: 'menu.md', edits: [{ find: 'tea', replace: 'thé 🍵' }] } }])
    expect(turn.state).toMatchObject({ thinking: [{ type: 'thinking', thinking: 'Need to patch the café menu ☕.', signature: 'EqQBCkgIARABGAIiQL2s/sig==' }] })
    expect(turn.finish).toEqual({
      type: 'finish',
      reason: 'tool_calls',
      usage: { inputTokens: 412 + 2048 + 8192, outputTokens: 87, totalTokens: 412 + 2048 + 8192 + 87, cacheReadTokens: 8192, cacheWriteTokens: 2048, ready: true },
    })
  })

  it('openai-responses: reasoning summary, encrypted reasoning state, text and a function call', async () => {
    const { chunks, error } = await run('openai-responses', [fixture('openai-responses.reasoning-tool.sse')])
    expect(error).toBeUndefined()
    const turn = fold(chunks)
    expect(turn.reasoning).toBe('**Planning** the fix — naïve approach first')
    expect(turn.text).toBe('Running the tests 🧪 für Ünïcode — 日本語.')
    expect(turn.calls).toEqual([{ id: 'call_Rz9', name: 'run_command', args: { command: 'pnpm test' } }])
    expect(turn.state).toMatchObject({ reasoning: [{ id: 'rs_01', encrypted_content: 'gAAAAABo8x-ENCRYPTED==' }] })
    expect(turn.finish).toMatchObject({ reason: 'tool_calls', usage: { inputTokens: 5000, outputTokens: 300, totalTokens: 5300, cacheReadTokens: 4096 } })
  })
})

/** Build an SSE body from `data` payloads plus raw lines (comments, event:, blanks). */
const sse = (...items: Array<string | object>): string =>
  items.map((i) => (typeof i === 'string' ? `${i}\n` : `data: ${JSON.stringify(i)}\n\n`)).join('')

/** Run a fault body whole and byte-at-a-time; both must agree. */
async function runFault(adapter: Adapter, body: string) {
  const bytes = enc(body)
  const whole = await run(adapter, [bytes])
  const tiny = await run(adapter, split(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)))
  expect(tiny).toEqual(whole)
  return whole
}

describe('SSE fault cases', () => {
  const oaText = (content: string) => ({ choices: [{ index: 0, delta: { content } }] })
  const oaStop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }

  it('ignores comments, keep-alives, event: and id: lines, retry: hints and blank data lines', async () => {
    const body = sse(
      ': OPENROUTER PROCESSING',
      '',
      ':keep-alive',
      'event: message',
      'id: 1',
      'retry: 3000',
      oaText('a'),
      'data:',
      '',
      'data: ',
      '',
      ': ping',
      '',
      oaText('b'),
      oaStop,
      'data:[DONE]', // no space after the colon
      '',
    )
    const { chunks, error } = await runFault('openai-compatible', body)
    expect(error).toBeUndefined()
    expect(chunks).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('openai-compatible: an error object mid-stream keeps earlier chunks and throws a classified error', async () => {
    const body = sse(oaText('partial '), { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } })
    const { chunks, error } = await runFault('openai-compatible', body)
    expect(chunks).toEqual([{ type: 'text', text: 'partial ' }])
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('rate_limit')
    expect((error as ProviderError).retryable).toBe(true)
  })

  it('anthropic: pings are ignored and an overloaded error event mid-stream throws', async () => {
    const body = sse(
      'event: message_start',
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      'event: ping',
      { type: 'ping' },
      'event: content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'event: content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ✓' } },
      'event: error',
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    )
    const { chunks, error } = await runFault('anthropic', body)
    expect(chunks).toEqual([{ type: 'text', text: 'Hi ✓' }])
    expect((error as ProviderError).kind).toBe('overloaded')
  })

  it('openai-responses: an error event and response.failed both throw classified errors', async () => {
    const delta = { type: 'response.output_text.delta', item_id: 'm', delta: 'ok' }
    const err = await runFault('openai-responses', sse('event: response.output_text.delta', delta, 'event: error', { type: 'error', code: 'server_error', message: 'The server had an error' }))
    expect(err.chunks).toEqual([{ type: 'text', text: 'ok' }])
    expect((err.error as ProviderError).kind).toBe('overloaded')

    const failed = await runFault('openai-responses', sse(delta, { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } }))
    expect((failed.error as ProviderError).kind).toBe('rate_limit')
  })

  it('a stream cut before its terminator is a retryable network error for every adapter', async () => {
    const cases: Array<[Adapter, string]> = [
      ['openai-compatible', sse(oaText('half'))],
      ['anthropic', sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } })],
      ['openai-responses', sse({ type: 'response.output_text.delta', delta: 'half' })],
    ]
    for (const [adapter, body] of cases) {
      const { chunks, error } = await runFault(adapter, body)
      expect(chunks, adapter).toEqual([{ type: 'text', text: 'half' }])
      expect((error as ProviderError).kind, adapter).toBe('network')
      expect((error as ProviderError).retryable, adapter).toBe(true)
    }
  })

  it('a body of only garbage is reported as unparseable instead of an empty answer', async () => {
    const { error } = await runFault('openai-compatible', 'data: <html>502 Bad Gateway</html>\n\n')
    expect(String((error as Error).message)).toContain('unparseable stream data')
  })

  it('recognizes lone CR line endings (spec: CRLF | LF | CR), and a CRLF split across chunks', async () => {
    const { chunks, error } = await run('openai-compatible', [enc(sse(oaText('x'), oaStop).replace(/\n/g, '\r'))])
    expect(error).toBeUndefined()
    expect(chunks).toEqual([{ type: 'text', text: 'x' }, { type: 'finish', reason: 'stop' }])

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const part of ['data: a\r', '\ndata: b\r', '\r\n', 'data: c\n']) c.enqueue(enc(part))
        c.close()
      },
    })
    const lines: string[] = []
    for await (const d of sseData(new Response(body))) lines.push(d)
    expect(lines).toEqual(['a', 'b', 'c'])
  })
})
