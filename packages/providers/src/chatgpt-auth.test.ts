import { mkdtempSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, StreamChunk } from '@hesdor/protocol'
import { chatgptAccessToken, chatgptAuthFile, listChatGPTModels, readChatGPTAuth, writeChatGPTAuth } from './chatgpt-auth.js'
import { createProvider } from './factory.js'
import { OpenAIResponsesProvider } from './openai-responses.js'
import { ProviderError } from './provider.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-chatgpt-'))

const PLAN_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const done = sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { status: 'completed' } }])

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
async function serve(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

let auth: { url: string; server: Server }
let api: { url: string; server: Server }
let other: { url: string; server: Server }
const refreshes: URLSearchParams[] = []
const apiCalls: Array<{ path: string; authorization?: string; body: string }> = []
let otherHits = 0
let refreshReply: { status: number; json: object } = { status: 200, json: {} }
let apiReply: (authz: string | undefined, path: string) => { status: number; body: string; headers?: Record<string, string> }

beforeAll(async () => {
  auth = await serve((req, body, res) => {
    const form = new URLSearchParams(body)
    refreshes.push(form)
    // Slow enough that a second caller without the lock would also refresh.
    setTimeout(() => res.writeHead(refreshReply.status, { 'content-type': 'application/json' }).end(JSON.stringify(refreshReply.json)), 50)
  })
  api = await serve((req, body, res) => {
    apiCalls.push({ path: req.url ?? '', authorization: req.headers.authorization, body })
    const r = apiReply(req.headers.authorization, req.url ?? '')
    res.writeHead(r.status, { 'content-type': 'text/event-stream', ...r.headers }).end(r.body)
  })
  other = await serve((_req, _body, res) => {
    otherHits++
    res.writeHead(200).end(done)
  })
})
afterAll(() => {
  for (const s of [auth, api, other]) s.server.close()
})

beforeEach(async () => {
  refreshes.length = 0
  apiCalls.length = 0
  otherHits = 0
  refreshReply = { status: 200, json: { access_token: 'new', refresh_token: 'r2', expires_in: 3600, scope: PLAN_SCOPE } }
  apiReply = (authz) => (authz === 'Bearer new' ? { status: 200, body: done } : { status: 401, body: '{"detail":"expired"}' })
  await writeChatGPTAuth({ hostId: 'urn:uuid:h', clientId: 'oaiapp_1', accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 3600_000, scope: PLAN_SCOPE })
})

const token = (failed?: string) => chatgptAccessToken({ issuer: auth.url, ...(failed ? { failed } : {}) })
const plan = (baseUrl = api.url) => new OpenAIResponsesProvider({ baseUrl, model: 'gpt-x', chatgptPlan: true, token })
async function drain(p: OpenAIResponsesProvider, messages: ChatMessage[] = [{ role: 'user', content: 'hi' }], tools: Parameters<OpenAIResponsesProvider['stream']>[1] = []) {
  const out: StreamChunk[] = []
  for await (const c of p.stream(messages, tools, new AbortController().signal)) out.push(c)
  return out
}

describe('ChatGPT plan tokens', () => {
  it('refreshes an expired token before the request and stores the rotated refresh token', async () => {
    const rec = (await readChatGPTAuth())!
    await writeChatGPTAuth({ ...rec, expiresAt: Date.now() - 1000 })
    await drain(plan())
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0]!.authorization).toBe('Bearer new')
    expect(Object.fromEntries(refreshes[0]!)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'oaiapp_1',
      refresh_token: 'r1',
      resource: 'https://api.openai.com/v1',
    })
    expect(await readChatGPTAuth()).toMatchObject({ accessToken: 'new', refreshToken: 'r2', clientId: 'oaiapp_1', hostId: 'urn:uuid:h' })
    if (process.platform !== 'win32') expect(statSync(chatgptAuthFile()).mode & 0o777).toBe(0o600)
  })

  it('refreshes once on a 401 and retries with the new token', async () => {
    const chunks = await drain(plan())
    expect(apiCalls.map((c) => c.authorization)).toEqual(['Bearer old', 'Bearer new'])
    expect(refreshes).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('serializes concurrent refreshes so a rotating refresh token is used once', async () => {
    const rec = (await readChatGPTAuth())!
    await writeChatGPTAuth({ ...rec, expiresAt: 0 })
    expect(await Promise.all([token(), token(), token()])).toEqual(['new', 'new', 'new'])
    expect(refreshes).toHaveLength(1)
  })

  it('clears tokens on invalid_grant but keeps the host id and issued client id', async () => {
    refreshReply = { status: 400, json: { error: 'invalid_grant' } }
    const err = await token('old').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).kind).toBe('auth')
    expect((err as Error).message).toMatch(/hesdor login chatgpt/)
    const rec = await readChatGPTAuth()
    expect(rec).toMatchObject({ hostId: 'urn:uuid:h', clientId: 'oaiapp_1' })
    expect(rec?.refreshToken).toBeUndefined()
  })

  it('refuses without the chatgpt.tokens.use.direct scope', async () => {
    const rec = (await readChatGPTAuth())!
    await writeChatGPTAuth({ ...rec, scope: 'openid email' })
    await expect(token()).rejects.toThrow(/plan usage was not granted/)
  })
})

