import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  createDefaultRegistry,
  createReadSkillTool,
  discoverRepo,
  loadCommandsFrom,
  loadPluginsFrom,
  loadSkillsFrom,
  registerMcpServers,
  skillsSummary,
} from '@hesdor/agent-core'
import type { CustomCommand, LoadedPlugin, RepoContextInfo, SkillInfo, ToolRegistry } from '@hesdor/agent-core'
import { configDir } from './config.js'

export interface Session {
  info: RepoContextInfo
  registry: ToolRegistry
  /** Slash-command templates keyed by name. */
  commands: Map<string, CustomCommand>
  skills: SkillInfo[]
  plugins: LoadedPlugin[]
  mcpServerNames: string[]
  /** System-prompt section listing available skills (undefined when none). */
  skillsSection?: string
  reload(): Promise<void>
  dispose(): void
}

interface McpConfigFile {
  mcp?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
}

async function readMcpConfigs(paths: string[]): Promise<Record<string, { command: string; args?: string[]; env?: Record<string, string> }>> {
  const merged: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {}
  for (const file of paths) {
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as McpConfigFile
      Object.assign(merged, parsed.mcp ?? {})
    } catch {
      // missing or invalid config files are not fatal
    }
  }
  return merged
}

export interface CreateSessionOptions {
  root: string
  warn?: (message: string) => void
}

/**
 * One CLI session: repository context plus every extension surface —
 * custom commands, skills, plugins and MCP servers — merged into a single
 * tool registry.
 */
export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const warn = opts.warn ?? (() => {})
  const globalDir = configDir()
  const projectExt = path.join(opts.root, '.hesdor')

  const info = await discoverRepo(opts.root)
  let clients: Awaited<ReturnType<typeof registerMcpServers>> = []
  const state = {
    info,
    registry: createDefaultRegistry(),
    commands: new Map<string, CustomCommand>(),
    skills: [] as SkillInfo[],
    plugins: [] as LoadedPlugin[],
    mcpServerNames: [] as string[],
    skillsSection: undefined as string | undefined,
  }

  async function build(): Promise<void> {
    state.info = await discoverRepo(opts.root)
    state.registry = createDefaultRegistry()
    state.commands = new Map()

    // Project entries shadow globals: project dirs come first in the list.
    for (const cmd of await loadCommandsFrom([path.join(projectExt, 'commands'), path.join(globalDir, 'commands')])) {
      state.commands.set(cmd.name, cmd)
    }

    state.skills = await loadSkillsFrom([path.join(projectExt, 'skills'), path.join(globalDir, 'skills')])
    if (state.skills.length > 0) {
      state.registry.register(createReadSkillTool(state.skills))
      state.skillsSection = skillsSummary(state.skills)
    } else {
      state.skillsSection = undefined
    }

    const loaded = await loadPluginsFrom([path.join(projectExt, 'plugins'), path.join(globalDir, 'plugins')])
    state.plugins = loaded.plugins
    for (const warning of loaded.warnings) warn(`plugin ${warning.file}: ${warning.error}`)

    const servers = await readMcpConfigs([
      path.join(globalDir, 'mcp.json'),
      path.join(projectExt, 'mcp.json'),
    ])
    state.mcpServerNames = Object.keys(servers)
    clients = await registerMcpServers(state.registry, servers, warn)
  }

  await build()

  return {
    get info() {
      return state.info
    },
    get registry() {
      return state.registry
    },
    get commands() {
      return state.commands
    },
    get skills() {
      return state.skills
    },
    get plugins() {
      return state.plugins
    },
    get mcpServerNames() {
      return state.mcpServerNames
    },
    get skillsSection() {
      return state.skillsSection
    },
    async reload() {
      for (const server of clients) server.client.close()
      clients = []
      await build()
    },
    dispose() {
      for (const server of clients) server.client.close()
      clients = []
    },
  }
}
