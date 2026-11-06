import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { registerMcpServers, stopAllJobs } from '@hesdor/agent-core'
import type { McpServerConfig, ToolContext } from '@hesdor/agent-core'
import type { AgentMode, ChatMessage, ModelProvider } from '@hesdor/protocol'
import { VERSION } from './args.js'
import type { CliFlags } from './args.js'
import { loadEffectiveConfig, loadManagedSettings, providerBlocked } from './config-layers.js'
import { createSelectedProvider, resolveSelection } from './provider-setup.js'
import { prettySummary, resolveWorkspaceRoot, runTurn, systemPromptFor } from './run.js'
import { createSession } from './session.js'
import type { Session } from './session.js'
import { findSession, newSessionId, saveSession, titleFrom } from './sessions.js'
import { isTrusted } from './trust.js'

/**
 * `hesdor acp`: an Agent Client Protocol (v1) agent over stdio, so editors
 * (Zed, JetBrains, Neovim, Emacs) can drive Hesdor. stdout is the protocol channel.
 */

const MODES: acp.SessionMode[] = [
  { id: 'build', name: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', name: 'Plan', description: 'Read-only implementation planning' },
  { id: 'ask', name: 'Ask', description: 'Read-only questions about the code' },
]

const TOOL_KINDS: Record<string, acp.ToolKind> = {
  list_files: 'read',
  read_file: 'read',
  read_files: 'read',
  read_skill: 'read',
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  job_output: 'read',
  job_list: 'read',
  search_files: 'search',
  find_files: 'search',
  write_file: 'edit',
  apply_patch: 'edit',
  delete_file: 'delete',
  run_command: 'execute',
  job_stop: 'execute',
  explore: 'think',
}

const SETUP_HINT =
  'Run `hesdor setup` in a terminal to save a provider API key, or export the provider key (e.g. OPENAI_API_KEY) before starting the editor.'

interface AcpSession {
  id: string
  root: string
  session: Session
  extraMcp: Awaited<ReturnType<typeof registerMcpServers>>
  provider: ModelProvider
  mode: AgentMode
  history: ChatMessage[]
  createdAt?: number
  /** Warnings from session setup, shown as notices once the client knows the session. */
  notices: string[]
  controller?: AbortController
  state: ToolContext['state']
  /** Commands the user allowed for the whole session. */
  alwaysAllow: Set<string>
  alwaysEdit: boolean
}

/** Test seam: a scripted provider instead of the configured one. */
export interface AcpDeps {
  provider?: ModelProvider
}

function modeOption(mode: AgentMode): acp.SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description ?? null })),
  }
}

function modeState(s: AcpSession): Pick<acp.NewSessionResponse, 'modes' | 'configOptions'> {
  return { modes: { currentModeId: s.mode, availableModes: MODES }, configOptions: [modeOption(s.mode)] }
}

function isMode(value: unknown): value is AgentMode {
  return MODES.some((m) => m.id === value)
}

/** ACP prompt blocks as one user message; embedded files become tagged context. */
export function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'resource_link') return b.uri.startsWith('file:') ? fileURLToPath(b.uri) : b.uri
      if (b.type === 'resource' && 'text' in b.resource) return `<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>`
      return ''
    })
    .filter((t) => t !== '')
    .join('\n')
}

/** ACP stdio MCP servers and HTTP servers in Hesdor's config shape (SSE is not supported). */
function clientMcpServers(servers: acp.McpServer[], warn: (m: string) => void): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const s of servers) {
    if ('type' in s && s.type === 'sse') warn(`MCP server ${s.name}: SSE transport is not supported`)
    else if ('type' in s && s.type === 'http') out[s.name] = { url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) }
    else if ('command' in s) out[s.name] = { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }
  }
  return out
}

