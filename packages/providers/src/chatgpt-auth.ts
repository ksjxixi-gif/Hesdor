import { open, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { joinUrl, ProviderError } from './provider.js'

/**
 * "ChatGPT plan usage" for open-source apps (Sign in with ChatGPT):
 * https://developers.openai.com/siwc/token-sharing-open-source.md
 * Tokens are bound to api.openai.com and refreshed only at auth.openai.com.
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_API_BASE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct'
/** "Manage usage" link from https://developers.openai.com/siwc/ui-ux-guidelines.md */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export const chatgptTokenEndpoint = (issuer = CHATGPT_ISSUER): string => `${issuer}/api/accounts/oauth/token`

/** Stored in `<config dir>/chatgpt-auth.json` (0600). */
export interface ChatGPTAuthRecord {
  /** Stable opaque host id (urn:uuid:...), created before the first sign-in and kept across sign-outs. */
  hostId: string
  /** The per-user issued client id (oaiapp_...); never `dynamic_agent_client`. */
  clientId?: string
  sub?: string
  email?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  /** ms epoch */
  expiresAt?: number
  scope?: string
  savedAt?: number
}

export interface OAuthTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
}

/** Same location as the CLI's config dir (duplicated: this package does not depend on agent-core). */
export function chatgptAuthFile(): string {
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hesdor')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'hesdor')
  return path.join(dir, 'chatgpt-auth.json')
}

export async function readChatGPTAuth(): Promise<ChatGPTAuthRecord | undefined> {
  try {
    const rec = JSON.parse(await readFile(chatgptAuthFile(), 'utf8')) as ChatGPTAuthRecord
    return typeof rec.hostId === 'string' ? rec : undefined
  } catch {
    return undefined
  }
}

export async function writeChatGPTAuth(rec: ChatGPTAuthRecord): Promise<void> {
  const file = chatgptAuthFile()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  // Owner-only (Windows ignores the mode; the profile dir's ACL applies there).
  await writeFile(tmp, `${JSON.stringify({ ...rec, savedAt: Date.now() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export const hasPlanScope = (scope: string | undefined): boolean => (scope ?? '').split(/\s+/).includes(CHATGPT_PLAN_SCOPE)

/** Signed in with plan usage granted (a refresh token can mint access tokens). */
export const chatgptSignedIn = (rec: ChatGPTAuthRecord | undefined): boolean =>
  Boolean(rec?.clientId && rec.refreshToken && hasPlanScope(rec.scope))

/** Merge a token response into the record; refresh tokens rotate, so all fields are replaced together. */
export function applyTokens(rec: ChatGPTAuthRecord, tok: OAuthTokenResponse): ChatGPTAuthRecord {
  return {
    ...rec,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? rec.refreshToken,
    idToken: tok.id_token ?? rec.idToken,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    scope: tok.scope ?? rec.scope,
  }
}

export class OAuthError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`ChatGPT sign-in failed (${code}, HTTP ${status})`)
    this.name = 'OAuthError'
  }
}

/** Form-encoded POST to the auth server; never follows redirects (tokens stay on that origin). */
export async function postForm(url: string, fields: Record<string, string>): Promise<OAuthTokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'error',
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // non-JSON body: only the status is reported
  }
  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error.replace(/[^\w.-]/g, '').slice(0, 64) : 'error'
    throw new OAuthError(code, res.status)
  }
  return json as OAuthTokenResponse
}

const SIGN_IN_HINT = 'sign in again: hesdor login chatgpt'
const notSignedIn = (why: string): ProviderError => new ProviderError(`ChatGPT: ${why}`, { kind: 'auth', retryable: false, hint: SIGN_IN_HINT })
/** https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md: these mean the refresh token is unusable. */
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
const SKEW_MS = 120_000

/** Serialize refreshes across Hesdor processes: refresh tokens rotate, so two refreshers would invalidate each other. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${chatgptAuthFile()}.lock`
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      await (await open(lock, 'wx')).close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // A crashed holder leaves a stale lock; a refresh takes seconds, not 30.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > 30_000) await rm(lock, { force: true })
      else if (Date.now() > deadline) throw new ProviderError('ChatGPT: another Hesdor process is refreshing the sign-in; try again', { kind: 'network' })
      else await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

/**
 * A usable access token for api.openai.com: the stored one while fresh, else a refresh.
 * `failed` is a token the API just rejected (401): refresh unless another process already did.
 */
export async function chatgptAccessToken(opts: { failed?: string; issuer?: string } = {}): Promise<string> {
  const usable = (rec: ChatGPTAuthRecord | undefined): string | undefined =>
    rec?.accessToken && rec.accessToken !== opts.failed && (rec.expiresAt ?? 0) - SKEW_MS > Date.now() ? rec.accessToken : undefined
  const check = (rec: ChatGPTAuthRecord | undefined): ChatGPTAuthRecord & { clientId: string; refreshToken: string } => {
    if (!rec?.clientId || !rec.refreshToken) throw notSignedIn('not signed in')
    if (!hasPlanScope(rec.scope)) throw notSignedIn('ChatGPT plan usage was not granted at sign-in')
    return rec as ChatGPTAuthRecord & { clientId: string; refreshToken: string }
  }
  const first = await readChatGPTAuth()
  check(first)
  const hit = usable(first)
  if (hit) return hit
  return withLock(async () => {
    const rec = check(await readChatGPTAuth()) // re-read: another process may have refreshed meanwhile
    const again = usable(rec)
    if (again) return again
    let tok: OAuthTokenResponse
    try {
      tok = await postForm(chatgptTokenEndpoint(opts.issuer), {
        grant_type: 'refresh_token',
        client_id: rec.clientId,
        refresh_token: rec.refreshToken,
        resource: CHATGPT_API_BASE,
      })
    } catch (err) {
      if (err instanceof OAuthError && TERMINAL_REFRESH.has(err.code)) {
        // Keep the host id and issued client id: the next sign-in reuses them.
        await writeChatGPTAuth({ ...rec, accessToken: undefined, refreshToken: undefined, expiresAt: undefined })
        throw notSignedIn(`the sign-in expired or was revoked (${err.code})`)
      }
      if (err instanceof OAuthError) throw new ProviderError(err.message, { status: err.status, ...(err.status === 400 || err.status === 401 ? { kind: 'auth' as const, hint: SIGN_IN_HINT } : {}) })
      throw new ProviderError(`ChatGPT: could not refresh the sign-in: ${err instanceof Error ? err.message : String(err)}`, { kind: 'network' })
    }
    if (!tok.access_token) throw new ProviderError('ChatGPT: the token endpoint returned no access token', { kind: 'auth', hint: SIGN_IN_HINT })
    const next = applyTokens(rec, tok)
    await writeChatGPTAuth(next)
    return next.accessToken!
  })
}

/**
 * Models the signed-in account can use: GET /v1/models returns `models[]` with `slug` and
 * `visibility` (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md).
 */
export async function listChatGPTModels(token: string, base = CHATGPT_API_BASE, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(joinUrl(base, '/models'), { headers: { authorization: `Bearer ${token}` }, redirect: 'error', ...(signal ? { signal } : {}) })
  if (!res.ok) throw new ProviderError(`ChatGPT: could not list models (HTTP ${res.status})`, { status: res.status })
  const json = (await res.json()) as { models?: Array<{ slug?: string; visibility?: string }>; data?: Array<{ id?: string }> }
  const ids = json.models
    ? json.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => m.slug!)
    : (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  return [...new Set(ids)]
}
