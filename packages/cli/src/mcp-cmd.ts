import path from 'node:path'
import { findGitRoot, loginMcpServer, logoutMcpServer, McpAuthRequiredError, McpClient, mcpAuthStatus, readMcpConfigFiles } from '@hesdor/agent-core'
import type { McpServerConfig } from '@hesdor/agent-core'
import { configDir, readJsonObject, writeFileAtomic } from './config.js'

/** Server names: letters, digits, `_` and `-` (they become tool and command name parts). */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

const USAGE = `usage:
  hesdor mcp list
  hesdor mcp add <name> <command> [args...]
  hesdor mcp add <name> --url <https-url>
  hesdor mcp login <name>
  hesdor mcp logout <name>`

const userFile = (): string => path.join(configDir(), 'mcp.json')
const projectFiles = (root: string): string[] => [path.join(root, '.mcp.json'), path.join(root, '.hesdor', 'mcp.json')]

/** Remote servers only over HTTPS; plain HTTP is for a server on this machine. */
function urlError(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `invalid URL "${raw}"`
  }
  if (url.protocol === 'https:') return undefined
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined
  return `"${raw}" must use https:// (http:// only for localhost)`
}

async function add(argv: string[]): Promise<number> {
  const [name, ...rest] = argv
  if (!name || rest.length === 0) return usage()
  if (!MCP_NAME_RE.test(name)) {
    console.error(`✗ invalid server name "${name}" (letters, digits, _ and -, at most 64)`)
    return 1
  }
  let entry: { url: string } | { command: string; args: string[] }
  if (rest[0] === '--url') {
    if (rest.length !== 2) return usage()
    const error = urlError(rest[1]!)
    if (error) {
      console.error(`✗ ${error}`)
      return 1
    }
    entry = { url: rest[1]! }
  } else {
    const [command, ...args] = rest[0] === '--' ? rest.slice(1) : rest
    if (!command) return usage()
    entry = { command, args }
  }
  const file = userFile()
  const config = await readJsonObject<{ mcp?: Record<string, unknown>; mcpServers?: Record<string, unknown> }>(file)
  if (config.mcp?.[name] !== undefined || config.mcpServers?.[name] !== undefined) {
    console.error(`✗ "${name}" already exists in ${file}; edit or remove it there first`)
    return 1
  }
  config.mcp = { ...config.mcp, [name]: entry }
  // Entries can carry env secrets and headers: owner-only.
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o600)
  console.log(`✓ added MCP server "${name}" to ${file}`)
  if ('url' in entry) console.log(`  if it needs a login: hesdor mcp login ${name}`)
  return 0
}

async function list(root: string): Promise<number> {
  const user = await readMcpConfigFiles([userFile()])
  const project = await readMcpConfigFiles(projectFiles(root))
  const names = [...new Set([...Object.keys(user), ...Object.keys(project)])]
  if (names.length === 0) {
    console.log(`no MCP servers (add one with: hesdor mcp add <name> <command...>)`)
    return 0
  }
  const rows = await Promise.all(
    names.map(async (name) => {
      const fromProject = name in project
      const config = (fromProject ? project[name] : user[name])!
      const transport = config.url ? `http ${config.url}` : `stdio ${[config.command, ...(config.args ?? [])].join(' ')}`
      const auth = config.url ? await mcpAuthStatus(name, config.url) : '-'
      // Starting a repository's server runs its code: only the trust gate in a session may do that.
      const status = fromProject ? 'not started (project server, loads after workspace trust)' : await probe(name, config)
      return `${name}  ${fromProject ? 'project' : 'user'}  ${transport}\n    status: ${status}  ·  auth: ${auth}`
    }),
  )
  console.log(rows.join('\n'))
  return 0
}

async function probe(name: string, config: McpServerConfig): Promise<string> {
  try {
    const client = await McpClient.connect(config, undefined, name)
    try {
      return `ok, ${(await client.listTools()).length} tools`
    } finally {
      client.close()
    }
  } catch (err) {
    if (err instanceof McpAuthRequiredError || /authorization required/.test(String(err))) return `needs login (hesdor mcp login ${name})`
    return `failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`
  }
}

async function findUrlServer(root: string, name: string): Promise<McpServerConfig | undefined> {
  const servers = await readMcpConfigFiles([userFile(), ...projectFiles(root)])
  const config = servers[name]
  if (!config) console.error(`✗ no MCP server named "${name}" (see hesdor mcp list)`)
  else if (!config.url) console.error(`✗ "${name}" is a stdio server; only url servers use OAuth`)
  return config?.url ? config : undefined
}

function usage(): number {
  console.error(USAGE)
  return 1
}

/** `hesdor mcp list | add | login | logout`. Writes only the user-scope mcp.json and token store. */
export async function runMcpCommand(argv: string[], root = findGitRoot(process.cwd()) ?? process.cwd()): Promise<number> {
  const [sub = 'list', ...rest] = argv
  try {
    if (sub === 'list' && rest.length === 0) return await list(root)
    if (sub === 'add') return await add(rest)
    if ((sub === 'login' || sub === 'logout') && rest.length === 1) {
      const name = rest[0]!
      if (sub === 'logout') {
        console.log((await logoutMcpServer(name)) ? `✓ removed the saved login for "${name}"` : `no saved login for "${name}"`)
        return 0
      }
      const config = await findUrlServer(root, name)
      if (!config) return 1
      await loginMcpServer(name, config.url!, { oauth: config.oauth })
      console.log(`✓ logged in to "${name}"`)
      return 0
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  return usage()
}
