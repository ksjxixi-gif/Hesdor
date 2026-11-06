import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@hesdor/protocol'
import { createProvider, fetchModels } from './factory.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'

describe('OpenAICompatibleProvider', () => {
  it('emits usage after the finish reason so the loop can account for it', async () => {
    const events = [
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
      '[DONE]',
    ]
    const body = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
    const fetchMock = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:1234/v1', model: 'test' })
      const chunks: StreamChunk[] = []
      for await (const chunk of provider.stream([], [], new AbortController().signal)) chunks.push(chunk)

      expect(chunks).toEqual([
        { type: 'text', text: 'hello' },
        {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, ready: true },
        },
      ])
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
        stream_options: { include_usage: true },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('can omit usage extensions for local gateways', async () => {
    const body = `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    const fetchMock = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: 'http://localhost:11434/v1',
        model: 'test',
        includeUsage: false,
      })
      for await (const _chunk of provider.stream([], [], new AbortController().signal)) {
        // consume the stream
      }

      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('stream_options')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('creates an arbitrary OpenAI-compatible provider when configured explicitly', () => {
    const provider = createProvider({
      provider: 'my-company-gateway',
      customKind: 'openai',
      baseUrl: 'https://llm.example.test/v1',
      model: 'coder-model',
      apiKey: 'test-key',
    })

    expect(provider.name).toBe('my-company-gateway')
    expect(provider.model).toBe('coder-model')
  })

  it('creates an arbitrary Anthropic-compatible provider when configured explicitly', () => {
    const provider = createProvider({
      provider: 'internal-anthropic-gateway',
      customKind: 'anthropic',
      baseUrl: 'https://llm.example.test',
      model: 'internal-model',
    })

    expect(provider).toBeInstanceOf(AnthropicProvider)
    expect(provider.model).toBe('internal-model')
  })

  it('discovers models for a custom Anthropic endpoint without duplicating /v1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'internal-model' }] })))
    vi.stubGlobal('fetch', fetchMock)

    try {
      await expect(
        fetchModels({
          provider: 'internal-anthropic-gateway',
          customKind: 'anthropic',
          baseUrl: 'https://llm.example.test/v1',
          apiKey: 'test-key',
        }),
      ).resolves.toEqual(['internal-model'])
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.example.test/v1/models?limit=1000')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('AnthropicProvider request shape', () => {
  it('drops empty assistant turns instead of sending an empty text block', async () => {
    const body = 'data: {"type":"message_stop"}\n\n'
    const fetchMock = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const provider = new AnthropicProvider({ baseUrl: 'http://localhost:9/', model: 'claude-test', apiKey: 'k' })
      const history = [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: '' }, // stored by older versions after a bare end_turn
        { role: 'user' as const, content: 'second' },
      ]
      for await (const _chunk of provider.stream(history, [], new AbortController().signal)) {
        // drain
      }
      const sent = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
      }
      expect(sent.messages.map((m) => m.role)).toEqual(['user', 'user'])
      expect(sent.messages.flatMap((m) => m.content).some((b) => b.type === 'text' && b.text === '')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('OpenAICompatibleProvider usage details', () => {
  it('reports cached prompt tokens and a provider-reported cost', async () => {
    const events = [
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 80 }, cost: 0.0021 } },
      '[DONE]',
    ]
    const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:1234/v1', model: 'test' })
      const chunks: StreamChunk[] = []
      for await (const chunk of provider.stream([], [], new AbortController().signal)) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', usage: { inputTokens: 100, cacheReadTokens: 80, costUsd: 0.0021 } })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