export function createAcpAgent(flags: CliFlags, deps: AcpDeps = {}): acp.AgentApp {
  // No markHeadless(): a person types each ACP prompt in their editor, which interactive-only plans allow.
  const sessions = new Map<string, AcpSession>()
  const log = (m: string): void => console.error(`hesdor acp: ${m}`)

  async function provider(): Promise<ModelProvider> {
    if (deps.provider) return deps.provider
    // No workspace yet, so no project layer here; managed settings still apply.
    const eff = await loadEffectiveConfig(flags)
    const sel = await resolveSelection(eff.flags, eff.config)
    const blocked = providerBlocked(eff.managed, sel.providerId)
    if (blocked) throw acp.RequestError.invalidParams(undefined, blocked)
    if (sel.keySource === 'none') throw acp.RequestError.authRequired(undefined, SETUP_HINT)
    return createSelectedProvider(sel)
  }

  async function open(cwd: string, mcpServers: acp.McpServer[], id: string, stored?: { messages: ChatMessage[]; createdAt: number }): Promise<AcpSession> {
    const prov = await provider()
    const ws = resolveWorkspaceRoot(cwd, flags.allowHome)
    if ('error' in ws) throw acp.RequestError.invalidParams(undefined, ws.error)
    const notices: string[] = []
    const warn = (m: string): void => {
      log(m)
      notices.push(m)
    }
    if (ws.warning) warn(ws.warning)
    const root = ws.root
    const session = await createSession({
      root,
      warn,
      // The client cannot answer a trust prompt: load project code only when already pinned or opted in with --trust-workspace.
      trust: async (_files, print) => flags.trustWorkspace === true || (await isTrusted(root, print)),
    })
    // Servers from the editor's own settings, not from the repository, so no trust gate.
    const extraMcp = (await loadManagedSettings()).disableMcp ? [] : await registerMcpServers(session.registry, clientMcpServers(mcpServers, warn), warn)
    const s: AcpSession = {
      id,
      root,
      session,
      extraMcp,
      provider: prov,
      mode: isMode(flags.mode) ? flags.mode : 'build',
      history: stored?.messages ?? [],
      ...(stored ? { createdAt: stored.createdAt } : {}),
      notices,
      state: { activeChild: null, snapshots: [], redo: [] },
      alwaysAllow: new Set(),
      alwaysEdit: false,
    }
    sessions.set(id, s)
    return s
  }

  function close(s: AcpSession): void {
    s.controller?.abort()
    s.session.dispose()
    for (const m of s.extraMcp) m.client.close()
  }

  function get(id: string): AcpSession {
    const s = sessions.get(id)
    if (!s) throw acp.RequestError.sessionNotFound(id)
    return s
  }

  const app = acp.agent({ name: 'hesdor' })
  app
    .onConnect((conn) => {
      void conn.closed.then(() => {
        for (const s of sessions.values()) close(s)
        sessions.clear()
      })
    })
    .onRequest('initialize', ({ params }) => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'hesdor', title: 'Hesdor', version: VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: true },
      },
      // Hesdor reads provider keys from env or `hesdor setup`; these methods point the user there.
      authMethods: [
        { id: 'hesdor-setup', name: 'Configure a provider key', description: SETUP_HINT },
        ...(params.clientCapabilities?.auth?.terminal
          ? [{ type: 'terminal' as const, id: 'hesdor-setup-terminal', name: 'Run hesdor setup', description: 'Choose a provider and save its API key', args: ['setup'] }]
          : []),
      ],
    }))
    .onRequest('authenticate', async () => {
      await provider() // throws auth_required while no key is configured
      return {}
    })
    .onRequest('session/new', async ({ params }) => {
      const s = await open(params.cwd, params.mcpServers, newSessionId())
      return { sessionId: s.id, ...modeState(s) }
    })
    .onRequest('session/load', async ({ params, client }) => {
      const ws = resolveWorkspaceRoot(params.cwd, flags.allowHome)
      if ('error' in ws) throw acp.RequestError.invalidParams(undefined, ws.error)
      let stored
      try {
        stored = await findSession(ws.root, params.sessionId)
      } catch {
        throw acp.RequestError.sessionNotFound(params.sessionId)
      }
      const previous = sessions.get(params.sessionId)
      if (previous) close(previous)
      const s = await open(params.cwd, params.mcpServers, params.sessionId, stored)
      for (const m of s.history) {
        if (m.content.trim() === '' || (m.role !== 'user' && m.role !== 'assistant')) continue
        await client.notify('session/update', {
          sessionId: s.id,
          update: { sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: m.content } },
        })
      }
      return modeState(s)
    })
    .onRequest('session/set_mode', ({ params }) => {
      const s = get(params.sessionId)
      if (!isMode(params.modeId)) throw acp.RequestError.invalidParams(undefined, `unknown mode "${params.modeId}"`)
      s.mode = params.modeId
      return {}
    })
    .onRequest('session/set_config_option', ({ params }) => {
      const s = get(params.sessionId)
      if (params.configId !== 'mode' || !isMode(params.value)) {
        throw acp.RequestError.invalidParams(undefined, `unknown config option ${params.configId}=${String(params.value)}`)
      }
      s.mode = params.value
      return { configOptions: [modeOption(s.mode)] }
    })
    .onNotification('session/cancel', ({ params }) => {
      sessions.get(params.sessionId)?.controller?.abort()
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const s = get(params.sessionId)
      if (s.controller) throw acp.RequestError.invalidRequest(undefined, 'a prompt is already running in this session')
      const controller = new AbortController()
      s.controller = controller

      // Updates go out in order and all before the prompt response.
      let queue = Promise.resolve()
      const send = (update: acp.SessionUpdate): void => {
        queue = queue.then(() => client.notify('session/update', { sessionId: s.id, update })).catch(() => {})
      }
      for (const n of s.notices.splice(0)) send({ sessionUpdate: 'notice', severity: 'warning', title: 'Hesdor', description: n })

      // Tools run one at a time, so approvals and diffs belong to the latest started call.
      let current: string | undefined
      const started = new Set<string>()
      const extra = new Map<string, acp.ToolCallContent[]>()
      const output = new Map<string, string>()
      const addContent = (c: acp.ToolCallContent): void => {
        if (current) extra.set(current, [...(extra.get(current) ?? []), c])
      }

      const ask = async (toolCall: acp.ToolCallUpdate): Promise<'once' | 'always' | false> => {
        await queue
        try {
          const res = await client.request(
            'session/request_permission',
            {
              sessionId: s.id,
              toolCall,
              options: [
                { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
            { cancellationSignal: controller.signal },
          )
          if (res.outcome.outcome !== 'selected') return false
          return res.outcome.optionId === 'allow_once' ? 'once' : res.outcome.optionId === 'allow_always' ? 'always' : false
        } catch {
          return false
        }
      }

      const requestApproval: ToolContext['requestApproval'] = async (req) => {
        const key = req.detail ?? req.title
        if (flags.yes || s.alwaysAllow.has(key)) return true
        const answer = await ask({
          toolCallId: current ?? `approval-${Date.now()}`,
          title: req.title,
          kind: 'execute',
          ...(req.detail ? { content: [{ type: 'content', content: { type: 'text', text: req.detail } }] } : {}),
        })
        if (answer === 'always') s.alwaysAllow.add(key)
        return answer !== false
      }

      const reviewChange: NonNullable<ToolContext['reviewChange']> = async (req) => {
        const abs = path.resolve(s.root, req.path)
        const diff: acp.ToolCallContent = { type: 'diff', path: abs, oldText: req.before, newText: req.after ?? '' }
        addContent(diff)
        if (flags.yes || s.alwaysEdit) return true
        const answer = await ask({
          toolCallId: current ?? `edit-${Date.now()}`,
          title: `${req.after === null ? 'Delete' : 'Edit'} ${req.path}`,
          kind: req.after === null ? 'delete' : 'edit',
          content: [diff],
          locations: [{ path: abs }],
        })
        if (answer === 'always') s.alwaysEdit = true
        return answer !== false
      }

      const emit = (event: Parameters<ToolContext['emit']>[0]): void => {
        switch (event.type) {
          case 'assistant.delta':
            send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } })
            break
          case 'assistant.reasoning':
            if (event.text) send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } })
            break
          case 'tool.started':
            current = event.callId
            started.add(event.callId)
            send({
              sessionUpdate: 'tool_call',
              toolCallId: event.callId,
              title: prettySummary(event.summary),
              kind: TOOL_KINDS[event.name] ?? 'other',
              status: 'in_progress',
            })
            break
          case 'tool.output':
          case 'command.output': {
            const id = event.type === 'tool.output' ? event.callId : current
            const text = event.type === 'tool.output' ? event.chunk : `${event.line}\n`
            // shortcut: keeps the first 20k chars of output per call; stream it with terminal content if editors need more.
            if (id) output.set(id, ((output.get(id) ?? '') + text).slice(0, 20_000))
            break
          }
          case 'tool.completed':
          case 'tool.failed': {
            const failed = event.type === 'tool.failed'
            const out = output.get(event.callId)
            const content: acp.ToolCallContent[] = [
              ...(extra.get(event.callId) ?? []),
              ...(out ? [{ type: 'content' as const, content: { type: 'text' as const, text: out } }] : []),
              ...(failed ? [{ type: 'content' as const, content: { type: 'text' as const, text: event.error } }] : []),
            ]
            const status = failed ? 'failed' : 'completed'
            if (started.has(event.callId)) send({ sessionUpdate: 'tool_call_update', toolCallId: event.callId, status, content })
            else send({ sessionUpdate: 'tool_call', toolCallId: event.callId, title: event.name, kind: TOOL_KINDS[event.name] ?? 'other', status, content })
            if (current === event.callId) current = undefined
            break
          }
          default:
            break
        }
      }

      try {
        const result = await runTurn({
          provider: s.provider,
          registry: s.session.registry,
          plugins: s.session.plugins,
          systemPrompt: systemPromptFor(s.session, s.mode),
          prompt: promptText(params.prompt),
          history: s.history,
          root: s.root,
          mode: s.mode,
          signal: controller.signal,
          emit,
          requestApproval,
          approvalsEnabled: true,
          reviewChange,
          state: s.state,
          ...(flags.maxSteps ? { maxSteps: flags.maxSteps } : {}),
        })
        s.history = result.messages.filter((m) => m.role !== 'system')
        try {
          await saveSession(s.root, { id: s.id, messages: s.history, title: titleFrom(s.history), ...(s.createdAt ? { createdAt: s.createdAt } : {}) })
          s.createdAt ??= Date.now()
        } catch (err) {
          log(`could not save the session: ${err instanceof Error ? err.message : String(err)}`)
        }
        await queue
        if (result.status === 'cancelled' || controller.signal.aborted) return { stopReason: 'cancelled' }
        if (result.status === 'failed') {
          if (result.errorKind === 'auth') throw acp.RequestError.authRequired(undefined, `${result.error ?? 'provider authentication failed'}. ${SETUP_HINT}`)
          throw new acp.RequestError(-32603, result.error ?? 'run failed', { errorKind: result.errorKind ?? 'agent' })
        }
        if (result.status !== 'completed') return { stopReason: 'max_turn_requests' } // step (or budget) limit
        return { stopReason: result.truncated ? 'max_tokens' : 'end_turn' }
      } finally {
        s.controller = undefined
      }
    })
  return app
}

/** Serves ACP on stdin/stdout until the client disconnects. */
export async function runAcp(flags: CliFlags): Promise<number> {
  // stdout carries JSON-RPC only: route stray console output (plugins, libraries) to stderr.
  console.log = console.info = console.debug = console.warn = console.error
  const connection = createAcpAgent(flags).connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
  )
  await connection.closed
  await stopAllJobs() // background dev servers must not outlive the connection
  return 0
}
