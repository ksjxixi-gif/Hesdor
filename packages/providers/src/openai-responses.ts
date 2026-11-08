import type { ChatImage, ChatMessage, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { imagesFor } from './catalog.js'
import { classify, httpError, joinUrl, mapFetchError, ProviderError, resolveKey } from './provider.js'
import type { Effort, KeySource, ModelProvider } from './provider.js'
import { sseData } from './sse.js'

export interface OpenAIResponsesConfig extends KeySource {
  name?: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
  /** max_output_tokens (includes reasoning tokens on OpenAI). */
  maxTokens?: number
  effort?: Effort
  /** Merged into the request body last (gateway-specific fields). */
  extraBody?: Record<string, unknown>
  /** Catalog image support; false replaces images with a note (see imagesFor). */
  imageInput?: boolean
  /**
   * ChatGPT plan usage (preset `chatgpt`): no max_output_tokens, tools grouped in a namespace,
   * no redirects. https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md
   */
  chatgptPlan?: boolean
  /** Bearer token source instead of a key; called again with the rejected token after a 401. */
  token?: (failed?: string) => Promise<string>
}

/** Namespace the ChatGPT plan route requires for function tools. */
const PLAN_NAMESPACE = 'hesdor'

/**
 * Hosts documented to take prompt_cache_key: OpenAI (also the ChatGPT plan route), Azure OpenAI and xAI.
 * Unknown gateways may reject unknown fields, so they never get it.
 */
function cacheKeyHost(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return false
  }
  return host === 'api.openai.com' || host === 'api.x.ai' || host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')
}

/** Stored as ChatMessage.providerState: reasoning items (with encrypted_content) to replay to the same endpoint. */
interface ResponsesState {
  tag: string
  reasoning: Record<string, unknown>[]
}

interface WireItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  [key: string]: unknown
}

interface WireEvent {
  type?: string
  item?: WireItem
  item_id?: string
  delta?: string
  code?: string
  message?: string
  response?: {
    status?: string
    incomplete_details?: { reason?: string }
    error?: { code?: string; message?: string }
    usage?: {
      input_tokens?: number
      input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
      output_tokens?: number
      total_tokens?: number
    }
  }
}

