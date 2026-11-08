import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Client, ElicitRequest, ElicitResult, JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { childEnv, killChild, needsWindowsShell, windowsQuoteJoin } from '../exec.js'
import { McpOAuthProvider } from './oauth.js'
import type { McpOAuthOptions } from './oauth.js'

export interface McpServerConfig {
  /** stdio server: the program to start. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Streamable HTTP server endpoint, used instead of `command`. */
  url?: string
  /** Static HTTP headers, e.g. `Authorization`. */
  headers?: Record<string, string>
  /** Startup and tools/list timeout in ms (default 10 s). */
  timeout?: number
  /** tools/call timeout in ms (default 120 s). */
  toolTimeout?: number
  /** OAuth client settings for a `url` server (otherwise discovered). */
  oauth?: McpOAuthOptions
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** Server-supplied hints; only trusted for servers in the user's own mcp.json. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

export interface McpPromptDef {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpResourceDef {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** Form-mode `elicitation/create` params (legacy request or a 2026-07-28 input_required round). */
export type McpElicitRequest = ElicitRequest['params']
export type McpElicitResult = ElicitResult

export interface McpCallResult {
  text: string
  isError: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const TOOL_CALL_TIMEOUT_MS = 120_000
// A legacy stdio server that silently ignores the server/discover probe costs this much startup time.
const PROBE_TIMEOUT_MS = 3_000
const STDERR_TAIL_CHARS = 2_000
const DECLINE: ElicitResult = { action: 'decline' }

/** The MCP SDK (~1 MB with its deps), loaded on the first connect so runs without MCP servers never pay for it. */
let sdk: typeof import('@modelcontextprotocol/client')

/**
 * stdio transport that spawns the server itself, so it gets Hesdor's scrubbed
 * environment and cmd.exe argument refusal instead of the SDK's cross-spawn.
 * `stderr` and `pid` mark it as stdio-shaped for the SDK's version probe.
 */
class StdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly stderr = null
  stderrTail = ''
  private proc: ChildProcess | null = null
  private closed = false

  constructor(private readonly config: McpServerConfig & { command: string }) {}

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  start(): Promise<void> {
    const { command, args = [], env } = this.config
    const useShell = process.platform === 'win32' && needsWindowsShell(command)
    // windowsQuoteJoin throws on cmd metacharacters, so a config argument can never become a second command.
    const proc = useShell
      ? spawn('cmd.exe', ['/d', '/s', '/c', windowsQuoteJoin([command, ...args])], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: childEnv(env),
        })
      : spawn(command, args, { windowsHide: true, env: childEnv(env) })
    this.proc = proc
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (line.trim() === '') return
      let message: JSONRPCMessage
      try {
        message = sdk.deserializeMessage(line)
      } catch {
        return // stray non-protocol output must not kill the session
      }
      this.onmessage?.(message)
    })
    proc.stdin?.on('error', () => {}) // EPIPE after the server died; 'exit' reports it
    proc.once('exit', () => this.markClosed())
    return new Promise((resolve, reject) => {
      proc.once('spawn', () => resolve())
      proc.once('error', (err) => {
        reject(new Error(`failed to start: ${err.message}`))
        this.markClosed()
      })
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.stdin
      if (!stdin?.writable) return reject(new Error('server process is not running'))
      stdin.write(sdk.serializeMessage(message), (err) => (err ? reject(err) : resolve()))
    })
  }

  async close(): Promise<void> {
    killChild(this.proc)
    this.markClosed()
  }

