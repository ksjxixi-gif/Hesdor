import type { ChatImage, ChatMessage, StreamChunk, ToolSpec, Usage } from '@hesdor/protocol'
import { imagesFor } from './catalog.js'
import { classify, httpError, joinUrl, mapFetchError, ProviderError, resolveKey } from './provider.js'
import type { Effort, KeySource, ModelProvider } from './provider.js'
import { sseData } from './sse.js'

export interface OpenAICompatibleConfig extends KeySource {
  name?: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
  /**
   * Output token ceiling (max_tokens; max_completion_tokens on OpenAI and Azure OpenAI).
   * Keeps gateways like OpenRouter from reserving the whole context.
   */
  maxTokens?: number
  /** Local gateways may reject the OpenAI usage extension. */
  includeUsage?: boolean
  /** Sent as reasoning_effort. */
  effort?: Effort
  /** Merged into the request body last (gateway-specific fields). */
  extraBody?: Record<string, unknown>
  /** Catalog image support; false replaces images with a note (see imagesFor). */
  imageInput?: boolean
}

interface WireDelta {
  content?: string | null
  /** DeepSeek, Z.ai, Kimi, llama.cpp. */
  reasoning_content?: string | null
  /** vLLM, OpenRouter. */
  reasoning?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
    /** Gemini thought signatures ride here and must be echoed back on the same call. */
    extra_content?: unknown
  }>
}

/** Stored as ChatMessage.providerState. The tag keeps state from leaking to another adapter or endpoint. */
interface OpenAIState {
  tag: string
  reasoningField?: 'reasoning_content' | 'reasoning'
  extraContent?: Record<string, unknown>
}
interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}
interface WireChunk {
  choices?: WireChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    cost?: number
  }
  error?: { message?: string; code?: string | number; type?: string }
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
    const tag = `openai-compatible ${this.config.baseUrl}`
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toWireMessages(messages, tag, this.config.imageInput),
      stream: true,
      // OpenAI reasoning models reject max_tokens; many other gateways only know max_tokens.
      [usesMaxCompletionTokens(this.config.baseUrl) ? 'max_completion_tokens' : 'max_tokens']: this.config.maxTokens ?? 8192,
    }
    if (this.config.includeUsage !== false) body.stream_options = { include_usage: true }
    if (this.config.effort) body.reasoning_effort = this.config.effort
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

    Object.assign(body, this.config.extraBody)

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    }
    const key = await resolveKey(this.config)
    if (key) headers.authorization = `Bearer ${key}`

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

    const extraContent = new Map<number, unknown>()
    let reasoningField: OpenAIState['reasoningField']
    let lastUsage: Usage | undefined
    let finishReason: string | undefined
    let sawDone = false
    let parsed = 0
    let badLine: string | undefined

    for await (const data of sseData(res)) {
      if (data === '[DONE]') sawDone = true
      if (!data || data === '[DONE]') continue
      let evt: WireChunk
      try {
        evt = JSON.parse(data) as WireChunk
        parsed++
      } catch {
        badLine ??= data
        continue
      }
      if (evt.error?.message) {
        const { message, code, type } = evt.error
        throw new ProviderError(message, { kind: classify(undefined, `${message} ${code ?? ''} ${type ?? ''}`) })
      }
      if (evt.usage?.prompt_tokens !== undefined || evt.usage?.total_tokens !== undefined) {
        const cached = evt.usage.prompt_tokens_details?.cached_tokens
        lastUsage = {
          inputTokens: evt.usage.prompt_tokens,
          outputTokens: evt.usage.completion_tokens,
          totalTokens: evt.usage.total_tokens,
          // Cached reads are priced lower; OpenRouter also reports the exact cost itself.
          ...(cached ? { cacheReadTokens: cached } : {}),
          ...(typeof evt.usage.cost === 'number' ? { costUsd: evt.usage.cost } : {}),
          ready: true,
        }
      }
      const choice = evt.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      for (const field of ['reasoning_content', 'reasoning'] as const) {
        const r = delta?.[field]
        if (typeof r === 'string' && r.length > 0) {
          reasoningField = field
          yield { type: 'reasoning', text: r }
          break
        }
      }
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
        if (tc.extra_content !== undefined) extraContent.set(idx, tc.extra_content)
        yield {
          type: 'tool_call',
          index: idx,
          id: acc.id,
          name: acc.name,
          argumentsDelta: argsDelta,
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }

    if (parsed === 0 && badLine !== undefined) {
      throw new ProviderError(`provider sent unparseable stream data: ${badLine.slice(0, 200)}`)
    }
    if (!finishReason && !sawDone) throw new ProviderError('stream ended unexpectedly', { kind: 'network' })

    if (reasoningField || extraContent.size > 0) {
      const state: OpenAIState = { tag, ...(reasoningField ? { reasoningField } : {}) }
      if (extraContent.size > 0) {
        state.extraContent = Object.fromEntries(
          [...extraContent].map(([idx, extra]) => [calls.get(idx)?.id ?? '', extra]),
        )
      }
      yield { type: 'provider_state', state }
    }

    if (finishReason) {
      yield {
        type: 'finish',
        reason: finishReason === 'tool_calls' || finishReason === 'length' ? finishReason : 'stop',
        ...(lastUsage ? { usage: lastUsage } : {}),
      }
    }
  }
}

function usesMaxCompletionTokens(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return false
  }
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')
}

const imagePart = (img: ChatImage): Record<string, unknown> => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })

/**
 * Tool messages take text only, so images from tool results follow the run of tool messages
 * as one user message (inserting it earlier would split the tool results from their call).
 */
function toWireMessages(messages: ChatMessage[], tag: string, imageInput: boolean | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let toolImages: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role !== 'tool_result' && toolImages.length > 0) {
      out.push({ role: 'user', content: toolImages })
      toolImages = []
    }
    const { text, images } = imagesFor(m, imageInput)
    if (m.role === 'tool_result' && images.length > 0) {
      toolImages.push({ type: 'text', text: `Images returned by tool call ${m.toolCallId ?? ''}:` }, ...images.map(imagePart))
    }
    out.push(
      images.length > 0 && m.role === 'user'
        ? { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images.map(imagePart)] }
        : toWireMessage({ ...m, content: text }, tag),
    )
  }
  if (toolImages.length > 0) out.push({ role: 'user', content: toolImages })
  return out
}

function toWireMessage(m: ChatMessage, tag: string): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content }
    case 'user':
      return { role: 'user', content: m.content }
    case 'assistant': {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || '' }
      // Echo reasoning only to the endpoint that produced it; others (api.openai.com) may reject the field.
      const state = (m.providerState as OpenAIState | undefined)?.tag === tag ? (m.providerState as OpenAIState) : undefined
      if (state?.reasoningField && m.reasoning) msg[state.reasoningField] = m.reasoning
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson || '{}' },
          ...(state?.extraContent?.[tc.id] !== undefined ? { extra_content: state.extraContent[tc.id] } : {}),
        }))
      }
      return msg
    }
    case 'tool_result':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
}
