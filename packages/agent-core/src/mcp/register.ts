import type { ToolRegistry } from '../registry.js'
import { McpClient } from './client.js'
import type { McpServerConfig, McpToolDef } from './client.js'

export interface RegisteredMcpServer {
  name: string
  client: McpClient
  tools: string[]
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Connect to MCP servers and register their tools as NETWORK-risk tools.
 * Names are namespaced `mcp_<server>_<tool>`. A failing server warns but
 * never aborts startup.
 */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
  warn: (message: string) => void = () => {},
): Promise<RegisteredMcpServer[]> {
  const registered: RegisteredMcpServer[] = []

  for (const [name, config] of Object.entries(servers)) {
    let client: McpClient
    try {
      client = await McpClient.connect(config)
    } catch (err) {
      warn(`mcp server "${name}" failed to start: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    let defs: McpToolDef[]
    try {
      defs = await client.listTools()
    } catch (err) {
      warn(`mcp server "${name}" tools/list failed: ${err instanceof Error ? err.message : String(err)}`)
      client.close()
      continue
    }

    const toolNames: string[] = []
    for (const def of defs) {
      const toolName = `mcp_${sanitize(name)}_${sanitize(def.name)}`.slice(0, 64)
      if (registry.get(toolName)) continue
      registry.register({
        name: toolName,
        description: `[mcp:${name}] ${def.description ?? def.name}`,
        risk: 'NETWORK',
        parametersJsonSchema: def.inputSchema ?? { type: 'object', properties: {} },
        execute: async (input) => {
          const args =
            typeof input === 'object' && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {}
          const result = await client.callTool(def.name, args)
          if (result.isError) throw new Error(result.text || `mcp tool "${def.name}" failed`)
          return { text: result.text }
        },
      })
      toolNames.push(toolName)
    }

    registered.push({ name, client, tools: toolNames })
  }

  return registered
}
