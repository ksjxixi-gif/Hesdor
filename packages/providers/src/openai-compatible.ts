import type { ChatMessage, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { httpError, joinUrl, ProviderError } from './provider.js'
import type { ModelProvider } from './provider.js'
import { sseData } from './sse.js'

export interface OpenAICompatibleConfig {
  name?: string
  baseUrl: string
  apiKey?: string
  model: string
  headers?: Record<string, string>
  /** Output token ceiling sent as max_tokens. Keeps gateways like OpenRouter from reserving the whole context. */
  maxTokens?: number
}

interface WireDelta {
  content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}
interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}
interface WireChunk {
  choices?: WireChoice[]
  error?: { message?: string }
}

/**
 * Works against every OpenAI-compatible /chat/completions endpoint:
 * OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, Fireworks, xAI,
 * Ollama, LM Studio, vLLM, and anything else speaking the same protocol.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string
  readonly model: string

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.name = config.name ?? 'openai-compatible'
    this.model = config.model
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toWireMessage),
      stream: true,
      max_tokens: this.config.maxTokens ?? 8192,
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parametersJsonSchema,
        },
      }))
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    }
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`

    let res: Response
    try {
      res = await fetch(joinUrl(this.config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      throw mapFetchError(err, this.name)
    }
    if (!res.ok) throw await httpError(res)

    // Accumulate streamed tool call fragments by index.
    const calls = new Map<number, { id?: string; name?: string; args: string }>()

    for await (const data of sseData(res)) {
      if (!data || data === '[DONE]') continue
      let evt: WireChunk
      try {
        evt = JSON.parse(data) as WireChunk
      } catch {
        continue
      }
      if (evt.error?.message) throw new ProviderError(evt.error.message)
      const choice = evt.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content }
      }
      for (const [i, tc] of (delta?.tool_calls ?? []).entries()) {
        const idx = tc.index ?? i
        const acc = calls.get(idx) ?? { args: '' }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = tc.function.name
        const argsDelta = tc.function?.arguments ?? ''
        if (argsDelta) acc.args += argsDelta
        calls.set(idx, acc)
        yield {
          type: 'tool_call',
          index: idx,
          id: acc.id,
          name: acc.name,
          argumentsDelta: argsDelta,
        }
      }
      if (choice.finish_reason) {
        yield { type: 'finish', reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop' }
      }
    }
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content }
    case 'user':
      return { role: 'user', content: m.content }
    case 'assistant': {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson || '{}' },
        }))
      }
      return msg
    }
    case 'tool_result':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
}

export function mapFetchError(err: unknown, providerName: string): Error {
  if (err instanceof Error && err.name === 'AbortError') return err
  const reason = err instanceof Error ? err.message : String(err)
  return new ProviderError(`could not reach ${providerName}: ${reason}`)
}
