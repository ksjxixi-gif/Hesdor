import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, StreamChunk } from '@hesdor/protocol'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
}

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

/** Builds the assistant message the agent loop would store from these chunks. */
function assistantFrom(chunks: StreamChunk[]): ChatMessage {
  let content = ''
  let reasoning = ''
  let providerState: unknown
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for (const c of chunks) {
    if (c.type === 'text') content += c.text
    else if (c.type === 'reasoning') reasoning += c.text
    else if (c.type === 'provider_state') providerState = c.state
    else if (c.type === 'tool_call') {
      const acc = calls.get(c.index) ?? { id: '', name: '', args: '' }
      if (c.id) acc.id = c.id
      if (c.name) acc.name = c.name
      acc.args += c.argumentsDelta
      calls.set(c.index, acc)
    }
  }
  return {
    role: 'assistant',
    content,
    ...(calls.size ? { toolCalls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, argumentsJson: c.args })) } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(providerState !== undefined ? { providerState } : {}),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call: number): Json =>
  JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as Json

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible reasoning round-trip', () => {
  const deepseekTurn = sse([
    { choices: [{ delta: { reasoning_content: 'need the ' } }] },
    { choices: [{ delta: { reasoning_content: 'file' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'read_file', arguments: '{"path":"a"}' },
                extra_content: { google: { thought_signature: 'sig-1' } },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ finish_reason: 'tool_calls' }] },
    '[DONE]',
  ])
  const done = sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])

  it('emits reasoning chunks and echoes reasoning_content and extra_content on the next request', async () => {
    const fetchMock = mockFetch(deepseekTurn, done)
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const chunks = await drain(provider.stream(history, [], new AbortController().signal))
    expect(chunks.filter((c) => c.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'need the ' },
      { type: 'reasoning', text: 'file' },
    ])
    history.push(assistantFrom(chunks), { role: 'tool_result', toolCallId: 'c1', content: 'data' })
    await drain(provider.stream(history, [], new AbortController().signal))

    const assistant = sentBody(fetchMock, 1).messages[1]
    expect(assistant.reasoning_content).toBe('need the file')
    expect(assistant.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig-1' } })
  })

  it('echoes vLLM/OpenRouter `reasoning` under the same field name', async () => {
    const fetchMock = mockFetch(
      sse([{ choices: [{ delta: { reasoning: 'hmm' } }] }, { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
      done,
    )
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:8000/v1', model: 'm' })
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    history.push(assistantFrom(await drain(provider.stream(history, [], new AbortController().signal))))
    history.push({ role: 'user', content: 'again' })
    await drain(provider.stream(history, [], new AbortController().signal))
    const assistant = sentBody(fetchMock, 1).messages[1]
    expect(assistant.reasoning).toBe('hmm')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })

  it('does not echo reasoning to a different endpoint or from another adapter', async () => {
    const first = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' })
    mockFetch(deepseekTurn)
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    history.push(assistantFrom(await drain(first.stream(history, [], new AbortController().signal))))
    history.push({ role: 'tool_result', toolCallId: 'c1', content: 'data' })
    // A message written by the Anthropic adapter.
    history.push({
      role: 'assistant',
      content: 'x',
      reasoning: 'claude thought',
      providerState: { tag: 'anthropic https://api.anthropic.com', thinking: [] },
    })
    history.push({ role: 'user', content: 'next' })

    const fetchMock = mockFetch(done)
    const openai = new OpenAICompatibleProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' })
    await drain(openai.stream(history, [], new AbortController().signal))
    const assistants = (sentBody(fetchMock, 0).messages as Json[]).filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    for (const m of assistants) {
      expect(m).not.toHaveProperty('reasoning_content')
      expect(m).not.toHaveProperty('reasoning')
      for (const tc of (m.tool_calls ?? []) as Json[]) expect(tc).not.toHaveProperty('extra_content')
    }
  })

  it('sends max_completion_tokens to OpenAI and Azure, max_tokens elsewhere', async () => {
    const cases: Array<[string, string]> = [
      ['https://api.openai.com/v1', 'max_completion_tokens'],
      ['https://myres.openai.azure.com/openai/v1', 'max_completion_tokens'],
      ['https://openrouter.ai/api/v1', 'max_tokens'],
    ]
    for (const [baseUrl, field] of cases) {
      const fetchMock = mockFetch(done)
      await drain(new OpenAICompatibleProvider({ baseUrl, model: 'm', maxTokens: 1000 }).stream([], [], new AbortController().signal))
      const body = sentBody(fetchMock, 0)
      expect(body[field]).toBe(1000)
      expect(Object.keys(body).filter((k) => k.startsWith('max_'))).toEqual([field])
    }
  })
})

describe('Anthropic thinking replay and caching', () => {
  const thinkingTurn = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'it' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG0' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC1' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'reading' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
  const done = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }])

  it('replays thinking blocks with signatures, in order, before text and tool_use', async () => {
    const fetchMock = mockFetch(thinkingTurn, done)
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-x',
      apiKey: 'k',
      headers: { 'x-extra': '1' },
    })
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ]
    const chunks = await drain(provider.stream(history, [], new AbortController().signal))
    expect(chunks.filter((c) => c.type === 'reasoning').map((c) => (c as { text: string }).text).join('')).toBe('plan it')
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({
      usage: { inputTokens: 130, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 5 },
    })
    history.push(assistantFrom(chunks), { role: 'tool_result', toolCallId: 'tu1', content: 'data' })
    await drain(provider.stream(history, [], new AbortController().signal))

    const body = sentBody(fetchMock, 1)
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'plan it', signature: 'SIG0' },
      { type: 'redacted_thinking', data: 'ENC1' },
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a' } },
    ])
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-extra': '1' })
    expect(body).not.toHaveProperty('thinking')
  })

  it('does not replay thinking signed by another endpoint', async () => {
    const fetchMock = mockFetch(done)
    const provider = new AnthropicProvider({ baseUrl: 'https://gateway.example.test', model: 'claude-x', apiKey: 'k' })
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'hi',
        providerState: { tag: 'anthropic https://api.anthropic.com', thinking: [{ type: 'redacted_thinking', data: 'X' }] },
      },
      { role: 'user', content: 'more' },
    ]
    await drain(provider.stream(history, [], new AbortController().signal))
    expect((sentBody(fetchMock, 0).messages[1].content as Json[]).map((b) => b.type)).toEqual(['text'])
  })

  it('marks cache breakpoints on the system prompt and the newest block', async () => {
    const fetchMock = mockFetch(done)
    const provider = new AnthropicProvider({ model: 'claude-x', apiKey: 'k' })
    await drain(
      provider.stream(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', argumentsJson: '{}' }] },
          { role: 'tool_result', toolCallId: 't1', content: 'data' },
        ],
        [],
        new AbortController().signal,
      ),
    )
    const body = sentBody(fetchMock, 0)
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    const marked = (body.messages as Json[]).flatMap((m) => m.content as Json[]).filter((b) => b.cache_control)
    expect(marked).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'data', cache_control: { type: 'ephemeral' } }])
  })
})
