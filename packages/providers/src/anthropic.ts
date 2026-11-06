import type { ChatImage, ChatMessage, StreamChunk, ToolSpec, Usage } from '@hesdor/protocol'
import { imagesFor } from './catalog.js'
import { classify, httpError, joinUrl, mapFetchError, ProviderError, resolveKey } from './provider.js'
import type { Effort, KeySource, ModelProvider } from './provider.js'
import { sseData } from './sse.js'

export interface AnthropicConfig extends KeySource {
  /** Shown in errors ("could not reach <name>"). */
  name?: string
  baseUrl?: string
  model: string
  maxTokens?: number
  headers?: Record<string, string>
  /** How the key is sent: x-api-key (Anthropic, default) or Authorization: Bearer (some gateways). */
  authHeader?: AuthHeader
  /** Sent as output_config.effort. */
  effort?: Effort
  /** Merged into the request body last (gateway-specific fields). */
  extraBody?: Record<string, unknown>
  /** Catalog image support; false replaces images with a note (see imagesFor). */
  imageInput?: boolean
}

export type AuthHeader = 'x-api-key' | 'bearer'

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

type Block = (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string } | ImageBlock>; is_error?: boolean }
  | ImageBlock
  | ThinkingBlock
) & { cache_control?: { type: 'ephemeral' } }

/** Stored as ChatMessage.providerState. Signed thinking must be replayed unmodified, and only to the endpoint that signed it. */
interface AnthropicState {
  tag: string
  thinking: ThinkingBlock[]
}

interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

interface StreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    signature?: string
    stop_reason?: string
  }
  message?: { usage?: WireUsage }
  usage?: WireUsage
  error?: { message?: string; type?: string }
}

/** Native Anthropic /v1/messages client. Also usable for Anthropic-compatible gateways. */
export class AnthropicProvider implements ModelProvider {
  readonly name: string
  readonly model: string

