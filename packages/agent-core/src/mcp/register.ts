import type { ToolRisk } from '@hesdor/protocol'
import type { CustomCommand } from '../commands.js'
import { PermissionDeniedError, riskAllowedInMode } from '../policy.js'
import type { ToolRegistry } from '../registry.js'
import type { ExternalTool } from '../tools/types.js'
import { McpClient } from './client.js'
import type { McpElicitRequest, McpElicitResult, McpPromptDef, McpResourceDef, McpServerConfig, McpToolDef } from './client.js'

export interface RegisteredMcpServer {
  name: string
  client: McpClient
  tools: string[]
  prompts: McpPromptDef[]
  resources: McpResourceDef[]
  /** Configured in the user's own mcp.json (not by a repository): its tool annotations count. */
  userScope: boolean
}

/** Host hook for server questions; the default declines. */
export type McpElicitHook = (server: string, request: McpElicitRequest) => Promise<McpElicitResult>

export interface RegisterMcpOptions {
  /** Server names from the user-scope mcp.json that no project file overrides. */
  userScoped?: Iterable<string>
  onElicit?: McpElicitHook
}

/**
 * Risk of an MCP tool. Annotations are the server's own claims, so they only count for
 * servers the user configured; a repository's servers stay NETWORK (blocked in plan/ask).
 */
export function mcpToolRisk(def: McpToolDef, userScope: boolean): ToolRisk {
  const a = def.annotations
  if (!userScope || !a) return 'NETWORK'
  if (a.readOnlyHint === true) return a.openWorldHint === true ? 'NETWORK' : 'READ'
  return a.destructiveHint === true ? 'DESTRUCTIVE' : 'NETWORK'
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_')
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Connect to MCP servers in parallel and register their tools as NETWORK-risk
 * tools, in config order then tool-name order. Names are namespaced
 * `mcp_<server>_<tool>`. A failing server warns but never aborts startup.
 */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
  warn: (message: string) => void = () => {},
  options: RegisterMcpOptions = {},
): Promise<RegisteredMcpServer[]> {
  const entries = Object.entries(servers)
  const userScoped = new Set(options.userScoped ?? [])
  const started = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      const client = await McpClient.connect(config, undefined, name)
      if (options.onElicit) client.onElicit = (request) => options.onElicit!(name, request)
      let defs: McpToolDef[]
      try {
        defs = await client.listTools()
      } catch (err) {
        client.close()
        throw new Error(`tools/list failed: ${message(err)}`)
      }
      // Prompts and resources are extras: a failure costs only them.
      const extra = <T>(what: string, list: Promise<T[]>): Promise<T[]> =>
        list.catch((err) => {
          warn(`mcp server "${name}" ${what} failed: ${message(err)}`)
          return []
        })
      const [prompts, resources] = await Promise.all([
        extra('prompts/list', client.listPrompts()),
        extra('resources/list', client.listResources()),
      ])
      return { client, defs, prompts, resources }
    }),
  )

  const registered: RegisteredMcpServer[] = []
  started.forEach((outcome, i) => {
    const name = entries[i]![0]
    if (outcome.status === 'rejected') {
      warn(`mcp server "${name}" failed to start: ${message(outcome.reason)}`)
      return
    }
    const { client, defs, prompts, resources } = outcome.value
    const userScope = userScoped.has(name)
    registered.push({ name, client, tools: registerTools(registry, name, client, defs, userScope), prompts, resources, userScope })
  })
  if (registered.some((s) => s.resources.length > 0) && !registry.get(READ_RESOURCE_TOOL)) {
    registry.register(createReadResourceTool(registered))
  }
  return registered
}

/**
 * Registers a server's tools and keeps them in sync on tools/list_changed:
 * new tools are added, changed ones updated in place, removed ones refuse to
 * run (the registry has no removal, and a stable tool list keeps the prompt cache).
 */
function registerTools(registry: ToolRegistry, server: string, client: McpClient, defs: McpToolDef[], userScope: boolean): string[] {
  const names: string[] = []
  const tools = new Map<string, ExternalTool>()
  const live = new Map<string, McpToolDef>()

  const sync = (next: McpToolDef[]): void => {
    live.clear()
    for (const def of next) {
      const toolName = `mcp_${sanitize(server)}_${sanitize(def.name)}`.slice(0, 64)
      if (live.has(toolName)) continue
      const description = `[mcp:${server}] ${def.description ?? def.name}`
      const parametersJsonSchema = def.inputSchema ?? { type: 'object', properties: {} }
      const existing = tools.get(toolName)
      if (existing) {
        existing.description = description
        existing.parametersJsonSchema = parametersJsonSchema
        existing.risk = mcpToolRisk(def, userScope)
      } else {
        if (registry.get(toolName)) continue // taken by a built-in or another server
        const tool: ExternalTool = {
          name: toolName,
          description,
          risk: mcpToolRisk(def, userScope),
          parametersJsonSchema,
          execute: async (input, ctx) => {
            const current = live.get(toolName)
            if (!current) throw new Error(`mcp tool "${toolName}" is no longer offered by server "${server}"`)
            const args =
              typeof input === 'object' && input !== null && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {}
            const result = await client.callTool(current.name, args, ctx?.signal)
            if (result.isError) throw new Error(result.text || `mcp tool "${current.name}" failed`)
            return { text: result.text }
          },
        }
        registry.register(tool)
        tools.set(toolName, tool)
        names.push(toolName)
      }
      live.set(toolName, def)
    }
  }

  sync(defs)
  client.onToolsChanged = sync
  return names
}

