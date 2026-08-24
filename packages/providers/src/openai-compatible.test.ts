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
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.example.test/v1/models')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