  constructor(private readonly config: AnthropicConfig) {
    this.name = config.name ?? 'anthropic'
    this.model = config.model
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com'
    const tag = `anthropic ${baseUrl}`
    const systemParts: string[] = []
    const convo: AnthropicMessage[] = []

    const pushToolResult = (block: Extract<Block, { type: 'tool_result' }>) => {
      const last = convo[convo.length - 1]
      if (
        last &&
        last.role === 'user' &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === 'tool_result')
      ) {
        last.content.push(block)
      } else {
        convo.push({ role: 'user', content: [block] })
      }
    }

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content)
      } else if (m.role === 'user') {
        const { text, images } = imagesFor(m, this.config.imageInput)
        // Images first, then the question (the order Anthropic's vision guide recommends).
        convo.push({ role: 'user', content: [...images.map(imageBlock), ...(text || images.length === 0 ? [{ type: 'text' as const, text }] : [])] })
      } else if (m.role === 'assistant') {
        const state = m.providerState as AnthropicState | undefined
        // Replay signed thinking first, in the order it was produced.
        const blocks: Block[] = state?.tag === tag ? [...state.thinking] : []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls ?? []) {
          let input: unknown
          try {
            input = JSON.parse(tc.argumentsJson || '{}')
          } catch {
            input = {}
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
        }
        // An empty text block is rejected by the API; skip empty turns (old sessions may hold them).
        if (blocks.length > 0) convo.push({ role: 'assistant', content: blocks })
      } else if (m.toolCallId) {
        const { text, images } = imagesFor(m, this.config.imageInput)
        pushToolResult({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: images.length === 0 ? text : [...(text ? [{ type: 'text' as const, text }] : []), ...images.map(imageBlock)],
          ...(m.isError ? { is_error: true } : {}),
        })
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 8192,
      stream: true,
      messages: convo,
    }
    // Prompt caching: one breakpoint after the system prompt, one on the newest block so the
    // growing conversation prefix is reused by the next step of the tool loop.
    if (systemParts.length > 0) {
      body.system = [{ type: 'text', text: systemParts.join('\n\n'), cache_control: { type: 'ephemeral' } }]
    }
    const lastBlock = convo[convo.length - 1]?.content.at(-1)
    if (lastBlock && lastBlock.type !== 'thinking' && lastBlock.type !== 'redacted_thinking') {
      lastBlock.cache_control = { type: 'ephemeral' }
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parametersJsonSchema,
      }))
    }
    if (this.config.effort) body.output_config = { effort: this.config.effort }
    Object.assign(body, this.config.extraBody)

    // An unset key sends no auth header at all (an empty x-api-key confuses some gateways).
    const key = await resolveKey(this.config)
    const auth: Record<string, string> = !key
      ? {}
      : this.config.authHeader === 'bearer'
        ? { authorization: `Bearer ${key}` }
        : { 'x-api-key': key }

    let res: Response
    try {
      res = await fetch(joinUrl(baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          ...this.config.headers,
          'content-type': 'application/json',
          ...auth,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      throw mapFetchError(err, this.name)
    }
    if (!res.ok) throw await httpError(res)

    // Map streaming block indexes to sequential tool call indexes.
    const blockKinds = new Map<number, 'text' | 'tool'>()
    const toolIndexOfBlock = new Map<number, number>()
    const thinkingOfBlock = new Map<number, ThinkingBlock>()
    let nextToolIndex = 0
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let cacheReadTokens: number | undefined
    let cacheWriteTokens: number | undefined
    const readUsage = (u: WireUsage | undefined): void => {
      inputTokens = u?.input_tokens ?? inputTokens
      outputTokens = u?.output_tokens ?? outputTokens
      cacheReadTokens = u?.cache_read_input_tokens ?? cacheReadTokens
      cacheWriteTokens = u?.cache_creation_input_tokens ?? cacheWriteTokens
    }

    let ended = false
    let parsed = 0
    let badLine: string | undefined

    for await (const data of sseData(res)) {
      if (!data) continue
      let evt: StreamEvent
      try {
        evt = JSON.parse(data) as StreamEvent
        parsed++
      } catch {
        badLine ??= data
        continue
      }
      switch (evt.type) {
        case 'message_stop':
          ended = true
          break
        case 'message_start':
          readUsage(evt.message?.usage)
          break
        case 'content_block_start': {
          const idx = evt.index ?? 0
          if (evt.content_block?.type === 'tool_use') {
            blockKinds.set(idx, 'tool')
            toolIndexOfBlock.set(idx, nextToolIndex)
            yield {
              type: 'tool_call',
              index: nextToolIndex++,
              id: evt.content_block.id,
              name: evt.content_block.name,
              argumentsDelta: '',
            }
          } else if (evt.content_block?.type === 'thinking') {
            thinkingOfBlock.set(idx, { type: 'thinking', thinking: '', signature: '' })
            yield { type: 'reasoning', text: '' }
          } else if (evt.content_block?.type === 'redacted_thinking') {
            thinkingOfBlock.set(idx, { type: 'redacted_thinking', data: evt.content_block.data ?? '' })
            yield { type: 'reasoning', text: '' }
          } else {
            blockKinds.set(idx, 'text')
          }
          break
        }
        case 'content_block_delta': {
          const idx = evt.index ?? 0
          const thinking = thinkingOfBlock.get(idx)
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            yield { type: 'text', text: evt.delta.text }
          } else if (evt.delta?.type === 'thinking_delta' && thinking?.type === 'thinking') {
            thinking.thinking += evt.delta.thinking ?? ''
            if (evt.delta.thinking) yield { type: 'reasoning', text: evt.delta.thinking }
          } else if (evt.delta?.type === 'signature_delta' && thinking?.type === 'thinking') {
            thinking.signature += evt.delta.signature ?? ''
          } else if (evt.delta?.type === 'input_json_delta') {
            const toolIdx = toolIndexOfBlock.get(idx)
            if (toolIdx !== undefined) {
              yield {
                type: 'tool_call',
                index: toolIdx,
                argumentsDelta: evt.delta.partial_json ?? '',
              }
            }
          }
          break
        }
        case 'message_delta':
          readUsage(evt.usage)
          if (evt.delta?.stop_reason) {
            ended = true
            if (thinkingOfBlock.size > 0) {
              const state: AnthropicState = {
                tag,
                thinking: [...thinkingOfBlock].sort((a, b) => a[0] - b[0]).map(([, block]) => block),
              }
              yield { type: 'provider_state', state }
            }
            // Anthropic's input_tokens excludes cached tokens; Usage.inputTokens counts all input.
            const allInput =
              inputTokens === undefined ? undefined : inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
            const usage: Usage | undefined =
              allInput !== undefined || outputTokens !== undefined
                ? {
                    inputTokens: allInput,
                    outputTokens,
                    totalTokens: (allInput ?? 0) + (outputTokens ?? 0),
                    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
                    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
                    ready: true,
                  }
                : undefined
            const stop = evt.delta.stop_reason
            const reason =
              stop === 'tool_use'
                ? 'tool_calls'
                : stop === 'max_tokens' || stop === 'model_context_window_exceeded'
                  ? 'length'
                  : 'stop'
            yield { type: 'finish', reason, ...(usage ? { usage } : {}) }
          }
          break
        case 'error': {
          const message = evt.error?.message ?? 'anthropic stream error'
          throw new ProviderError(message, { kind: classify(undefined, `${message} ${evt.error?.type ?? ''}`) })
        }
      }
    }

    if (parsed === 0 && badLine !== undefined) {
      throw new ProviderError(`provider sent unparseable stream data: ${badLine.slice(0, 200)}`)
    }
    if (!ended) throw new ProviderError('stream ended unexpectedly', { kind: 'network' })
  }
}

const imageBlock = (img: ChatImage): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
