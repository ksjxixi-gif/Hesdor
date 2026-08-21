import type { ChatMessage, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { httpError, joinUrl, ProviderError } from './provider.js'
import type { ModelProvider } from './provider.js'
import { sseData } from './sse.js'
import { mapFetchError } from './openai-compatible.js'

export interface AnthropicConfig {
  baseUrl?: string
  apiKey: string
  model: string
  maxTokens?: number
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

interface StreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  error?: { message?: string }
}

/** Native Anthropic /v1/messages client. Also usable for Anthropic-compatible gateways. */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  readonly model: string

  constructor(private readonly config: AnthropicConfig) {
    this.model = config.model
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
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
        convo.push({ role: 'user', content: [{ type: 'text', text: m.content }] })
      } else if (m.role === 'assistant') {
        const blocks: Block[] = []
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
        convo.push({
          role: 'assistant',
          content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
        })
      } else if (m.toolCallId) {
        pushToolResult({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
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
    if (systemParts.length > 0) body.system = systemParts.join('\n\n')
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parametersJsonSchema,
      }))
    }

    let res: Response
    try {
      res = await fetch(joinUrl(this.config.baseUrl ?? 'https://api.anthropic.com', '/v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
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
    let nextToolIndex = 0

    for await (const data of sseData(res)) {
      if (!data) continue
      let evt: StreamEvent
      try {
        evt = JSON.parse(data) as StreamEvent
      } catch {
        continue
      }
      switch (evt.type) {
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
          } else {
            blockKinds.set(idx, 'text')
          }
          break
        }
        case 'content_block_delta': {
          const idx = evt.index ?? 0
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            yield { type: 'text', text: evt.delta.text }
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
        case 'message_delta': {
          if (evt.delta?.stop_reason === 'tool_use') {
            yield { type: 'finish', reason: 'tool_calls' }
          } else if (evt.delta?.stop_reason) {
            yield { type: 'finish', reason: 'stop' }
          }
          break
        }
        case 'error':
          throw new ProviderError(evt.error?.message ?? 'anthropic stream error')
      }
    }
  }
}
