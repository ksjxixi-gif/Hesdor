import { execFile } from 'node:child_process'
import * as http from 'node:http'
import type { ProviderErrorKind } from '@hesdor/protocol'

export type { ModelProvider, ProviderErrorKind } from '@hesdor/protocol'

const HINTS: Record<ProviderErrorKind, string | undefined> = {
  auth: 'check the API key: hesdor setup',
  rate_limit: 'rate limited by the provider; wait a moment and try again',
  quota_exhausted: 'quota or credits exhausted; check billing for this provider or switch: hesdor model',
  overloaded: 'the provider is overloaded or failing; try again shortly or switch model: hesdor model',
  context_overflow: 'the conversation is too long for this model; start a new session or /compact',
  model_not_found: 'check the model id: hesdor model (and the base URL)',
  bad_request: 'the provider rejected the request; check the model supports tool calls, or run hesdor doctor',
  network: 'check the network connection and the base URL',
  unknown: undefined,
}

/** https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md: no automatic fallback to paid billing. */
const CHATGPT_LIMIT_HINT =
  'ChatGPT plan usage limit reached; it does not fall back to paid API billing. Manage usage: https://chatgpt.com/settings/usage, wait, or switch provider: hesdor model'

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limit', 'overloaded', 'network'])

export class ProviderError extends Error {
  readonly status?: number
  readonly body?: string
  readonly kind: ProviderErrorKind
  /** Read duck-typed by the agent loop's retry. */
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    options?: { status?: number; body?: string; kind?: ProviderErrorKind; retryable?: boolean; retryAfterMs?: number; hint?: string },
  ) {
    const text = `${message} ${options?.body ?? ''}`
    const kind = options?.kind ?? classify(options?.status, text)
    const hint = options?.hint ?? (/subscription_sharing_usage_limit_exceeded/.test(text) ? CHATGPT_LIMIT_HINT : HINTS[kind])
    super(`${options?.body ? `${message}: ${options.body}` : message}${hint ? `\nhint: ${hint}` : ''}`)
    this.name = 'ProviderError'
    this.status = options?.status
    this.body = options?.body
    this.kind = kind
    this.retryable = options?.retryable ?? RETRYABLE.has(kind)
    this.retryAfterMs = options?.retryAfterMs
  }
}

/** Map an HTTP status and/or error text to a kind. Text rules cover in-stream errors that have no status. */
export function classify(status: number | undefined, text: string): ProviderErrorKind {
  if (status === 401 || status === 403 || /\b(invalid|incorrect|missing) (x-)?api.?key|authentication_error|unauthorized/i.test(text)) return 'auth'
  if (status === 402 || /insufficient_quota|quota|billing|credit balance|out of credits|usage_limit_exceeded/i.test(text)) return 'quota_exhausted'
  if (/subscription_sharing_usage_unavailable/.test(text)) return 'overloaded'
  if (status === 429 || /rate.?limit/i.test(text)) return 'rate_limit'
  if (status === 413 || /context.?(length|window)|too many tokens|prompt is too long|maximum context|input is too long|request too large/i.test(text)) return 'context_overflow'
  if (status === 404 || /model.{0,40}(not found|does not exist|not supported|invalid)|unknown model|no such model/i.test(text)) return 'model_not_found'
  if (status === 408 || /timed? ?out|ECONNRESET|socket hang up|terminated|stream ended unexpectedly|could not reach/i.test(text)) return 'network'
  if ((status !== undefined && status >= 500) || /overloaded|server_error|internal server error|service unavailable|bad gateway/i.test(text)) return 'overloaded'
  if (status !== undefined && status >= 400) return 'bad_request'
  return 'unknown'
}

/** Retry-After as milliseconds (delta-seconds or HTTP date), capped at 60 s. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), 60_000)
}

/** Build a descriptive error from a failed HTTP response. Never leaks secrets. */
export async function httpError(res: Response): Promise<ProviderError> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 2000)
  } catch {
    // ignore read failures
  }
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
  return new ProviderError(`provider request failed with HTTP ${res.status}`, {
    status: res.status,
    body,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

export function mapFetchError(err: unknown, providerName: string): Error {
  if (err instanceof Error && err.name === 'AbortError') return err
  const reason = err instanceof Error ? err.message : String(err)
  // undici hides the real cause ("fetch failed"); surface its code.
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code
  const msg = `could not reach ${providerName}: ${reason}${code ? ` (${code})` : ''}`
  // A refused connection or unknown host will not fix itself in a few seconds.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return new ProviderError(msg, { kind: 'network', retryable: false })
  return new ProviderError(msg, { kind: 'network' })
}

/** Join a base URL and path, tolerating a trailing slash on either side. */
export function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  const suffix = trimmed.endsWith('/v1') && path.startsWith('/v1/') ? path.slice(3) : path
  return `${trimmed}${suffix}`
}

/** Reasoning effort; each adapter maps it to its own wire field. */
export type Effort = 'low' | 'medium' | 'high'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

/** Who supplies the key: a fixed value, or a command whose stdout is the key (argv, run without a shell). */
export interface KeySource {
  apiKey?: string
  apiKeyCommand?: string[]
}

const KEY_TTL_MS = 50 * 60_000
const keyCache = new Map<string, { key: string; at: number }>()

/** Resolve the key for one request. Command output is cached ~50 minutes (short-lived tokens refresh by themselves). */
export async function resolveKey(src: KeySource): Promise<string | undefined> {
  const argv = src.apiKeyCommand
  if (!argv || argv.length === 0) return src.apiKey
  const id = JSON.stringify(argv)
  const hit = keyCache.get(id)
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key
  const key = await new Promise<string>((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { shell: false, timeout: 30_000, windowsHide: true }, (err, stdout) => {
      // Never include stdout in the error: it may hold a partial secret.
      if (err) reject(new ProviderError(`apiKeyCommand "${argv[0]}" failed: ${err.message.split('\n')[0]}`, { kind: 'auth', retryable: false }))
      else resolve(stdout.trim())
    })
  })
  if (!key) throw new ProviderError(`apiKeyCommand "${argv[0]}" printed no key`, { kind: 'auth', retryable: false })
  keyCache.set(id, { key, at: Date.now() })
  return key
}

let proxyApplied = false
/**
 * Route fetch through HTTPS_PROXY/HTTP_PROXY (honoring NO_PROXY) with Node's built-in proxy support.
 * Returns false when a proxy is configured but this Node cannot apply it at runtime.
 * shortcut: needs Node >= 24.14 (http.setGlobalProxyFromEnv); on older 22.21+ users set NODE_USE_ENV_PROXY=1.
 */
export function applyEnvProxy(): boolean {
  const env = process.env
  if (proxyApplied || !(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return true
  if (env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return (proxyApplied = true)
  const setProxy = (http as unknown as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv
  if (typeof setProxy !== 'function') return false
  setProxy()
  return (proxyApplied = true)
}