  private markClosed(): void {
    this.proc = null
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

/**
 * Model Context Protocol client on the official SDK (`@modelcontextprotocol/client`)
 * over stdio or Streamable HTTP. Negotiates the 2026-07-28 stateless protocol and
 * falls back to the 2025 `initialize` handshake. A server that dies is
 * reconnected on the next call.
 */
export class McpClient {
  readonly serverInfo: { name?: string; version?: string } = {}
  /** Full, sorted tool list after `notifications/tools/list_changed` or a reconnect. */
  onToolsChanged?: (tools: McpToolDef[]) => void
  /** Answers server questions (elicitation); unset means decline. */
  onElicit?: (request: McpElicitRequest) => Promise<McpElicitResult>
  private client: Client | null = null
  private transport: Transport | null = null
  private closing = false
  private reconnecting: Promise<void> | null = null
  private oauth: McpOAuthProvider | undefined

  private constructor(
    readonly config: McpServerConfig,
    readonly name?: string,
  ) {}

  /** `name` keys the server's stored OAuth tokens; without it a `url` server gets no OAuth. */
  static async connect(config: McpServerConfig, timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS, name?: string): Promise<McpClient> {
    const client = new McpClient(config, name)
    await client.open(timeoutMs)
    return client
  }

  /** False after the server exited or the connection dropped. */
  get alive(): boolean {
    return this.client !== null
  }

  private get label(): string {
    return this.config.url ?? this.config.command ?? '?'
  }

  private async open(timeoutMs: number): Promise<void> {
    if (!this.config.url && !this.config.command) throw new Error('MCP server config needs "command" or "url"')
    sdk ??= await import('@modelcontextprotocol/client')
    const { SdkError, SdkErrorCode } = sdk
    try {
      await this.attempt(timeoutMs, false)
    } catch (err) {
      // Servers built on SDKs that exit on any pre-initialize request die on the probe: retry the 2025 handshake.
      if (this.config.url || !(err instanceof SdkError && err.code === SdkErrorCode.EraNegotiationFailed)) {
        throw this.withStderr(err)
      }
      try {
        await this.attempt(timeoutMs, true)
      } catch (retryErr) {
        throw this.withStderr(retryErr)
      }
    }
  }

  private async attempt(timeoutMs: number, legacy: boolean): Promise<void> {
    const { url, command, headers } = this.config
    // A static Authorization header means the user handles auth; otherwise OAuth on a 401.
    const staticAuth = Object.keys(headers ?? {}).some((h) => h.toLowerCase() === 'authorization')
    if (url && this.name && !staticAuth) this.oauth ??= new McpOAuthProvider(this.name, url, { oauth: this.config.oauth })
    const transport: Transport = url
      ? new sdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, ...(this.oauth ? { authProvider: this.oauth } : {}) })
      : new StdioTransport({ ...this.config, command: command! })
    const client = new sdk.Client(
      { name: 'hesdor', version: '0.1.0' },
      {
        // Form mode only: URL mode needs a consent UI that shows the full URL first.
        capabilities: { elicitation: { form: {} } },
        // HTTP silence is an outage, so only stdio gets the short probe.
        versionNegotiation: { mode: 'auto', ...(url ? {} : { probe: { timeoutMs: Math.min(PROBE_TIMEOUT_MS, timeoutMs) } }) },
        listChanged: {
          tools: {
            onChanged: (err, tools) => {
              if (!err && tools && this.client === client) this.onToolsChanged?.(toDefs(tools))
            },
          },
        },
      },
    )
    // Serves both the 2025 server-to-client request and 2026-07-28 input_required rounds.
    client.setRequestHandler('elicitation/create', async (request) =>
      this.onElicit && request.params.mode !== 'url' ? this.onElicit(request.params) : DECLINE,
    )
    client.onclose = () => {
      if (this.client === client) this.client = null
    }
    this.transport = transport
    try {
      await client.connect(transport, { timeout: timeoutMs, ...(legacy ? { prior: { kind: 'legacy' as const } } : {}) })
    } catch (err) {
      await client.close().catch(() => {})
      throw err
    }
    this.client = client
    const info = client.getServerVersion()
    if (info) Object.assign(this.serverInfo, { name: info.name, version: info.version })
  }

