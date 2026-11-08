import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { hesdorGlobalDir } from '../plugins.js'

/** Per-server OAuth settings from mcp.json (`"oauth": { ... }`). */
export interface McpOAuthOptions {
  /** Pre-registered client id; used before CIMD and dynamic registration (spec priority 1). */
  clientId?: string
  /** HTTPS URL of a Client ID Metadata Document, used when the authorization server supports CIMD. */
  clientMetadataUrl?: string
  /** Scope to request instead of the server's challenge or `scopes_supported`. */
  scope?: string
}

/** What `hesdor mcp login` must fix; thrown instead of opening a browser mid-session. */
export class McpAuthRequiredError extends Error {
  constructor(readonly server: string) {
    super(`authorization required: run "hesdor mcp login ${server}"`)
    this.name = 'McpAuthRequiredError'
  }
}

interface AuthRecord {
  /** Tokens are bound to this exact server URL and never offered to another. */
  serverUrl: string
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  /** ms epoch when `tokens` were saved, to show expiry in `hesdor mcp list`. */
  savedAt?: number
}

const canonical = (url: string): string => new URL(url).href

/** `<config dir>/mcp-auth/<name>-<hash>.json`; the hash keeps odd names (CON, ../x) safe as file names. */
export function mcpAuthFile(server: string): string {
  const hash = createHash('sha256').update(server).digest('hex').slice(0, 8)
  return path.join(hesdorGlobalDir(), 'mcp-auth', `${server.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${hash}.json`)
}

async function readRecord(server: string, serverUrl: string): Promise<AuthRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(mcpAuthFile(server), 'utf8')) as AuthRecord
    return record.serverUrl === canonical(serverUrl) ? record : undefined
  } catch {
    return undefined // missing or corrupt: the next login rewrites it
  }
}

async function writeRecord(server: string, record: AuthRecord): Promise<void> {
  const file = mcpAuthFile(server)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  // Owner-only (Windows ignores the mode; the profile dir's ACL applies there).
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/callback'

/**
 * The SDK's OAuthClientProvider for one MCP server: tokens and client registration
 * persist per server in the user config dir; the PKCE verifier, state and discovery
 * stay in memory. Non-interactive (sessions) it can refresh but never starts a login.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  private record: AuthRecord | undefined
  private loaded = false
  private verifier = ''
  private discovery: OAuthDiscoveryState | undefined

  constructor(
    readonly server: string,
    readonly serverUrl: string,
    private readonly opts: { oauth?: McpOAuthOptions; redirectUrl?: string; state?: string; interactive?: boolean } = {},
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl ?? PLACEHOLDER_REDIRECT
  }

  get clientMetadataUrl(): string | undefined {
    return this.opts.oauth?.clientMetadataUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Hesdor',
      client_uri: 'https://github.com/ksjxixi-gif/Hesdor',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.oauth?.scope ? { scope: this.opts.oauth.scope } : {}),
    }
  }

  state(): string {
    return this.opts.state ?? ''
  }

  /** The issuer recorded at discovery, for RFC 9207 checks on the callback. */
  get recordedIssuer(): string | undefined {
    return this.discovery?.authorizationServerMetadata?.issuer ?? this.discovery?.authorizationServerUrl
  }

  private async load(fresh = false): Promise<AuthRecord | undefined> {
    if (fresh || !this.loaded) {
      this.record = await readRecord(this.server, this.serverUrl)
      this.loaded = true
    }
    return this.record
  }

  private async update(patch: Partial<AuthRecord>): Promise<void> {
    this.record = { ...(await this.load(true)), ...patch, serverUrl: canonical(this.serverUrl) }
    await writeRecord(this.server, this.record)
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (this.opts.oauth?.clientId) return { client_id: this.opts.oauth.clientId }
    const client = (await this.load())?.client
    // Never dynamically register from inside a session: that is `hesdor mcp login`'s job.
    if (!client && !this.opts.interactive) throw new McpAuthRequiredError(this.server)
    return client
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    if (!this.opts.oauth?.clientId) await this.update({ client: info })
  }

  /** With `ctx` (the auth flow) re-read the file, so a refresh done by another Hesdor process is seen. */
  async tokens(ctx?: unknown): Promise<StoredOAuthTokens | undefined> {
    return (await this.load(ctx !== undefined))?.tokens
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.update({ tokens, savedAt: Date.now() })
  }

  redirectToAuthorization(url: URL): void {
    if (!this.opts.interactive) throw new McpAuthRequiredError(this.server)
    this.authorizationUrl = url
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') this.verifier = ''
    else if (scope === 'discovery') this.discovery = undefined
    else if (scope === 'all') {
      this.record = undefined
      await rm(mcpAuthFile(this.server), { force: true })
    } else await this.update(scope === 'client' ? { client: undefined } : { tokens: undefined })
  }
}

/** Opens `url` in the default browser without a shell; failures are silent (the URL is printed too). */
export function openBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // headless machine: the printed URL is the fallback
  }
}

