import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readChatGPTAuth } from '@hesdor/providers'
import { runAuthCommand } from './auth.js'
import { chatgptPlanNotice, loginChatGPT, runLoginCommand, runLogoutCommand } from './chatgpt-login.js'
import { loadConfig } from './config.js'
import { runHeadless } from './headless.js'
import type { CliFlags } from './args.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-login-'))

const PLAN_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Fake auth.openai.com + api.openai.com: discovery, JWKS, authorize (acts as the browser consent), token, revoke, models. */
let issuer = ''
let server: Server
const authorizeCalls: URLSearchParams[] = []
const tokenCalls: URLSearchParams[] = []
const revokeCalls: URLSearchParams[] = []
let grantedScope = PLAN_SCOPE
let pending: { challenge: string; nonce: string; redirect: string; clientId: string } | undefined

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', issuer)
      const json = (status: number, o: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))
      if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })
      if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] })
      if (url.pathname === '/api/accounts/authorize') {
        const q = url.searchParams
        authorizeCalls.push(q)
        const first = q.get('client_id') === 'dynamic_agent_client'
        const clientId = first ? 'oaiapp_123' : q.get('client_id')!
        pending = { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirect: q.get('redirect_uri')!, clientId }
        const back = new URL(q.get('redirect_uri')!)
        back.search = new URLSearchParams({ code: 'c1', state: q.get('state')!, scope: grantedScope, ...(first ? { client_id: clientId } : {}) }).toString()
        return res.writeHead(302, { location: back.href }).end()
      }
      if (url.pathname === '/api/accounts/oauth/token') {
        const f = new URLSearchParams(body)
        tokenCalls.push(f)
        const pkceOk = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === pending?.challenge
        if (!pkceOk || f.get('code') !== 'c1' || f.get('redirect_uri') !== pending?.redirect || f.get('client_id') !== pending.clientId) return json(400, { error: 'invalid_grant' })
        const head = b64({ alg: 'RS256', kid: 'k1' })
        const claims = b64({ iss: issuer, aud: pending.clientId, sub: 'user-1', email: 'dev@example.com', nonce: pending.nonce, exp: Math.floor(Date.now() / 1000) + 600 })
        const sig = sign('sha256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')
        return json(200, { access_token: 'at1', refresh_token: 'rt1', id_token: `${head}.${claims}.${sig}`, expires_in: 3600, scope: grantedScope, token_type: 'Bearer' })
      }
      if (url.pathname === '/revoke') {
        revokeCalls.push(new URLSearchParams(body))
        return res.writeHead(200).end()
      }
      if (url.pathname === '/v1/models') return json(200, { models: [{ slug: 'gpt-plan-a', visibility: 'list' }, { slug: 'gpt-plan-b', visibility: 'list' }] })
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  authorizeCalls.length = tokenCalls.length = revokeCalls.length = 0
  grantedScope = PLAN_SCOPE
})
afterEach(() => vi.restoreAllMocks())

/** The "browser": follows the authorize redirect to the loopback callback. */
const browser = (url: string): void => void fetch(url).catch(() => {})
const opts = () => ({ issuer, apiBase: `${issuer}/v1`, openBrowser: browser, print: () => {}, timeoutMs: 10_000 })

function capture() {
  const out: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  return out
}

describe('hesdor login chatgpt', () => {
  it('registers dynamically, verifies PKCE and the ID token, stores the issued oaiapp_ id, then reuses it', async () => {
    const out = capture()
    expect(await runLoginCommand('chatgpt', opts())).toBe(0)
    const first = authorizeCalls[0]!
    expect(first.get('client_id')).toBe('dynamic_agent_client')
    expect(first.get('agent_name_hint')).toBe('Hesdor')
    expect(first.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(first.get('scope')).toBe(PLAN_SCOPE)
    expect(first.get('resource')).toBe('https://api.openai.com/v1')
    expect(first.get('code_challenge_method')).toBe('S256')
    expect(first.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(Object.fromEntries(tokenCalls[0]!)).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_123', resource: 'https://api.openai.com/v1' })
    const rec = await readChatGPTAuth()
    expect(rec).toMatchObject({ clientId: 'oaiapp_123', sub: 'user-1', email: 'dev@example.com', accessToken: 'at1', refreshToken: 'rt1', scope: PLAN_SCOPE })
    expect(out.join('\n')).toContain('Signed in to ChatGPT as dev@example.com')
    // The account's first listed model becomes the chatgpt default.
    expect((await loadConfig()).models?.chatgpt).toBe('gpt-plan-a')

    await loginChatGPT(opts())
    const second = authorizeCalls[1]!
    expect(second.get('client_id')).toBe('oaiapp_123')
    expect(second.has('agent_name_hint')).toBe(false)
    expect(second.get('ext_agent_host_id')).toBe(first.get('ext_agent_host_id'))
  })

  it('ignores a callback with the wrong state', async () => {
    const seen: number[] = []
    await loginChatGPT({
      ...opts(),
      openBrowser: (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!
        void fetch(`${redirect}?code=evil&state=wrong`).then((r) => {
          seen.push(r.status)
          browser(url)
        })
      },
    })
    expect(seen).toEqual([400])
    expect(tokenCalls.map((f) => f.get('code'))).toEqual(['c1'])
  })

  it('stores no tokens when ChatGPT plan usage was not granted', async () => {
    grantedScope = 'openid profile email offline_access'
    await expect(loginChatGPT(opts())).rejects.toThrow(/plan usage was not granted/)
    const rec = await readChatGPTAuth()
    expect(rec?.clientId).toBe('oaiapp_123')
    expect(rec?.accessToken).toBeUndefined()
  })

  it('auth list, logout (revokes) and the UI notice', async () => {
    await loginChatGPT(opts())
    let out = capture()
    await runAuthCommand('list')
    expect(out[0]).toBe('chatgpt: signed in (ChatGPT plan) as dev@example.com')
    expect(await runLogoutCommand('chatgpt', { issuer })).toBe(0)
    expect(Object.fromEntries(revokeCalls[0]!)).toEqual({ token: 'rt1', token_type_hint: 'refresh_token', client_id: 'oaiapp_123' })
    const rec = await readChatGPTAuth()
    expect(rec).toMatchObject({ clientId: 'oaiapp_123', hostId: expect.stringMatching(/^urn:uuid:/) })
    expect(rec?.refreshToken).toBeUndefined()
    vi.restoreAllMocks()
    out = capture()
    await runAuthCommand('list')
    expect(out[0]).toBe('chatgpt: signed out (hesdor login chatgpt)')
    expect(chatgptPlanNotice('chatgpt')).toEqual({ label: 'Using ChatGPT plan', linkText: 'Manage usage', url: 'https://chatgpt.com/settings/usage' })
    expect(chatgptPlanNotice('openai')).toBeUndefined()
  })
})

describe('interactive-only plans', () => {
  it('refuses the Qwen Coding Plan in headless mode, citing its terms', async () => {
    process.env.ALIBABA_CODING_PLAN_API_KEY = 'sk-sp-test'
    const out = capture()
    const flags: CliFlags = { yes: false, debug: false, force: false, version: false, help: false, provider: 'qwen-coding-plan' }
    const code = await runHeadless('ask', 'hello', flags, { cwd: mkdtempSync(path.join(tmpdir(), 'hesdor-qwen-')) })
    delete process.env.ALIBABA_CODING_PLAN_API_KEY
    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/interactive use only.*coding-plan/)
  })
})