/**
 * OpenAI Responses API (POST /responses), stateless: `store: false` and encrypted reasoning
 * replayed from providerState. Used by OpenAI (flagships need it for tool calls), xAI and Azure OpenAI v1.
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly name: string
  readonly model: string

  constructor(private readonly config: OpenAIResponsesConfig) {
    this.name = config.name ?? 'openai-responses'
    this.model = config.model
  }

  async *stream(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal, opts?: { cacheKey?: string }): AsyncGenerator<StreamChunk> {
    const tag = `openai-responses ${this.config.baseUrl}`
    const body: Record<string, unknown> = {
      model: this.config.model,
      input: toInput(messages, tag, this.config.imageInput, this.config.chatgptPlan),
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(this.config.chatgptPlan ? {} : { max_output_tokens: this.config.maxTokens ?? 8192 }),
    }
    const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    if (instructions) body.instructions = instructions
    if (this.config.effort) body.reasoning = { effort: this.config.effort }
    if (opts?.cacheKey && cacheKeyHost(this.config.baseUrl)) body.prompt_cache_key = opts.cacheKey
    if (tools.length > 0) {
      // strict:false keeps optional parameters optional (strict mode would force every property required).
      const fns = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parametersJsonSchema, strict: false }))
      body.tools = this.config.chatgptPlan ? [{ type: 'namespace', name: PLAN_NAMESPACE, description: 'Hesdor coding agent tools', tools: fns }] : fns
    }
    Object.assign(body, this.config.extraBody)

    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.config.headers }
    const key = this.config.token ? await this.config.token() : await resolveKey(this.config)
    if (key) headers.authorization = `Bearer ${key}`

    const send = async (): Promise<Response> => {
      try {
        // redirect 'error': a bearer token is never replayed to another URL.
        return await fetch(joinUrl(this.config.baseUrl, '/responses'), { method: 'POST', headers, body: JSON.stringify(body), signal, ...(this.config.token ? { redirect: 'error' as const } : {}) })
      } catch (err) {
        throw mapFetchError(err, this.name)
      }
    }
    let res = await send()
    if (res.status === 401 && this.config.token && key) {
      // Expired or revoked early: refresh once (the token source re-reads the shared store first).
      await res.body?.cancel()
      headers.authorization = `Bearer ${await this.config.token(key)}`
      res = await send()
      if (res.status === 401) {
        const detail = (await res.text().catch(() => '')).slice(0, 500)
        throw new ProviderError('ChatGPT rejected the sign-in (HTTP 401)', { status: 401, body: detail, hint: 'sign in again: hesdor login chatgpt' })
      }
    }
    if (!res.ok) throw await httpError(res)

    const toolIndex = new Map<string, number>()
    const reasoning: Record<string, unknown>[] = []
    let parsed = 0
    let badLine: string | undefined

    for await (const data of sseData(res)) {
      if (!data || data === '[DONE]') continue
      let evt: WireEvent
      try {
        evt = JSON.parse(data) as WireEvent
        parsed++
      } catch {
        badLine ??= data
        continue
      }
      switch (evt.type) {
        case 'response.output_item.added':
          if (evt.item?.type === 'function_call' && evt.item.id) {
            const index = toolIndex.size
            toolIndex.set(evt.item.id, index)
            yield { type: 'tool_call', index, id: evt.item.call_id, name: evt.item.name, argumentsDelta: '' }
          } else if (evt.item?.type === 'reasoning') {
            yield { type: 'reasoning', text: '' }
          }
          break
        case 'response.output_text.delta':
          if (evt.delta) yield { type: 'text', text: evt.delta }
          break
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (evt.delta) yield { type: 'reasoning', text: evt.delta }
          break
        case 'response.function_call_arguments.delta': {
          const index = evt.item_id === undefined ? undefined : toolIndex.get(evt.item_id)
          if (index !== undefined && evt.delta) yield { type: 'tool_call', index, argumentsDelta: evt.delta }
          break
        }
        case 'response.output_item.done':
          // encrypted_content is only complete on .done.
          if (evt.item?.type === 'reasoning') reasoning.push(evt.item)
          break
        case 'error':
          throw new ProviderError(`${evt.message ?? 'responses stream error'}${evt.code ? ` (${evt.code})` : ''}`, { kind: classify(undefined, `${evt.message ?? ''} ${evt.code ?? ''}`) })
        case 'response.failed': {
          const e = evt.response?.error
          throw new ProviderError(`${e?.message ?? 'response failed'}${e?.code ? ` (${e.code})` : ''}`, { kind: classify(undefined, `${e?.message ?? ''} ${e?.code ?? ''}`) })
        }
        case 'response.completed':
        case 'response.incomplete': {
          if (reasoning.length > 0) yield { type: 'provider_state', state: { tag, reasoning } satisfies ResponsesState }
          const u = evt.response?.usage
          const cacheRead = u?.input_tokens_details?.cached_tokens
          const cacheWrite = u?.input_tokens_details?.cache_write_tokens
          const usage = u
            ? {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                totalTokens: u.total_tokens,
                ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
                ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
                ready: true,
              }
            : undefined
          const cut = evt.type === 'response.incomplete' && evt.response?.incomplete_details?.reason === 'max_output_tokens'
          const reason = cut ? 'length' : toolIndex.size > 0 ? 'tool_calls' : 'stop'
          yield { type: 'finish', reason, ...(usage ? { usage } : {}) }
          return
        }
      }
    }

    if (parsed === 0 && badLine !== undefined) throw new ProviderError(`provider sent unparseable stream data: ${badLine.slice(0, 200)}`)
    throw new ProviderError('stream ended unexpectedly', { kind: 'network' })
  }
}

const imagePart = (img: ChatImage): Record<string, unknown> => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` })

/** Text plus images as Responses content parts; plain text when there are no images. */
function parts(m: ChatMessage, imageInput: boolean | undefined): string | Record<string, unknown>[] {
  const { text, images } = imagesFor(m, imageInput)
  return images.length === 0 ? text : [...(text ? [{ type: 'input_text', text }] : []), ...images.map(imagePart)]
}

function toInput(messages: ChatMessage[], tag: string, imageInput?: boolean, planNamespace?: boolean): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'user') input.push({ role: 'user', content: parts(m, imageInput) })
    // function_call_output.output accepts input_text/input_image parts as well as a string.
    else if (m.role === 'tool_result') input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: parts(m, imageInput) })
    else if (m.role === 'assistant') {
      const state = m.providerState as ResponsesState | undefined
      // Reasoning first, as produced; only to the endpoint that encrypted it.
      if (state?.tag === tag) input.push(...state.reasoning)
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.argumentsJson || '{}', ...(planNamespace ? { namespace: PLAN_NAMESPACE } : {}) })
      }
    }
  }
  return input
}
