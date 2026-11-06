import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_BYTES } from '@hesdor/protocol'
import type { ChatMessage, ModelProvider, StreamChunk } from '@hesdor/protocol'
import { parseArgs } from './args.js'
import type { CliFlags } from './args.js'
import { runHeadless } from './headless.js'
import { imageMentions, loadImage, promptImages } from './images.js'
import { capSessionImages } from './sessions.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')

function dir(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-images-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  return root
}

afterEach(() => vi.restoreAllMocks())

describe('--image', () => {
  it('is repeatable', () => {
    expect(parseArgs(['run', '--image', 'a.png', '--image', 'b.jpg', 'describe']).flags.images).toEqual(['a.png', 'b.jpg'])
    expect(() => parseArgs(['run', 'x', '--image'])).toThrow(/requires a value/)
  })

  it('loads png and jpeg by content and rejects missing, non-image and huge files', async () => {
    const root = dir({ 'a.png': PNG, 'b.jpg': JPEG, 'fake.png': 'not an image', 'big.png': Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]) })
    expect(await loadImage('a.png', root)).toEqual({ mediaType: 'image/png', data: PNG.toString('base64') })
    expect((await loadImage('b.jpg', root)).mediaType).toBe('image/jpeg')
    await expect(loadImage('nope.png', root)).rejects.toThrow('image not found: nope.png')
    await expect(loadImage('fake.png', root)).rejects.toThrow('fake.png is not a PNG, JPEG, GIF or WebP image')
    await expect(loadImage('big.png', root)).rejects.toThrow(/big\.png is 3\.8 MB; images can be at most 3\.75 MB/)
  })
})

describe('@ mentions', () => {
  it('finds image mentions only', () => {
    expect(imageMentions('see @shots/a.png, and @b.JPG. not @c.ts or me@x.png or @d.webp')).toEqual(['shots/a.png', 'b.JPG', 'd.webp'])
  })

  it('attaches existing workspace images and leaves other mentions alone', async () => {
    const root = dir({ 'ui/a.png': PNG })
    const outside = dir({ 'secret.png': PNG })
    const images = await promptImages([], `fix @ui/a.png and @missing.png and @${path.join(outside, 'secret.png')}`, root, root)
    expect(images).toEqual([{ mediaType: 'image/png', data: PNG.toString('base64') }])
  })

  it('dedupes a file given twice and caps the count', async () => {
    const root = dir({ 'a.png': PNG })
    expect(await promptImages(['a.png'], 'look at @a.png', root, root)).toHaveLength(1)
    const many = Array.from({ length: 21 }, (_, i) => `img${i}.png`)
    await expect(promptImages(many, '', root, root)).rejects.toThrow(/too many images \(21\)/)
  })
})

describe('headless --image', () => {
  const flags = (extra: Partial<CliFlags>): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, ...extra })
  const scripted = (requests: ChatMessage[][]): ModelProvider => ({
    name: 'scripted',
    model: 'fake-model',
    async *stream(messages): AsyncIterable<StreamChunk> {
      requests.push([...messages])
      yield { type: 'text', text: 'ok' }
      yield { type: 'finish', reason: 'stop' }
    },
  })

  it('attaches the image to the prompt', async () => {
    const cwd = dir({ 'a.png': PNG })
    const requests: ChatMessage[][] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runHeadless('ask', 'what is it', flags({ images: ['a.png'] }), { provider: scripted(requests), cwd })).toBe(0)
    expect(requests[0]!.at(-1)).toEqual({ role: 'user', content: 'what is it', images: [{ mediaType: 'image/png', data: PNG.toString('base64') }] })
  })

  it('fails with a usage error for a bad image before calling the model', async () => {
    const cwd = dir({ 'a.txt': 'text' })
    const requests: ChatMessage[][] = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runHeadless('ask', 'what is it', flags({ images: ['a.txt'] }), { provider: scripted(requests), cwd })).toBe(1)
    expect(requests).toHaveLength(0)
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/a\.txt is not a PNG, JPEG, GIF or WebP image/)
  })
})

describe('saved session image cap', () => {
  const img = (chars: number) => ({ mediaType: 'image/png', data: 'A'.repeat(chars) })

  it('keeps the newest images within the cap and replaces older ones with a note', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first', images: [img(60)] },
      { role: 'tool_result', toolCallId: 'c', content: '', images: [img(30), img(30)] },
      { role: 'user', content: 'last', images: [img(50)] },
    ]
    const capped = capSessionImages(messages, 100)
    expect(capped[2]).toBe(messages[2])
    expect(capped[1]).toEqual({ role: 'tool_result', toolCallId: 'c', content: '[2 images not kept in the saved session]' })
    expect(capped[0]).toEqual({ role: 'user', content: 'first\n[1 image not kept in the saved session]' })
    expect(messages[0]!.images).toHaveLength(1) // the live history is untouched
  })
})
