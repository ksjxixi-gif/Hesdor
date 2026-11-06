import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@hesdor/protocol'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'
import { httpError, mapFetchError, ProviderError } from './provider.js'

afterEach(() => vi.unstubAllGlobals())

const sse = (events: unknown[]): string =>
  events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function openai(body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  return drain(new OpenAICompatibleProvider({ baseUrl: 'http://x.test/v1', model: 'm' }).stream([], [], new AbortController().signal))
}

function anthropic(body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  return drain(new AnthropicProvider({ baseUrl: 'http://x.test', model: 'm', apiKey: 'k' }).stream([], [], new AbortController().signal))
}

describe('httpError classification', () => {
  it('reads Retry-After seconds on a 429 and marks it retryable', async () => {
    const err = await httpError(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
    expect(err).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 2000, status: 429 })
  })

  it('reads Retry-After as an HTTP date and caps it at 60s', async () => {
    const soon = new Date(Date.now() + 10_000).toUTCString()
    const err = await httpError(new Response('', { status: 503, headers: { 'retry-after': soon } }))
    expect(err.kind).toBe('overloaded')
    expect(err.retryAfterMs).toBeGreaterThan(8000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(10_000)
    const far = await httpError(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
    expect(far.retryAfterMs).toBe(60_000)
  })

  it.each([
    [401, '{"error":"bad key"}', 'auth', 'hesdor setup'],
    [404, '{"error":"model foo not found"}', 'model_not_found', 'hesdor model'],
    [400, '{"error":"prompt is too long: 210000 tokens"}', 'context_overflow', '/compact'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'quota_exhausted', 'billing'],
    [400, '{"error":"tools: unexpected field"}', 'bad_request', 'hesdor doctor'],
  ])('HTTP %i -> %s, not retryable, with a hint', async (status, body, kind, hint) => {
    const err = await httpError(new Response(body, { status }))
    expect(err.kind).toBe(kind)
    expect(err.retryable).toBe(false)
    expect(err.message).toContain(`hint: `)
    expect(err.message).toContain(hint)
  })

  it('keeps aborts as aborts and does not retry a refused connection', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(mapFetchError(abort, 'p')).toBe(abort)
    const refused = mapFetchError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), 'p') as ProviderError
    expect(refused.message).toContain('ECONNREFUSED')
    expect(refused).toMatchObject({ kind: 'network', retryable: false })
    expect(mapFetchError(new TypeError('fetch failed'), 'p')).toMatchObject({ kind: 'network', retryable: true })
  })
})

describe('stream termination', () => {
  it('OpenAI: a stream that stops without finish_reason or [DONE] throws a retryable error', async () => {
    const err = await openai(sse([{ choices: [{ delta: { content: 'par' } }] }])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ kind: 'network', retryable: true })
    expect((err as Error).message).toContain('stream ended unexpectedly')
  })

  it('Anthropic: a stream without message_stop or stop_reason throws', async () => {
    const body = sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }])
    await expect(anthropic(body)).rejects.toThrow('stream ended unexpectedly')
  })

  it('a stream of only unparseable data errors instead of reporting success', async () => {
    await expect(openai('data: upstream timeout\n\ndata: [DONE]\n\n')).rejects.toThrow(/unparseable stream data: upstream timeout/)
    await expect(anthropic('data: <html>bad gateway</html>\n\n')).rejects.toThrow(/unparseable/)
  })

  it('reports the output-token limit as reason length on both adapters', async () => {
    const o = await openai(sse([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }, '[DONE]']))
    expect(o.at(-1)).toMatchObject({ type: 'finish', reason: 'length' })
    const a = await anthropic(sse([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]))
    expect(a.at(-1)).toMatchObject({ type: 'finish', reason: 'length' })
  })

  it('classifies in-stream error events', async () => {
    const err = await anthropic(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'overloaded', retryable: true })
  })
})
