import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES } from '@hesdor/protocol'
import type { ChatMessage, ModelProvider, StreamChunk } from '@hesdor/protocol'
import { estimateTokens, IMAGE_TOKENS, pruneToolResults } from './compact.js'
import type { ToolContext } from './context.js'
import { runAgentLoop } from './loop.js'
import { createDefaultRegistry } from './registry.js'
import { formatRead } from './tools/fs.js'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]) // real PNGs hold NUL bytes (IHDR length)
const registry = createDefaultRegistry()
const read = (input: unknown, ctx: ToolContext) => registry.get('read_file')!.execute(input, ctx) as Promise<any>

function setup(files: Record<string, string | Buffer>, imageInput?: boolean): ToolContext {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-img-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content)
  return {
    root,
    mode: 'build',
    model: 'test',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(true),
    approvalsEnabled: true,
    state: { activeChild: null, snapshots: [], redo: [] },
    ...(imageInput !== undefined ? { imageInput } : {}),
  }
}

describe('read_file on images', () => {
  it('returns the image when the model accepts images', async () => {
    const res = await read({ path: 'shot.png' }, setup({ 'shot.png': PNG }, true))
    expect(res.image).toEqual({ mediaType: 'image/png', data: PNG.toString('base64') })
    expect(formatRead(res)).toBe(`shot.png: image/png image (${PNG.length} bytes), attached`)
  })

  it('keeps the binary notice for a text-only or unknown model', async () => {
    for (const imageInput of [false, undefined]) {
      const res = await read({ path: 'shot.png' }, setup({ 'shot.png': PNG }, imageInput))
      expect(res.image).toBeUndefined()
      expect(formatRead(res)).toMatch(/binary file/)
    }
  })

  it('refuses an image over the size cap and reads a misnamed text file as text', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
    await expect(read({ path: 'big.png' }, setup({ 'big.png': big }, true))).rejects.toThrow(/MB; images over 3.75 MB/)
    const res = await read({ path: 'notes.png' }, setup({ 'notes.png': 'just text\n' }, true))
    expect(res.image).toBeUndefined()
    expect(res.content).toBe('just text')
  })
})

describe('images in the agent loop', () => {
  it('sends prompt images and attaches read_file images to the tool result', async () => {
    const requests: ChatMessage[][] = []
    const steps: StreamChunk[][] = [
      [{ type: 'tool_call', index: 0, id: 'c1', name: 'read_file', argumentsDelta: '{"path":"shot.png"}' }, { type: 'finish', reason: 'tool_calls' }],
      [{ type: 'text', text: 'a dot' }, { type: 'finish', reason: 'stop' }],
    ]
    const provider: ModelProvider = {
      name: 'scripted',
      model: 'm',
      async *stream(messages) {
        requests.push(messages)
        yield* steps.shift()!
      },
    }
    const prompt = { mediaType: 'image/jpeg', data: '/9j/' }
    const result = await runAgentLoop({
      provider,
      registry,
      ctx: setup({ 'shot.png': PNG }, true),
      systemPrompt: 'sys',
      userPrompt: 'compare',
      images: [prompt],
    })
    expect(result.status).toBe('completed')
    expect(requests[0]![1]).toEqual({ role: 'user', content: 'compare', images: [prompt] })
    const toolResult = requests[1]!.find((m) => m.role === 'tool_result')!
    expect(toolResult.images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }])
    expect(toolResult.content).toMatch(/attached/)
  })
})

describe('compaction with images', () => {
  const huge = { mediaType: 'image/png', data: 'A'.repeat(1_000_000) }

  it('counts an image as a fixed number of tokens, not its base64 length', () => {
    const plain = estimateTokens([{ role: 'user', content: 'hi' }])
    expect(estimateTokens([{ role: 'user', content: 'hi', images: [huge, huge] }])).toBe(plain + 2 * IMAGE_TOKENS)
  })

  it('drops the images of pruned tool results', () => {
    const old: ChatMessage = { role: 'tool_result', toolCallId: 'a', content: 'x', images: [huge] }
    const recent: ChatMessage = { role: 'tool_result', toolCallId: 'b', content: 'y'.repeat(400) }
    const { messages, pruned } = pruneToolResults([old, recent], 200)
    expect(pruned).toBe(1)
    expect(messages[0]).toEqual({ role: 'tool_result', toolCallId: 'a', content: '[output pruned]' })
  })
})
