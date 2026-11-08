/**
 * Real, billed requests (cents in total) against every provider with a usable credential.
 * Runs only with `pnpm test:live` (vitest --mode live) or HESDOR_LIVE=1; each provider's tests skip when
 * it has no key. Narrow it with `pnpm test:live -t anthropic`. Writes evals/live/report-<date>.md.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { createDefaultRegistry, runAgentLoop, ToolRegistry } from '@hesdor/agent-core'
import type { ToolContext } from '@hesdor/agent-core'
import type { CliFlags } from '../../cli/src/args.js'
import { loadEffectiveConfig } from '../../cli/src/config-layers.js'
import { estimateUsd, liveCheck, liveTable, liveTargets, streamTurn } from '../../cli/src/live-check.js'
import type { LiveResult, LiveTarget } from '../../cli/src/live-check.js'
import { createSelectedProvider } from '../../cli/src/provider-setup.js'
import { PROVIDER_PRESETS } from './presets.js'
import { requestCostUsd } from './catalog.js'

const LIVE = process.env.HESDOR_LIVE === '1'
const FLAGS: CliFlags = { yes: true, debug: false, force: false, version: false, help: false }
const { config, managed } = LIVE ? await loadEffectiveConfig(FLAGS, {}) : { config: {}, managed: {} }
const targets = LIVE ? await liveTargets(FLAGS, config, managed) : []
const byId = new Map(targets.map((t) => [t.selection.providerId, t]))
const ids = [...new Set([...PROVIDER_PRESETS.map((p) => p.id), ...byId.keys()])]

const results: LiveResult[] = []
const notes: string[] = []
const usd = (n: number | undefined): string => (n === undefined ? 'price unknown' : `$${n.toFixed(4)}`)
const provider = (t: LiveTarget) => createSelectedProvider({ ...t.selection, maxTokens: t.maxTokens })

if (LIVE) {
  const known = targets.reduce((a, t) => a + (estimateUsd(t, 9) ?? 0), 0)
  console.log(`live: ${targets.length} provider(s) [${[...byId.keys()].join(', ')}], at most ~$${known.toFixed(3)} at catalog prices (cache test adds ~5k input tokens x2 on Anthropic/Responses wires)`)
}

afterAll(() => {
  if (!LIVE || (results.length === 0 && notes.length === 0)) return
  const dir = fileURLToPath(new URL('../../../evals/live/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const body = [`# Live provider report ${date}`, '', liveTable(results), '', '## Other checks', '', ...notes.map((n) => `- ${n}`), ''].join('\n')
  writeFileSync(path.join(dir, `report-${date}.md`), body)
})

/** A size x size solid red PNG, built by hand so the test needs no image library. */
function redPng(size = 16): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(typed.length + 8) // length + type/data + crc
    out.writeUInt32BE(data.length, 0)
    typed.copy(out, 4)
    out.writeUInt32BE(crc32(typed), 4 + typed.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))])
  const idat = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

describe.skipIf(!LIVE)('live providers', () => {
  describe.each(ids)('%s', (id) => {
    const t = byId.get(id)

    it.skipIf(!t)('stream + tool round trip (doctor --live check)', async () => {
      const r = await liveCheck(provider(t!), t!)
      results.push(r)
      expect(r.ok, `${r.failedStep}: ${r.error}${r.hint ? ` (hint: ${r.hint})` : ''}`).toBe(true)
      expect(r.usageReported, 'no token usage came back').toBe(true)
    })

    it.skipIf(!t)('agent loop: two chained read_file steps, replaying reasoning state', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'hesdor-live-'))
      writeFileSync(path.join(root, 'start.txt'), 'The answer is in next.txt.\n')
      writeFileSync(path.join(root, 'next.txt'), 'PINEAPPLE-42\n')
      const ctx: ToolContext = {
        root,
        mode: 'ask',
        model: t!.selection.model,
        signal: AbortSignal.timeout(180_000),
        emit: () => {},
        requestApproval: () => Promise.resolve(false),
        approvalsEnabled: false,
        state: { activeChild: null, snapshots: [], redo: [] },
      }
      const result = await runAgentLoop({
        provider: provider(t!),
        registry: new ToolRegistry().register(createDefaultRegistry().get('read_file')!),
        ctx,
        systemPrompt: 'You are a test harness. Use tools when asked. Be brief.',
        userPrompt: 'Read start.txt with read_file, then read the file it names, then reply with that file\'s exact content and nothing else.',
        maxSteps: 6,
      })
      const reads = result.messages.filter((m) => m.role === 'tool_result').length
      // Replayed: the requests after a tool call carried this state back and the endpoint accepted it.
      const replayed = result.messages.some((m) => m.role === 'assistant' && m.toolCalls?.length && (m.reasoning || m.providerState !== undefined))
      const final = result.messages.at(-1)
      notes.push(`${id} agent loop: ${result.status}, ${reads} tool results, reasoning state replayed: ${replayed ? 'yes' : 'no'}, ${usd(requestCostUsd(result.usage, t!.info))}${result.error ? `, error: ${result.error.split('\n')[0]}` : ''}`)
      expect(result.status, result.error).toBe('completed')
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(final?.content).toContain('PINEAPPLE-42')
    })

    const cacheWire = t?.selection.kind === 'anthropic' || t?.selection.kind === 'openai-responses'
    it.skipIf(!t || !cacheWire)('prompt cache: second identical-prefix request reports cache fields', async () => {
      // ~5k tokens: above every model's minimum cacheable prefix (1024-4096).
      const system = Array.from({ length: 600 }, (_, i) => `Rule ${i + 1}: answer briefly and precisely.`).join('\n')
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: 'Reply with the word ok.' }]
      const p = provider(t!)
      const first = await streamTurn(p, messages, [], undefined, 'hesdor-live-cache')
      const second = await streamTurn(p, messages, [], undefined, 'hesdor-live-cache')
      const u = second.usage
      notes.push(`${id} cache: first read ${first.usage?.cacheReadTokens ?? '-'} / write ${first.usage?.cacheWriteTokens ?? '-'}; second read ${u?.cacheReadTokens ?? '-'} of ${u?.inputTokens ?? '-'} input (second request ${usd(requestCostUsd(u, t!.info))})`)
      expect(u?.cacheReadTokens, 'no cache read field on the second request').toBeDefined()
      // OpenAI caching is best effort; Anthropic's breakpoints make the second read deterministic.
      if (id === 'anthropic') expect(u!.cacheReadTokens!).toBeGreaterThan(0)
    })

    it.skipIf(!t || !t.info?.imageInput)('image input: names the color of a generated PNG', async () => {
      const png = redPng()
      const turn = await streamTurn(provider(t!), [{ role: 'user', content: 'What color is this image? Answer with one word.', images: [{ mediaType: 'image/png', data: png.toString('base64') }] }], [])
      notes.push(`${id} image: "${turn.text.trim().slice(0, 40)}", ${usd(requestCostUsd(turn.usage, t!.info))}`)
      expect(turn.text).toMatch(/red/i)
    })
  })
})

describe('redPng', () => {
  it('builds a valid PNG (offline self-check)', async () => {
    const { inflateSync } = await import('node:zlib')
    const png = redPng(2)
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)))
    const idatLen = png.readUInt32BE(33)
    expect(inflateSync(png.subarray(41, 41 + idatLen))).toEqual(Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]))
  })
})
