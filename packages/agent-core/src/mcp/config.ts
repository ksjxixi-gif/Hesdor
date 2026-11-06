import { readFile } from 'node:fs/promises'
import type { McpServerConfig } from './client.js'

/** `${VAR}` and `${VAR:-default}` from the environment; an unset variable without a default becomes ''. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] || fallback || '')
}

const stringMap = (value: unknown): Record<string, string> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter((e): e is [string, string] => typeof e[1] === 'string')
          .map(([k, v]) => [k, expandEnvVars(v)]),
      )
    : undefined

const positive = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 ? value : undefined)

/** Validates one server entry from a config file; undefined for disabled or unusable entries. */
function toServerConfig(raw: unknown): McpServerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (r.disabled === true) return undefined
  const config: McpServerConfig = {}
  if (typeof r.url === 'string') {
    config.url = expandEnvVars(r.url)
    config.headers = stringMap(r.headers)
    const oauth = stringMap(r.oauth)
    if (oauth) config.oauth = { clientId: oauth.clientId, clientMetadataUrl: oauth.clientMetadataUrl, scope: oauth.scope }
  } else if (typeof r.command === 'string') {
    config.command = expandEnvVars(r.command)
    if (Array.isArray(r.args)) config.args = r.args.filter((a): a is string => typeof a === 'string').map((a) => expandEnvVars(a))
    config.env = stringMap(r.env)
  } else {
    return undefined
  }
  config.timeout = positive(r.timeout)
  config.toolTimeout = positive(r.toolTimeout)
  return config
}

/**
 * Merge MCP server configs from JSON files; a later file replaces a same-named
 * server. Reads Hesdor's `{ "mcp": { ... } }` and the `.mcp.json` / Claude Code
 * shape `{ "mcpServers": { ... } }`. `disabled: true` drops a server (also one
 * defined in an earlier file). Missing or invalid files are skipped.
 */
export async function readMcpConfigFiles(files: string[]): Promise<Record<string, McpServerConfig>> {
  const merged: Record<string, unknown> = {}
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcp?: object; mcpServers?: object }
      Object.assign(merged, parsed.mcpServers, parsed.mcp)
    } catch {
      // missing or invalid config files are not fatal
    }
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(merged)) {
    const config = toServerConfig(raw)
    if (config) servers[name] = config
  }
  return servers
}
