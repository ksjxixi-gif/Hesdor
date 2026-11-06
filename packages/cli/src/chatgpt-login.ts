import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { JsonWebKey } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openBrowser } from '@hesdor/agent-core'
import {
  CHATGPT_API_BASE,
  CHATGPT_ISSUER,
  CHATGPT_SCOPES,
  CHATGPT_USAGE_URL,
  applyTokens,
  chatgptAuthFile,
  chatgptSignedIn,
  chatgptTokenEndpoint,
  getPreset,
  hasPlanScope,
  listChatGPTModels,
  postForm,
  readChatGPTAuth,
  writeChatGPTAuth,
} from '@hesdor/providers'
import type { ChatGPTAuthRecord } from '@hesdor/providers'
import { loadConfig, savedModel, saveConfig } from './config.js'

/**
 * "Continue with ChatGPT": the official ChatGPT plan usage flow for open-source, locally run apps
 * (https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md): authorization code + PKCE in
 * the system browser, a 127.0.0.1 loopback callback, dynamic registration on first sign-in.
 */

const DYNAMIC_CLIENT = 'dynamic_agent_client'
const CALLBACK_PATH = '/auth/callback'

/** What the TUI shows while the chatgpt provider is active (https://developers.openai.com/siwc/ui-ux-guidelines.md). */
export function chatgptPlanNotice(providerId: string): { label: string; linkText: string; url: string } | undefined {
  return providerId === 'chatgpt' ? { label: 'Using ChatGPT plan', linkText: 'Manage usage', url: CHATGPT_USAGE_URL } : undefined
}

export interface ChatGPTLoginOptions {
  /** Test seams; production always uses auth.openai.com and api.openai.com. */
  issuer?: string
  apiBase?: string
  openBrowser?: (url: string) => void
  print?: (line: string) => void
  timeoutMs?: number
}

interface Discovery {
  issuer: string
  jwks_uri: string
  revocation_endpoint?: string
}

async function discover(issuer: string): Promise<Discovery> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { redirect: 'error' })
  if (!res.ok) throw new Error(`could not read the ChatGPT sign-in configuration (HTTP ${res.status})`)
  const d = (await res.json()) as Partial<Discovery>
  if (typeof d.issuer !== 'string' || typeof d.jwks_uri !== 'string') throw new Error('the ChatGPT sign-in configuration is incomplete')
  return d as Discovery
}

const b64json = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