  private withStderr(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err)
    const tail = this.transport instanceof StdioTransport ? this.transport.stderrTail.trim() : ''
    return new Error(tail ? `${message}\nserver stderr:\n${tail}` : message)
  }

  /** The live SDK client; reconnects once per call when the server has died. */
  private async ready(): Promise<Client> {
    if (this.client) return this.client
    if (this.closing) throw new Error(`MCP server "${this.label}" was closed`)
    const wasDead = this.transport !== null
    this.reconnecting ??= this.open(this.config.timeout ?? DEFAULT_TIMEOUT_MS).finally(() => {
      this.reconnecting = null
    })
    try {
      await this.reconnecting
    } catch (err) {
      throw new Error(
        `MCP server "${this.label}" is not running and reconnecting failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (wasDead) this.listTools().then((tools) => this.onToolsChanged?.(tools), () => {})
    return this.client!
  }

  /** Every page of tools/list, sorted by name so the tool list is byte-stable. */
  async listTools(): Promise<McpToolDef[]> {
    const client = await this.ready()
    const { tools } = await client.listTools(undefined, { timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS })
    return toDefs(tools)
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const client = await this.ready()
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: this.config.toolTimeout ?? TOOL_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    )
    return { text: contentToText(result), isError: result?.isError === true }
  }

  /** Prompts, sorted by name; empty when the server offers none. */
  async listPrompts(): Promise<McpPromptDef[]> {
    const client = await this.ready()
    if (!client.getServerCapabilities()?.prompts) return []
    const { prompts } = await client.listPrompts(undefined, { timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS })
    return prompts
      .map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** prompts/get as one text: messages joined, non-user turns labelled. */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const client = await this.ready()
    const { messages } = await client.getPrompt({ name, arguments: args }, { timeout: this.config.toolTimeout ?? TOOL_CALL_TIMEOUT_MS })
    return messages
      .map((m) => (m.role === 'user' ? '' : `[${m.role}]\n`) + contentToText({ content: [m.content] }))
      .join('\n\n')
  }

  /** Resources, sorted by URI; empty when the server offers none. */
  async listResources(): Promise<McpResourceDef[]> {
    const client = await this.ready()
    if (!client.getServerCapabilities()?.resources) return []
    const { resources } = await client.listResources(undefined, { timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS })
    return resources
      .map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }))
      .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
  }

  /** resources/read as text; binary contents become a placeholder. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const client = await this.ready()
    const { contents } = await client.readResource(
      { uri },
      { timeout: this.config.toolTimeout ?? TOOL_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    )
    return contentToText({ content: contents.map((resource) => ({ type: 'resource', resource })) })
  }

  close(): void {
    this.closing = true
    const client = this.client
    this.client = null
    if (client) void client.close().catch(() => {})
    else void this.transport?.close().catch(() => {})
  }
}

function toDefs(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: McpToolDef['annotations'] }>,
): McpToolDef[] {
  return tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const base64Bytes = (data: unknown): string =>
  typeof data === 'string' ? `${Math.floor((data.length * 3) / 4)} bytes` : 'unknown size'

/**
 * Tool result as text for the model. Images and audio become a placeholder
 * (providers here take no tool-result media), embedded text resources are
 * inlined, and structuredContent is JSON unless a text block already carries it.
 */
export function contentToText(result: { content?: unknown; structuredContent?: unknown } | null | undefined): string {
  const parts: string[] = []
  const blocks = Array.isArray(result?.content) ? (result.content as Array<Record<string, unknown> | null>) : []
  for (const block of blocks) {
    const type = block?.type
    if (type === 'text') parts.push(String(block!.text ?? ''))
    else if (type === 'image' || type === 'audio') {
      parts.push(`[${type} ${String(block!.mimeType ?? 'unknown type')}, ${base64Bytes(block!.data)} not shown]`)
    } else if (type === 'resource') {
      const r = (block!.resource ?? {}) as Record<string, unknown>
      parts.push(
        typeof r.text === 'string'
          ? `[resource ${String(r.uri)}]\n${r.text}`
          : `[resource ${String(r.uri)}: ${String(r.mimeType ?? 'binary')}, ${base64Bytes(r.blob)} not shown]`,
      )
    } else if (type === 'resource_link') parts.push(`[resource link: ${String(block!.name ?? '')} ${String(block!.uri)}]`)
    else parts.push(`[${String(type ?? 'unknown')} content not shown]`)
  }
  const structured = result?.structuredContent
  if (structured !== undefined) {
    const json = JSON.stringify(structured)
    const duplicated = parts.some((p) => {
      try {
        return JSON.stringify(JSON.parse(p)) === json
      } catch {
        return false
      }
    })
    if (!duplicated) parts.push(json)
  }
  return parts.join('\n')
}
