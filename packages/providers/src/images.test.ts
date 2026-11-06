import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, StreamChunk } from '@hesdor/protocol'
import { imageMediaType } from '@hesdor/protocol'
import { AnthropicProvider } from './anthropic.js'
import { imagesFor } from './catalog.js'
import { createProvider } from './factory.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { OpenAIResponsesProvider } from './openai-responses.js'

const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const CHAT_DONE = sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n'
const ANTHROPIC_DONE = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])
const RESPONSES_DONE = sse([{ type: 'response.completed', response: { status: 'completed' } }])

function mockFetch(body: string) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sentBody = (fetchMock: ReturnType<typeof vi.fn>): any => JSON.parse(fetchMock.mock.calls[0]![1].body as string)
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _ of stream) void _
}

const img = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
const history: ChatMessage[] = [
  { role: 'user', content: 'what is this?', images: [img] },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'c1', name: 'read_file', argumentsJson: '{"path":"a.png"}' },
      { id: 'c2', name: 'read_file', argumentsJson: '{"path":"b.txt"}' },
    ],
  },
  { role: 'tool_result', toolCallId: 'c1', content: 'a.png: image/png image (9 bytes), attached', images: [img] },
  { role: 'tool_result', toolCallId: 'c2', content: 'b.txt (empty)' },
]
const signal = new AbortController().signal

afterEach(() => vi.unstubAllGlobals())

describe('image input', () => {
  it('Anthropic: base64 image blocks in the user turn and inside tool_result content', async () => {
    const fetchMock = mockFetch(ANTHROPIC_DONE)
    await drain(new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-5-5' }).stream(history, [], signal))
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } }
    const { messages } = sentBody(fetchMock)
    expect(messages[0]).toEqual({ role: 'user', content: [block, { type: 'text', text: 'what is this?' }] })
    expect(messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: [{ type: 'text', text: 'a.png: image/png image (9 bytes), attached' }, block],
    })
    expect(messages[2].content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'c2', content: 'b.txt (empty)' })
  })

  it('Chat Completions: image_url data URLs; tool-result images follow all tool messages as a user turn', async () => {
    const fetchMock = mockFetch(CHAT_DONE)
    await drain(new OpenAICompatibleProvider({ baseUrl: 'https://x.test/v1', model: 'm' }).stream(history, [], signal))
    const part = { type: 'image_url', image_url: { url: `data:image/png;base64,${img.data}` } }
    const { messages } = sentBody(fetchMock)
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(messages[0].content).toEqual([{ type: 'text', text: 'what is this?' }, part])
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'a.png: image/png image (9 bytes), attached' })
    expect(messages[4].content).toEqual([{ type: 'text', text: 'Images returned by tool call c1:' }, part])
  })

  it('Responses: input_image parts in the user message and in function_call_output', async () => {
    const fetchMock = mockFetch(RESPONSES_DONE)
    await drain(new OpenAIResponsesProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' }).stream(history, [], signal))
    const part = { type: 'input_image', image_url: `data:image/png;base64,${img.data}` }
    const { input } = sentBody(fetchMock)
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'what is this?' }, part] })
    expect(input[3]).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: [{ type: 'input_text', text: 'a.png: image/png image (9 bytes), attached' }, part],
    })
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'c2', output: 'b.txt (empty)' })
  })

  it('a model the catalog marks as text-only gets a note instead of the images', async () => {
    const fetchMock = mockFetch(CHAT_DONE)
    vi.stubEnv('DEEPSEEK_API_KEY', 'k')
    await drain(createProvider({ provider: 'deepseek', model: 'deepseek-v4-pro' }).stream(history, [], signal))
    vi.unstubAllEnvs()
    const { messages } = sentBody(fetchMock)
    expect(messages[0]).toEqual({ role: 'user', content: 'what is this?\n[1 image omitted: the current model does not accept image input]' })
    expect(messages[2].content).toContain('[1 image omitted')
    expect(messages).toHaveLength(4) // no extra user turn for tool images
  })

  it('imagesFor keeps images for vision and unknown models', () => {
    expect(imagesFor(history[0]!, true).images).toHaveLength(1)
    expect(imagesFor(history[0]!, undefined).images).toHaveLength(1)
    expect(imagesFor({ role: 'user', content: '', images: [img, img] }, false)).toEqual({
      text: '[2 images omitted: the current model does not accept image input]',
      images: [],
    })
  })

  it('imageMediaType sniffs png, jpeg, gif and webp by magic bytes', () => {
    const b = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
    expect(imageMediaType(b('\x89PNG\r\n\x1a\n...'))).toBe('image/png')
    expect(imageMediaType(b('\xff\xd8\xff\xe0'))).toBe('image/jpeg')
    expect(imageMediaType(b('GIF89a....'))).toBe('image/gif')
    expect(imageMediaType(b('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(imageMediaType(b('hello world'))).toBeUndefined()
    expect(imageMediaType(new Uint8Array())).toBeUndefined()
  })
})
