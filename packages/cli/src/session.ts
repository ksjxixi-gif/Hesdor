import path from 'node:path'
import {
  agentDirs,
  autoPruneCheckpoints,
  cleanSpillDir,
  commandHooksPlugin,
  createDefaultRegistry,
  createHookDispatcher,
  createTaskTool,
  createOracleTool,
  createWebSearchTool,
  hookContextBlock,
  loadAgentsFrom,
  loadHookConfig,
  createReadSkillTool,
  discoverRepo,
  loadCommandsFrom,
  loadPluginsFrom,
  loadSkillsFrom,
  mcpPromptCommands,
  readMcpConfigFiles,
  registerMcpServers,
  skillCommand,
  skillDirs,
  skillsSummary,
} from '@hesdor/agent-core'
import { ToolRegistry } from '@hesdor/agent-core'
import type { AgentDef, CustomCommand, LoadedPlugin, McpElicitHook, McpServerConfig, RegisteredMcpServer, RepoContextInfo, SkillInfo } from '@hesdor/agent-core'
import { configDir, loadConfig } from './config.js'
import { loadManagedSettings } from './config-layers.js'
import { pruneSessions } from './sessions.js'
import { fingerprint, projectCodeFiles, UNTRUSTED_WARNING } from './trust.js'

/** Disk hygiene at session start: old checkpoints, spill files and (when configured) transcripts. Background; never throws. */
export function startHousekeeping(root: string): Promise<unknown> {
  return Promise.allSettled([
    autoPruneCheckpoints(root),
    cleanSpillDir(root),
    loadConfig().then((cfg) => {
      const days = cfg.sessions?.retainDays
      return typeof days === 'number' && days > 0 ? pruneSessions(days) : 0
    }),
  ])
}

export interface Session {
  info: RepoContextInfo
  registry: ToolRegistry
  /** Slash-command templates keyed by name. */
  commands: Map<string, CustomCommand>
  skills: SkillInfo[]
  plugins: LoadedPlugin[]
  mcpServerNames: string[]
  /** Connected MCP servers with their tools, prompts, resources and scope (for a /mcp view). */
  mcpServers: RegisteredMcpServer[]
  /** Config and scope of every MCP server this session tried to start, connected or not (for /mcp login). */
  mcpConfigs: Record<string, { config: McpServerConfig; scope: 'user' | 'project' }>
  /**
   * Answers MCP elicitation (a server asking the user for input). The UI sets a form here;
   * unset (headless) declines and warns.
   */
  onElicit?: McpElicitHook
  /** System-prompt section listing available skills (undefined when none). */
  skillsSection?: string
  /** Markdown subagents run by the `task` tool. */
  agents: AgentDef[]
  /** SessionStart hook output for the system prompt (undefined when none). */
  hookContext?: string
  reload(): Promise<void>
  dispose(): void
}

/** `mcp.json` (`{ "mcp": ... }`) and `.mcp.json` (`{ "mcpServers": ... }`) with `${VAR}` expansion and `disabled`. */
async function readMcpConfigs(paths: string[]): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFiles(paths)
}

export interface CreateSessionOptions {
  root: string
  warn?: (message: string) => void
  /**
   * Decides whether this repo's code-running extensions (.hesdor/plugins,
   * .hesdor/mcp.json) may load. Called on every build, only when such files exist.
   * Omitted means untrusted.
   */
  trust?: (files: string[], fingerprint: string) => Promise<boolean>
  /** roles.oracle after config layers and the profile ('' for none); omitted: read from the user config. */
  oracle?: string
}

/**
 * One CLI session: repository context plus every extension surface —
 * custom commands, skills, plugins and MCP servers — merged into a single
 * tool registry.
 */
