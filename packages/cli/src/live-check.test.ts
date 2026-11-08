import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import { estimateUsd, liveCheck, liveTable, liveTargets } from './live-check.js'
import type { LiveTarget } from './live-check.js'
import { createSelectedProvider } from './provider-setup.js'
import type { ProviderSelection } from './provider-setup.js'

type Reply = { status?: number; events?: unknown[]; body?: string }
const sse = (events: unknown[]): string => [...events, '[DONE]'].map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const usage = (p: number, c: number, cached?: number) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } })

let server: http.Server | undefined
afterEach(() => server?.close())

/** Fake Chat Completions server: answers each POST with the next reply and records the bodies. */
async function fake(replies: Reply[]): Promise<{ base: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = []
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      if (req.method !== 'POST') return void res.end('{"data":[]}')
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      const r = replies.shift() ?? { status: 500, body: 'no more replies' }
      res.writeHead(r.status ?? 200, { 'content-type': r.events ? 'text/event-stream' : 'application/json' })
      res.end(r.events ? sse(r.events) : r.body)
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, bodies }
}

const INFO: ModelInfo = { id: 'test-model', toolCall: true, reasoning: true, imageInput: false, cost: { input: 1, output: 2 } }

function target(base: string, info: ModelInfo | undefined = INFO): { t: LiveTarget; provider: ReturnType<typeof createSelectedProvider> } {
  const selection: ProviderSelection = { providerId: 'fake', kind: 'openai', model: 'test-model', baseUrl: base, apiKey: 'k', keySource: 'environment' }
  const t: LiveTarget = { selection, ...(info ? { info } : {}), maxTokens: 1024 }
  return { t, provider: createSelectedProvider({ ...selection, maxTokens: t.maxTokens }) }
}

describe('liveCheck', () => {
  it('streams, calls the tool, replays reasoning with the tool result, and prices the usage', async () => {
    const { base, bodies } = await fake([
      { events: [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }, usage(10, 1)] },
      {
        events: [
          { choices: [{ delta: { reasoning_content: 'need the time' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_time', arguments: '{}' } }] } }] },
          { choices: [{ finish_reason: 'tool_calls' }] },
          usage(20, 5, 8),
        ],
      },
      { events: [{ choices: [{ delta: { content: 'It is 12:34 UTC.' } }] }, { choices: [{ finish_reason: 'stop' }] }, usage(30, 4)] },
    ])
    const { t, provider } = target(base)
    const r = await liveCheck(provider, t)
    expect(r).toMatchObject({ ok: true, provider: 'fake', model: 'test-model', inputTokens: 60, outputTokens: 10, usageReported: true, cacheFieldsReported: true, cacheReadTokens: 8, reasoningReplayed: true, reply: 'It is 12:34 UTC.' })
    expect(r.costUsd).toBeCloseTo((52 * 1 + 8 * 1 + 10 * 2) / 1e6, 12) // no cacheRead price: input rate
    expect(bodies.map((b) => b.max_tokens)).toEqual([1024, 1024, 1024])
    const last = bodies[2]!.messages as Array<Record<string, unknown>>
    expect(last.find((m) => m.role === 'assistant')).toMatchObject({ reasoning_content: 'need the time' })
    expect(last.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '12:34 UTC' })
    expect(liveTable([r])).toMatch(/\| fake \| test-model \| ok \| .* \| 60 in \/ 10 out \| read 8 \/ write 0 \| yes \| \$0\.0001 \|/)
  })

  it('classifies an HTTP failure with its hint and stops at the first step', async () => {
    const { base, bodies } = await fake([{ status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' }])
    const { t, provider } = target(base)
    const r = await liveCheck(provider, t)
    expect(r).toMatchObject({ ok: false, failedStep: 'stream', errorKind: 'auth', hint: 'check the API key: hesdor setup', usageReported: false })
    expect(r.error).toMatch(/HTTP 401/)
    expect(bodies).toHaveLength(1)
    expect(liveTable([r])).toMatch(/failed at stream: auth[\s\S]*hint: check the API key/)
  })

  it('fails the tool step when the model answers in text instead of calling the tool', async () => {
    const { base } = await fake([
      { events: [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }] },
      { events: [{ choices: [{ delta: { content: 'It is noon.' } }] }, { choices: [{ finish_reason: 'stop' }] }] },
    ])
    const { t, provider } = target(base, undefined)
    const r = await liveCheck(provider, t)
    expect(r).toMatchObject({ ok: false, failedStep: 'tool_call', usageReported: false, cacheFieldsReported: false })
    expect(r.errorKind).toBeUndefined()
    expect(r.error).toMatch(/expected a get_time tool call/)
    expect(r.costUsd).toBeUndefined()
  })

  it('reports hitting the output cap and a timeout', async () => {
    const capped = await fake([{ events: [{ choices: [{ delta: { content: 'o' } }] }, { choices: [{ finish_reason: 'length' }] }] }])
    const a = target(capped.base)
    expect((await liveCheck(a.provider, a.t)).error).toMatch(/1024-token output cap/)
    server!.close()

    server = http.createServer(() => {}) // accepts, never answers
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const b = target(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
    const r = await liveCheck(b.provider, b.t, 200)
    expect(r).toMatchObject({ ok: false, failedStep: 'stream', errorKind: 'network' })
    server.closeAllConnections()
  })
})

describe('estimateUsd', () => {
  it('bounds three requests by the output cap; free for the ChatGPT plan, unknown without a price', () => {
    const { t } = target('http://x/v1')
    expect(estimateUsd(t)).toBeCloseTo((3 * (1000 * 1 + 1024 * 2)) / 1e6, 12)
    expect(estimateUsd({ ...t, selection: { ...t.selection, providerId: 'chatgpt', keySource: 'chatgpt' } })).toBe(0)
    const { info: _info, ...noPrice } = t
    expect(estimateUsd(noPrice)).toBeUndefined()
  })
})

describe('liveTargets', () => {
  const flags = (provider: string): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, provider })

  it('includes a keyless endpoint only when it answers', async () => {
    const { base } = await fake([])
    const cfg = { customProviders: { up: { kind: 'openai' as const, baseUrl: base }, down: { kind: 'openai' as const, baseUrl: 'http://127.0.0.1:1/v1' } } }
    const up = await liveTargets(flags('up'), cfg)
    expect(up.map((t) => [t.selection.providerId, t.selection.keySource, t.maxTokens])).toEqual([['up', 'not-required', 1024]])
    expect(estimateUsd(up[0]!)).toBe(0)
    expect(await liveTargets(flags('down'), cfg)).toEqual([])
  })
})