interface Loopback {
  url: string
  port: number
  wait(timeoutMs: number): Promise<URLSearchParams>
  close(): void
}

/** One-shot callback listener on 127.0.0.1; requests with the wrong `state` are refused and ignored. */
function listenLoopback(port: number, state: string): Promise<Loopback> {
  let deliver!: (params: URLSearchParams) => void
  const received = new Promise<URLSearchParams>((resolve) => (deliver = resolve))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') return void res.writeHead(404).end()
    if (url.searchParams.get('state') !== state) return void res.writeHead(400).end('state mismatch')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Hesdor</title><p>Hesdor received the authorization. You can close this tab.</p>')
    deliver(url.searchParams)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${actual}/callback`,
        port: actual,
        wait: (timeoutMs) => {
          let timer: NodeJS.Timeout | undefined
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error('timed out waiting for the browser to finish authorization')), timeoutMs)
          })
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

const loopbackPort = (uri: string | undefined): number => {
  try {
    const u = new URL(uri ?? '')
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' ? Number(u.port) || 0 : 0
  } catch {
    return 0
  }
}

export interface McpLoginOptions {
  oauth?: McpOAuthOptions
  /** Called with the authorization URL; defaults to `openBrowser`. */
  openBrowser?: (url: string) => void
  print?: (line: string) => void
  timeoutMs?: number
}

/**
 * OAuth 2.1 authorization code + PKCE login for a remote MCP server (MCP 2026-07-28
 * authorization): the server's 401 challenge leads to RFC 9728 resource metadata, the
 * SDK picks pre-registered client id, CIMD or dynamic registration, sends the RFC 8707
 * `resource`, and the code comes back to a loopback listener. Tokens land in the user
 * config dir, bound to `serverUrl`.
 */
export async function loginMcpServer(server: string, serverUrl: string, opts: McpLoginOptions = {}): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line))
  const { auth, extractWWWAuthenticateParams } = await import('@modelcontextprotocol/client') // lazy: see client.ts
  const state = randomBytes(16).toString('base64url')
  // A dynamically registered client keeps its redirect URI: reuse its port when free.
  const stored = opts.oauth?.clientId ? undefined : (await readRecord(server, serverUrl))?.client
  const wanted = loopbackPort((stored as { redirect_uris?: string[] } | undefined)?.redirect_uris?.[0])
  let callback = await listenLoopback(wanted, state).catch(() => undefined)
  const reRegister = !callback && wanted !== 0
  callback ??= await listenLoopback(0, state)
  try {
    const provider = new McpOAuthProvider(server, serverUrl, { oauth: opts.oauth, redirectUrl: callback.url, state, interactive: true })
    if (reRegister) await provider.invalidateCredentials('client')
    const probe = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      redirect: 'manual',
    })
    await probe.body?.cancel()
    if (probe.status !== 401) throw new Error(`server answered HTTP ${probe.status} without an OAuth challenge; it may not need a login`)
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(probe)
    const base = { serverUrl, resourceMetadataUrl, scope: opts.oauth?.scope ?? scope }
    if ((await auth(provider, { ...base, forceReauthorization: true })) === 'AUTHORIZED') return
    const url = provider.authorizationUrl!.href
    print(`Open this URL to authorize "${server}":\n  ${url}`)
    print(`Waiting for the redirect to ${callback.url} (over SSH, forward it first: ssh -L ${callback.port}:127.0.0.1:${callback.port} <host>)`)
    ;(opts.openBrowser ?? openBrowser)(url)
    const params = await callback.wait(opts.timeoutMs ?? 300_000)
    const iss = params.get('iss') ?? undefined
    const code = params.get('code')
    if (!code) {
      // RFC 9207: never act on or show error text from an issuer we did not talk to.
      const sameIssuer = iss === undefined || iss === provider.recordedIssuer
      const error = sameIssuer ? (params.get('error') ?? 'no code').replace(/[^\w.-]/g, '').slice(0, 64) : 'issuer mismatch'
      throw new Error(`authorization failed (${error})`)
    }
    await auth(provider, { ...base, authorizationCode: code, iss })
  } finally {
    callback.close()
  }
}

/** `hesdor mcp logout`: forget the server's tokens and client registration. True if something was stored. */
export async function logoutMcpServer(server: string): Promise<boolean> {
  const file = mcpAuthFile(server)
  const existed = await readFile(file).then(
    () => true,
    () => false,
  )
  await rm(file, { force: true })
  return existed
}

/** Short auth state for `hesdor mcp list`. */
export async function mcpAuthStatus(server: string, serverUrl: string): Promise<string> {
  const record = await readRecord(server, serverUrl)
  const tokens = record?.tokens
  if (!tokens?.access_token) return 'not logged in'
  const expired = tokens.expires_in !== undefined && (record!.savedAt ?? 0) + tokens.expires_in * 1000 < Date.now()
  if (!expired) return 'logged in'
  return tokens.refresh_token ? 'logged in (token refreshes on next use)' : 'expired: run hesdor mcp login'
}