/** Verify the ID token's signature (JWKS), issuer, audience, expiry and nonce; returns its claims. */
export async function verifyIdToken(idToken: string, d: Discovery, clientId: string, nonce: string): Promise<Record<string, unknown>> {
  const [h, p, s] = idToken.split('.')
  if (!h || !p || !s) throw new Error('the ID token is malformed')
  const header = b64json(h)
  const res = await fetch(d.jwks_uri, { redirect: 'error' })
  if (!res.ok) throw new Error(`could not fetch the ChatGPT signing keys (HTTP ${res.status})`)
  const { keys = [] } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> }
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('the ID token was signed with an unknown key')
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${h}.${p}`)
  const sig = Buffer.from(s, 'base64url')
  const ok =
    header.alg === 'RS256' ? verify('sha256', data, key, sig) : header.alg === 'ES256' ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) : false
  if (!ok) throw new Error('the ID token signature is invalid')
  const claims = b64json(p)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== d.issuer) throw new Error('the ID token has the wrong issuer')
  if (!aud.includes(clientId)) throw new Error('the ID token was issued for another client')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) throw new Error('the ID token has expired')
  if (claims.nonce !== nonce) throw new Error('the ID token nonce does not match this sign-in')
  if (typeof claims.sub !== 'string') throw new Error('the ID token has no subject')
  return claims
}

/** One-shot listener on 127.0.0.1 (never "localhost"); callbacks with the wrong state are refused. */
function listen(state: string): Promise<{ url: string; wait(ms: number): Promise<URLSearchParams>; close(): void }> {
  let deliver!: (p: URLSearchParams) => void
  const received = new Promise<URLSearchParams>((r) => (deliver = r))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end()
    if (url.searchParams.get('state') !== state) return void res.writeHead(400).end('state mismatch')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Hesdor</title><p>Hesdor received the ChatGPT sign-in. You can close this tab.</p>')
    deliver(url.searchParams)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        wait: (ms) => {
          let timer: NodeJS.Timeout | undefined
          const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('timed out waiting for the browser sign-in')), ms)))
          return Promise.race([received, timeout]).finally(() => clearTimeout(timer))
        },
        close: () => {
          server.close()
          server.closeAllConnections()
        },
      })
    })
  })
}

/** Sign in, store the issued client id and tokens (0600, user config dir), and return the record plus the account's models. */
export async function loginChatGPT(opts: ChatGPTLoginOptions = {}): Promise<{ record: ChatGPTAuthRecord; models: string[] }> {
  const issuer = opts.issuer ?? CHATGPT_ISSUER
  const print = opts.print ?? ((line: string) => console.log(line))
  // The host id must exist (and persist) before the first sign-in.
  let rec = await readChatGPTAuth()
  if (!rec) {
    rec = { hostId: `urn:uuid:${randomUUID()}` }
    await writeChatGPTAuth(rec)
  }
  const registered = rec.clientId
  const state = randomBytes(16).toString('base64url')
  const nonce = randomBytes(16).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const d = await discover(issuer)
  const callback = await listen(state)
  try {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: registered ?? DYNAMIC_CLIENT,
      redirect_uri: callback.url,
      scope: CHATGPT_SCOPES,
      resource: CHATGPT_API_BASE,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ext_agent_host_id: rec.hostId,
      // Display metadata, first registration only.
      ...(registered ? {} : { agent_name_hint: 'Hesdor' }),
    })
    const url = `${issuer}/api/accounts/authorize?${params}`
    print(`Continue with ChatGPT: opening your browser. If it does not open, visit:\n  ${url}`)
    print(`Waiting for the sign-in to return to ${callback.url} (over SSH, forward the port first: ssh -L <port>:127.0.0.1:<port> <host>)`)
    ;(opts.openBrowser ?? openBrowser)(url)
    const back = await callback.wait(opts.timeoutMs ?? 300_000)
    const error = back.get('error')
    if (error) throw new Error(`ChatGPT sign-in was not completed (${error.replace(/[^\w.-]/g, '').slice(0, 64)})`)
    const code = back.get('code')
    if (!code) throw new Error('ChatGPT sign-in returned no authorization code')
    const issued = back.get('client_id') ?? undefined
    if (registered && issued && issued !== registered) throw new Error('ChatGPT returned a different client id than this registration; sign-in rejected')
    if (!registered && (!issued || issued === DYNAMIC_CLIENT)) throw new Error('ChatGPT registration is incomplete (no client id was issued); try again')
    const clientId = registered ?? issued!
    const tok = await postForm(chatgptTokenEndpoint(issuer), {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: callback.url,
      resource: CHATGPT_API_BASE,
    })
    if (!tok.access_token || !tok.refresh_token || !tok.id_token) throw new Error('ChatGPT sign-in returned an incomplete token set')
    const claims = await verifyIdToken(tok.id_token, d, clientId, nonce)
    if (rec.sub && rec.sub !== claims.sub) {
      throw new Error(`this Hesdor install is registered to another ChatGPT account; to switch, delete ${chatgptAuthFile()} and sign in again`)
    }
    const next = applyTokens({ ...rec, clientId, sub: claims.sub as string, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) }, tok)
    if (!hasPlanScope(next.scope)) {
      // Keep the registration so a later sign-in can grant the scope; but do not store tokens that cannot be used.
      await writeChatGPTAuth({ ...next, accessToken: undefined, refreshToken: undefined, idToken: undefined, expiresAt: undefined })
      throw new Error('ChatGPT plan usage was not granted. Run `hesdor login chatgpt` again and allow it, or use an API key with the openai provider')
    }
    await writeChatGPTAuth(next)
    const models = await listChatGPTModels(next.accessToken!, opts.apiBase ?? CHATGPT_API_BASE).catch(() => [])
    return { record: next, models }
  } finally {
    callback.close()
  }
}

/**
 * Revoke the session (https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md)
 * and clear tokens; the host id and issued client id stay for the next sign-in.
 */
export async function logoutChatGPT(opts: { issuer?: string } = {}): Promise<{ wasSignedIn: boolean; revoked: boolean }> {
  const rec = await readChatGPTAuth()
  if (!rec?.refreshToken || !rec.clientId) return { wasSignedIn: false, revoked: false }
  let revoked = false
  try {
    const d = await discover(opts.issuer ?? CHATGPT_ISSUER)
    // shortcut: one attempt, no backoff; on failure the user is told to disconnect Hesdor in ChatGPT settings.
    if (d.revocation_endpoint) {
      const res = await fetch(d.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rec.refreshToken, token_type_hint: 'refresh_token', client_id: rec.clientId }).toString(),
        redirect: 'error',
      })
      revoked = res.ok
    }
  } catch {
    // network failure: reported below
  }
  await writeChatGPTAuth({ hostId: rec.hostId, clientId: rec.clientId, ...(rec.sub ? { sub: rec.sub } : {}), ...(rec.email ? { email: rec.email } : {}) })
  return { wasSignedIn: true, revoked }
}

/** Short state for `hesdor auth list` and doctor; undefined when never signed in. */
export async function chatgptStatus(): Promise<{ signedIn: boolean; email?: string } | undefined> {
  const rec = await readChatGPTAuth()
  if (!rec?.clientId) return undefined
  return { signedIn: chatgptSignedIn(rec), ...(rec.email ? { email: rec.email } : {}) }
}

/** The saved/preset model when the account lists it, else the account's first listed model (saved for next runs). */
export async function chooseChatGPTModel(models: string[]): Promise<string | undefined> {
  const cfg = await loadConfig()
  const current = savedModel(cfg, 'chatgpt', false) ?? getPreset('chatgpt')!.defaultModel
  if (models.length === 0 || models.includes(current)) return models.length ? current : undefined
  await saveConfig({ models: { ...cfg.models, chatgpt: models[0]! } })
  return models[0]
}

/** `hesdor login chatgpt` */
export async function runLoginCommand(target: string, opts: ChatGPTLoginOptions = {}): Promise<number> {
  if (target.trim().toLowerCase() !== 'chatgpt') {
    console.error('usage: hesdor login chatgpt   (API keys: hesdor setup)')
    return 1
  }
  try {
    const { record, models } = await loginChatGPT(opts)
    console.log(`✓ Signed in to ChatGPT${record.email ? ` as ${record.email}` : ''}. You're using your ChatGPT plan.`)
    console.log(`  Requests count against your ChatGPT plan, never paid API billing. Manage usage: ${CHATGPT_USAGE_URL}`)
    const model = await chooseChatGPTModel(models)
    if (model) console.log(`  ${models.length} model(s) available; default: ${model} (change: hesdor --provider chatgpt, then /model)`)
    console.log('  Use it: hesdor --provider chatgpt   (or hesdor provider chatgpt to make it the default)')
    return 0
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

/** `hesdor logout chatgpt` */
export async function runLogoutCommand(target: string, opts: { issuer?: string } = {}): Promise<number> {
  if (target.trim().toLowerCase() !== 'chatgpt') {
    console.error('usage: hesdor logout chatgpt   (saved API keys: hesdor auth logout <provider>)')
    return 1
  }
  const { wasSignedIn, revoked } = await logoutChatGPT(opts)
  if (!wasSignedIn) {
    console.log('not signed in to ChatGPT')
    return 0
  }
  console.log('✓ Signed out of ChatGPT; local tokens removed')
  if (!revoked) console.log('• remote revocation was not confirmed: disconnect Hesdor in ChatGPT Settings if needed')
  return 0
}
