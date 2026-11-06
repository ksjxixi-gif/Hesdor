import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, StreamChunk } from '@hesdor/protocol'
import { OpenAIResponsesProvider } from './openai-responses.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'
import { createProvider, fetchModels } from './factory.js'
import { resolveKey } from './provider.js'

const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

function mockFetch(...bodies: string[]) {
  const fetchMock = vi.fn()
  for (const body of bodies) fetchMock.mockResolvedValueOnce(new Response(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0): any => JSON.parse(fetchMock.mock.calls[call]![1].body as string)
const sentHeaders = (fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> => fetchMock.mock.calls[call]![1].headers

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, total_tokens: 120 }
const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' }
const provider = (extra: Partial<ConstructorParameters<typeof OpenAIResponsesProvider>[0]> = {}) =>
  new OpenAIResponsesProvider({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-6.1-sol', ...extra })

afterEach(() => vi.unstubAllGlobals())

describe('OpenAIResponsesProvider', () => {
  it('streams text and reports usage with cached tokens', async () => {
    const fetchMock = mockFetch(
      sse([
        { type: 'response.created', response: { status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.completed', response: { status: 'completed', usage } },
      ]),
    )
    const chunks = await drain(provider().stream([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], [], new AbortController().signal))
    expect(chunks).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60, ready: true } },
    ])
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses')
    expect(sentHeaders(fetchMock).authorization).toBe('Bearer k')
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'gpt-6.1-sol',
      store: false,
      include: ['reasoning.encrypted_content'],
      instructions: 'sys',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 8192,
    })
  })

  it('streams a function call, stores encrypted reasoning, and replays it with the tool result', async () => {
    const fetchMock = mockFetch(
      sse([
        { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'thinking' },
        { type: 'response.output_item.done', item: reasoningItem },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a"}' },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
      sse([{ type: 'response.completed', response: { status: 'completed' } }]),
    )
    const tools = [{ name: 'read_file', description: 'read', parametersJsonSchema: { type: 'object' } }]
    const chunks = await drain(provider().stream([{ role: 'user', content: 'go' }], tools, new AbortController().signal))
    expect(chunks).toEqual([
      { type: 'reasoning', text: '' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool_call', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '' },
      { type: 'tool_call', index: 0, argumentsDelta: '{"path":' },
      { type: 'tool_call', index: 0, argumentsDelta: '"a"}' },
      { type: 'provider_state', state: { tag: 'openai-responses https://api.openai.com/v1', reasoning: [reasoningItem] } },
      { type: 'finish', reason: 'tool_calls' },
    ])
    expect(sentBody(fetchMock).tools).toEqual([{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object' }, strict: false }])

    const state = (chunks.find((c) => c.type === 'provider_state') as { state: unknown }).state
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', reasoning: 'thinking', providerState: state, toolCalls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a"}' }] },
      { role: 'tool_result', toolCallId: 'call_1', content: 'file text' },
    ]
    await drain(provider().stream(history, tools, new AbortController().signal))
    expect(sentBody(fetchMock, 1).input).toEqual([
      { role: 'user', content: 'go' },
      reasoningItem,
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
    ])

    // Never replayed to another endpoint.
    const other = provider({ baseUrl: 'https://api.x.ai/v1' })
    const fm = mockFetch(sse([{ type: 'response.completed', response: { status: 'completed' } }]))
    await drain(other.stream(history, tools, new AbortController().signal))
    expect(sentBody(fm).input).not.toContainEqual(reasoningItem)
  })

  it('reports an output-limit cut as length', async () => {
    mockFetch(sse([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]))
    const chunks = await drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'length' })
  })

  it('classifies failed responses, error events and truncated streams', async () => {
    mockFetch(sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } }]))
    await expect(drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))).rejects.toMatchObject({ kind: 'rate_limit', retryable: true })

    mockFetch(sse([{ type: 'error', code: 'context_length_exceeded', message: 'maximum context length exceeded' }]))
    await expect(drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))).rejects.toMatchObject({ kind: 'context_overflow' })

    mockFetch(sse([{ type: 'response.output_text.delta', delta: 'partial' }]))
    await expect(drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))).rejects.toMatchObject({ kind: 'network' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"error":{"message":"bad key"}}', { status: 401 })))
    await expect(drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })
})