export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const warn = opts.warn ?? (() => {})
  void startHousekeeping(opts.root)
  const globalDir = configDir()
  const projectExt = path.join(opts.root, '.hesdor')

  const info = await discoverRepo(opts.root)
  let clients: Awaited<ReturnType<typeof registerMcpServers>> = []
  let onElicit: McpElicitHook | undefined
  let mcpConfigs: Session['mcpConfigs'] = {}
  const state = {
    info,
    registry: createDefaultRegistry(),
    commands: new Map<string, CustomCommand>(),
    skills: [] as SkillInfo[],
    plugins: [] as LoadedPlugin[],
    mcpServerNames: [] as string[],
    skillsSection: undefined as string | undefined,
    agents: [] as AgentDef[],
    hookContext: undefined as string | undefined,
  }
  let started = false

  async function build(): Promise<void> {
    state.info = await discoverRepo(opts.root)
    const managed = await loadManagedSettings()
    state.registry = createDefaultRegistry()
    if (managed.disableWebTools) {
      const registry = new ToolRegistry()
      for (const tool of state.registry.list()) if (tool.name !== 'web_fetch') registry.register(tool)
      state.registry = registry
    }
    const webSearch = managed.disableWebTools ? undefined : createWebSearchTool() // only when a search backend key or SEARXNG_URL is set
    if (webSearch) state.registry.register(webSearch)
    state.commands = new Map()

    // Project entries shadow globals: project dirs come first in the list.
    for (const cmd of await loadCommandsFrom([path.join(projectExt, 'commands'), path.join(globalDir, 'commands')])) {
      state.commands.set(cmd.name, cmd)
    }

    state.skills = await loadSkillsFrom(skillDirs(opts.root, globalDir), warn)
    for (const skill of state.skills) if (!state.commands.has(skill.name)) state.commands.set(skill.name, skillCommand(skill))
    if (state.skills.length > 0) {
      state.registry.register(createReadSkillTool(state.skills))
      state.skillsSection = skillsSummary(state.skills)
    } else {
      state.skillsSection = undefined
    }

    // Text-only extensions above are always safe; plugins and MCP servers run code.
    const projectFiles = await projectCodeFiles(opts.root)
    const trusted =
      projectFiles.length > 0 && opts.trust ? await opts.trust(projectFiles, await fingerprint(opts.root, projectFiles)) : false
    if (projectFiles.length > 0 && !trusted) warn(UNTRUSTED_WARNING)

    const loaded = await loadPluginsFrom([...(trusted ? [path.join(projectExt, 'plugins')] : []), path.join(globalDir, 'plugins')])
    // Command hooks run code too: project hooks.json only when trusted.
    const hookConfig = await loadHookConfig(
      [path.join(globalDir, 'hooks.json'), ...(trusted ? [path.join(projectExt, 'hooks.json')] : [])],
      warn,
    )
    const hooksPlugin = commandHooksPlugin(hookConfig)
    state.plugins = [...loaded.plugins, ...(hooksPlugin ? [hooksPlugin] : [])]
    if (!started) {
      started = true
      const begin = await createHookDispatcher(state.plugins, {
        cwd: opts.root,
        signal: new AbortController().signal,
        emit: (e) => {
          if (e.type === 'hook.notice') warn(`SessionStart hook: ${e.message}`)
        },
      }).run('SessionStart', { source: 'startup' }, 'startup')
      state.hookContext = begin.context.length > 0 ? hookContextBlock(begin.context) : undefined
    }
    for (const warning of loaded.warnings) warn(`plugin ${warning.file}: ${warning.error}`)

    const projectMcp = trusted ? [path.join(opts.root, '.mcp.json'), path.join(projectExt, 'mcp.json')] : []
    // Managed settings can turn MCP off in every scope.
    const servers = managed.disableMcp ? {} : await readMcpConfigs([path.join(globalDir, 'mcp.json'), ...projectMcp])
    state.mcpServerNames = Object.keys(servers)
    // Tool annotations count only for servers from the user's own file that no project file overrides (C8).
    const userNames = Object.keys(await readMcpConfigs([path.join(globalDir, 'mcp.json')]))
    const projectNames = new Set(Object.keys(await readMcpConfigs(projectMcp)))
    mcpConfigs = Object.fromEntries(Object.entries(servers).map(([n, config]) => [n, { config, scope: projectNames.has(n) ? 'project' : 'user' }]))
    clients = await registerMcpServers(state.registry, servers, warn, {
      userScoped: userNames.filter((n) => !projectNames.has(n)),
      onElicit: async (server, request) => {
        if (onElicit) return onElicit(server, request)
        warn(`mcp server "${server}" asked for input ("${request.message}"); declined: no interactive prompt is available here`)
        return { action: 'decline' }
      },
    })
    for (const cmd of mcpPromptCommands(clients)) if (!state.commands.has(cmd.name)) state.commands.set(cmd.name, cmd)

    // roles.oracle (user config only) adds the second-opinion tool; resolveRoles warns when its key is missing.
    const oracle = opts.oracle ?? (await loadConfig().catch(() => undefined))?.roles?.oracle
    if (typeof oracle === 'string' && oracle.trim() !== '') state.registry.register(createOracleTool(oracle))

    // Agents are prompt text (no trust gate); the task tool goes last so it sees every tool's risk.
    state.agents = await loadAgentsFrom(agentDirs(opts.root, globalDir), warn)
    if (state.agents.length > 0) state.registry.register(createTaskTool(state.agents, state.registry))
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
    get mcpServers() {
      return clients
    },
    get mcpConfigs() {
      return mcpConfigs
    },
    get onElicit() {
      return onElicit
    },
    set onElicit(hook: McpElicitHook | undefined) {
      onElicit = hook
    },
    get skillsSection() {
      return state.skillsSection
    },
    get agents() {
      return state.agents
    },
    get hookContext() {
      return state.hookContext
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