export const READ_RESOURCE_TOOL = 'mcp_read_resource'
const MAX_RESOURCE_CHARS = 100_000
const LISTED_RESOURCES = 50

const resourceLine = (r: McpResourceDef): string => (r.name && r.name !== r.uri ? `${r.uri} (${r.name})` : r.uri)

/**
 * READ tool over every server's resources. A repository's server still needs a mode
 * that allows NETWORK, since the URI the model picks reaches that server.
 */
function createReadResourceTool(servers: RegisteredMcpServer[]): ExternalTool {
  const known = servers.flatMap((s) => s.resources.map((r) => `${s.name}: ${resourceLine(r)}`))
  const shown = known.slice(0, LISTED_RESOURCES).join('\n')
  const more = known.length > LISTED_RESOURCES ? `\n... ${known.length - LISTED_RESOURCES} more (omit uri to list a server's resources)` : ''
  return {
    name: READ_RESOURCE_TOOL,
    description: `Read a resource (file, document, record) from a connected MCP server by URI. Omit uri to list the server's resources. Known resources:\n${shown}${more}`,
    risk: 'READ',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', enum: servers.map((s) => s.name), description: 'MCP server name' },
        uri: { type: 'string', description: 'Resource URI; omit to list resources' },
      },
      required: ['server'],
    },
    execute: async (input, ctx) => {
      const { server, uri } = (input ?? {}) as { server?: unknown; uri?: unknown }
      const target = servers.find((s) => s.name === server)
      if (!target) throw new Error(`unknown MCP server "${String(server)}" (have: ${servers.map((s) => s.name).join(', ')})`)
      if (!target.userScope && !riskAllowedInMode(ctx.mode, 'NETWORK')) {
        throw new PermissionDeniedError(
          `permission denied: MCP server "${target.name}" comes from this repository, so reading its resources needs build mode`,
        )
      }
      if (uri === undefined || uri === '') {
        const list = await target.client.listResources()
        return { text: list.length > 0 ? list.map(resourceLine).join('\n') : `server "${target.name}" lists no resources` }
      }
      if (typeof uri !== 'string') throw new Error('uri must be a string')
      const text = await target.client.readResource(uri, ctx.signal)
      return {
        text:
          text.length > MAX_RESOURCE_CHARS
            ? `${text.slice(0, MAX_RESOURCE_CHARS)}\n[truncated: ${text.length - MAX_RESOURCE_CHARS} more characters not shown]`
            : text,
      }
    },
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
const usageOf = (defs: McpPromptDef['arguments'] = []): string =>
  defs.map((d) => (d.required ? `${d.name}=<...>` : `[${d.name}=<...>]`)).join(' ')

/**
 * Prompt arguments from slash-command text: `key=value` (quotes allowed) by name, other
 * words fill the remaining declared arguments in order, the last one taking the rest.
 */
export function parsePromptArgs(text: string, defs: McpPromptDef['arguments'] = []): Record<string, string> {
  const names = new Set(defs.map((d) => d.name))
  const args: Record<string, string> = {}
  const words: string[] = []
  for (const m of text.matchAll(/(?:([A-Za-z_][\w-]*)=)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g)) {
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? m[4] ?? '')
    if (m[1] && names.has(m[1])) args[m[1]] = value
    else words.push(m[1] ? `${m[1]}=${value}` : value)
  }
  const open = defs.filter((d) => !(d.name in args))
  open.forEach((d, i) => {
    const value = i === open.length - 1 ? words.splice(0).join(' ') : words.shift()
    if (value) args[d.name] = value
  })
  const missing = defs.filter((d) => d.required && !args[d.name])
  if (missing.length > 0) {
    throw new Error(`missing argument ${missing.map((d) => `"${d.name}"`).join(', ')}; usage: ${usageOf(defs)}`)
  }
  return args
}

/**
 * MCP prompts as slash commands `/mcp__<server>__<prompt>`. Hosts run them through
 * `expand` (prompts/get on the server); `template` is only a fallback.
 */
export function mcpPromptCommands(servers: RegisteredMcpServer[]): CustomCommand[] {
  const commands = new Map<string, CustomCommand>()
  for (const server of servers) {
    for (const prompt of server.prompts) {
      const name = `mcp__${slug(server.name)}__${slug(prompt.name)}`
      if (commands.has(name)) continue
      const usage = usageOf(prompt.arguments)
      commands.set(name, {
        name,
        description: `[mcp:${server.name}] ${(prompt.description ?? prompt.name).replace(/\s+/g, ' ').slice(0, 120)}${usage ? ` · ${usage}` : ''}`,
        template: `Run the MCP prompt "${prompt.name}" of server "${server.name}" with: $ARGUMENTS`,
        expand: async (text) => server.client.getPrompt(prompt.name, parsePromptArgs(text, prompt.arguments)),
      })
    }
  }
  return [...commands.values()]
}