describe('effort, max tokens and extraBody per wire', () => {
  const done = {
    responses: sse([{ type: 'response.completed', response: { status: 'completed' } }]),
    chat: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    anthropic: sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]),
  }

  it('maps effort to reasoning.effort, reasoning_effort and output_config.effort', async () => {
    const extraBody = { custom_field: 1 }
    let fm = mockFetch(done.responses)
    await drain(provider({ effort: 'high', maxTokens: 999, extraBody }).stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(sentBody(fm)).toMatchObject({ reasoning: { effort: 'high' }, max_output_tokens: 999, custom_field: 1 })

    fm = mockFetch(done.chat)
    await drain(new OpenAICompatibleProvider({ baseUrl: 'https://gw.example/v1', model: 'm', effort: 'low', extraBody }).stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(sentBody(fm)).toMatchObject({ reasoning_effort: 'low', custom_field: 1 })

    fm = mockFetch(done.anthropic)
    await drain(new AnthropicProvider({ apiKey: 'k', model: 'm', effort: 'medium', extraBody }).stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(sentBody(fm)).toMatchObject({ output_config: { effort: 'medium' }, custom_field: 1 })
  })

  it('sends no effort field unless asked', async () => {
    const fm = mockFetch(done.responses, done.anthropic)
    await drain(provider().stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    await drain(new AnthropicProvider({ apiKey: 'k', model: 'm' }).stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(sentBody(fm, 0).reasoning).toBeUndefined()
    expect(sentBody(fm, 1).output_config).toBeUndefined()
  })

  it('anthropic auth header modes: x-api-key, bearer, and none when unset', async () => {
    const fm = mockFetch(done.anthropic, done.anthropic, done.anthropic)
    const run = (cfg: Partial<ConstructorParameters<typeof AnthropicProvider>[0]>) =>
      drain(new AnthropicProvider({ model: 'm', ...cfg }).stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))
    await run({ apiKey: 'k' })
    await run({ apiKey: 'k', authHeader: 'bearer' })
    await run({})
    expect(sentHeaders(fm, 0)['x-api-key']).toBe('k')
    expect(sentHeaders(fm, 1)).toMatchObject({ authorization: 'Bearer k' })
    expect(sentHeaders(fm, 1)['x-api-key']).toBeUndefined()
    expect('x-api-key' in sentHeaders(fm, 2)).toBe(false)
  })

  it('names a gateway in connection errors (L22)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')))
    const p = createProvider({ provider: 'minimax', apiKey: 'k' })
    await expect(drain(p.stream([{ role: 'user', content: 'x' }], [], new AbortController().signal))).rejects.toThrow(/could not reach minimax/)
  })

  it('routes the openai and xai presets to the Responses wire', () => {
    expect(createProvider({ provider: 'openai', apiKey: 'k' })).toBeInstanceOf(OpenAIResponsesProvider)
    expect(createProvider({ provider: 'xai', apiKey: 'k' })).toBeInstanceOf(OpenAIResponsesProvider)
    expect(createProvider({ provider: 'x', customKind: 'openai-responses', baseUrl: 'https://gw/v1' })).toBeInstanceOf(OpenAIResponsesProvider)
  })
})

describe('apiKeyCommand', () => {
  it('runs the command without a shell and caches the key', async () => {
    const argv = [process.execPath, '-e', 'process.stdout.write("tok-" + Date.now() + "\\n")']
    const first = await resolveKey({ apiKeyCommand: argv })
    expect(first).toMatch(/^tok-\d+$/)
    expect(await resolveKey({ apiKeyCommand: argv })).toBe(first)
    // A shell metacharacter is a literal argument, never interpreted.
    expect(await resolveKey({ apiKeyCommand: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'a&&b'] })).toBe('a&&b')
  })

  it('fails as an auth error without leaking output', async () => {
    await expect(resolveKey({ apiKeyCommand: [process.execPath, '-e', 'process.exit(3)'] })).rejects.toMatchObject({ kind: 'auth', retryable: false })
    await expect(resolveKey({ apiKeyCommand: [process.execPath, '-e', ''] })).rejects.toThrow(/printed no key/)
  })
})

describe('fetchModels', () => {
  it('follows Anthropic pagination and filters non-chat models', async () => {
    const fm = mockFetch(
      JSON.stringify({ data: [{ id: 'claude-b' }], has_more: true, last_id: 'claude-b' }),
      JSON.stringify({ data: [{ id: 'claude-a' }], has_more: false, last_id: 'claude-a' }),
    )
    expect(await fetchModels({ provider: 'anthropic', apiKey: 'k' })).toEqual(['claude-a', 'claude-b'])
    expect(fm.mock.calls[1]![0]).toContain('after_id=claude-b')
    expect(fm.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)

    mockFetch(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'gpt-6-tts' }] }))
    expect(await fetchModels({ provider: 'openai', apiKey: 'k' })).toEqual(['gpt-6.1-sol'])
  })

  it('includes the error body and honors the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('no such key', { status: 401 })))
    await expect(fetchModels({ provider: 'openai', apiKey: 'k' })).rejects.toThrow('could not list models (HTTP 401): no such key')

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))))
    await expect(fetchModels({ provider: 'openai', apiKey: 'k', timeoutMs: 20 })).rejects.toThrow(/timeout|aborted/i)
  })
})
