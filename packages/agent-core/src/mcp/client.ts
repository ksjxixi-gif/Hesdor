import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { killChild, needsWindowsShell, windowsQuoteJoin } from '../exec.js'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  text: string
  isError: boolean
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 10_000
const TOOL_CALL_TIMEOUT_MS = 120_000

/**
 * Minimal Model Context Protocol client over stdio (newline-delimited
 * JSON-RPC 2.0). Supports the initialize handshake, tools/list and tools/call.
 * Server-initiated requests are answered only where required (ping).
 */
export class McpClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingEntry>()
  readonly serverInfo: { name?: string; version?: string } = {}

  static async connect(config: McpServerConfig, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpClient> {
    const client = new McpClient()
    client.spawnProcess(config)
    try {
      const result = (await client.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'hesdor', version: '0.1.0' },
        },
        timeoutMs,
      )) as { serverInfo?: { name?: string; version?: string } }
      if (result?.serverInfo) Object.assign(client.serverInfo, result.serverInfo)
    } catch (err) {
      client.close()
      throw err
    }
    client.notify('notifications/initialized')
    return client
  }

  private spawnProcess(config: McpServerConfig): void {
    const useShell = process.platform === 'win32' && needsWindowsShell(config.command)
    this.proc = useShell
      ? spawn('cmd.exe', ['/d', '/s', '/c', windowsQuoteJoin([config.command, ...(config.args ?? [])])], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, ...config.env },
        })
      : spawn(config.command, config.args ?? [], {
          windowsHide: true,
          env: { ...process.env, ...config.env },
        })

    const stdout = this.proc.stdout
    if (!stdout) throw new Error(`MCP server "${config.command}" has no stdout`)
    const rl = createInterface({ input: stdout })
    rl.on('line', (line) => this.handleMessage(line))
    this.proc.stderr?.on('data', () => {
      // Server logs are ignored; they must never corrupt the JSON channel.
    })
    const failAll = (err: Error): void => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(err)
      }
      this.pending.clear()
    }
    // Without an 'error' listener, spawn failures crash the process.
    this.proc.once('error', (err) => failAll(new Error(`MCP server "${config.command}" failed to start: ${err.message}`)))
    this.proc.once('exit', () => failAll(new Error(`MCP server "${config.command}" exited before responding`)))
  }

  private handleMessage(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const key = typeof msg.id === 'number' ? msg.id : Number(msg.id)
      const entry = Number.isInteger(key) ? this.pending.get(key as number) : undefined
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(key as number)
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'MCP request failed'))
      else entry.resolve(msg.result)
      return
    }

    // Server-initiated requests: answer ping so keepalives don't time out.
    if (msg.method === 'ping') {
      this.write({ jsonrpc: '2.0', id: this.nextId++, result: {} })
    }
    // Other notifications/requests from the server are ignored.
  }

  private write(message: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  notify(method: string): void {
    this.write({ jsonrpc: '2.0', method })
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request('tools/list', {}, DEFAULT_TIMEOUT_MS)) as { tools?: McpToolDef[] }
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, TOOL_CALL_TIMEOUT_MS)) as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
    const text = (result.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    return { text, isError: result.isError === true }
  }

  close(): void {
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    if (this.proc) {
      killChild(this.proc)
      this.proc = null
    }
  }
}