describe('chatgpt request shape and errors', () => {
  it('sends store:false, stream:true, instructions, namespaced tools and none of the rejected fields', async () => {
    apiReply = () => ({ status: 200, body: done })
    await drain(
      new OpenAIResponsesProvider({ baseUrl: api.url, model: 'gpt-x', chatgptPlan: true, maxTokens: 500, effort: 'high', token }),
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }] },
        { role: 'tool_result', content: 'x', toolCallId: 'c1' },
      ],
      [{ name: 'read_file', description: 'read', parametersJsonSchema: { type: 'object', properties: {} } }],
    )
    const body = JSON.parse(apiCalls[0]!.body) as Record<string, unknown>
    expect(body).toMatchObject({ store: false, stream: true, instructions: 'sys', reasoning: { effort: 'high' } })
    for (const k of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id', 'metadata', 'user', 'truncation', 'background']) expect(body).not.toHaveProperty(k)
    expect(JSON.stringify(body.input)).not.toContain('"system"')
    expect(body.tools).toEqual([{ type: 'namespace', name: 'hesdor', description: expect.any(String), tools: [expect.objectContaining({ type: 'function', name: 'read_file' })] }])
    expect(body.input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'c1', namespace: 'hesdor' }))
  })

  it('maps subscription_sharing_usage_limit_exceeded (HTTP 429) to quota_exhausted with the no-fallback hint', async () => {
    apiReply = () => ({ status: 429, body: JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', param: null, message: 'limit' } }) })
    const err = (await drain(plan()).catch((e: unknown) => e)) as ProviderError
    expect(err.kind).toBe('quota_exhausted')
    expect(err.retryable).toBe(false)
    expect(err.message).toMatch(/does not fall back to paid API billing/)
    expect(err.message).toContain('https://chatgpt.com/settings/usage')
  })

  it('maps the limit error that arrives as response.failed mid-stream', async () => {
    apiReply = () => ({ status: 200, body: sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached' } } }]) })
    const err = (await drain(plan()).catch((e: unknown) => e)) as ProviderError
    expect(err.kind).toBe('quota_exhausted')
    expect(err.message).toMatch(/does not fall back/)
  })

  it('never follows a redirect with the token', async () => {
    apiReply = () => ({ status: 307, body: '', headers: { location: `${other.url}/responses` } })
    await expect(drain(plan())).rejects.toThrow()
    expect(otherHits).toBe(0)
  })

  it('refuses a base URL override for the chatgpt preset', () => {
    expect(() => createProvider({ provider: 'chatgpt', baseUrl: 'https://evil.example/v1' })).toThrow(/only talks to https:\/\/api\.openai\.com\/v1/)
    expect(createProvider({ provider: 'chatgpt' }).name).toBe('chatgpt')
  })

  it('lists models with visibility "list" from GET /models', async () => {
    apiReply = () => ({
      status: 200,
      body: JSON.stringify({ models: [{ slug: 'gpt-a', visibility: 'list' }, { slug: 'gpt-hidden', visibility: 'hide' }, { slug: 'gpt-b', visibility: 'list' }] }),
    })
    expect(await listChatGPTModels('new', api.url)).toEqual(['gpt-a', 'gpt-b'])
    expect(apiCalls[0]).toMatchObject({ path: '/models', authorization: 'Bearer new' })
  })
})
