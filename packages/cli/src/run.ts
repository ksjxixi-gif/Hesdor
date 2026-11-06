import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt, createHookDispatcher, findGitRoot, hookContextBlock, MAX_ATTEMPTS, runAgentLoop, ToolRegistry } from '@hesdor/agent-core'
import type { LoadedPlugin, RepoContextInfo, ToolContext } from '@hesdor/agent-core'
import type { AgentMode, AgentResult, ChatImage, ChatMessage, ModelProvider, RunEvent, Usage } from '@hesdor/protocol'
import { getModelInfo, requestCostUsd } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import { createSelectedProvider } from './provider-setup.js'
import type { ProviderSelection } from './provider-setup.js'
import { guardApproval, guardReview, taskSummary } from './guardian.js'
import type { GuardContext } from './guardian.js'
import { missingKey, roleSelection } from './roles.js'
import type { Roles } from './roles.js'
import { checkpointTurn, endTurnCheckpoint } from '@hesdor/agent-core'
import { loadPermissions } from './policy-cmd.js'

/** Run wiring shared by the headless commands and the TUI. */

export const TOOL_VERBS: Record<string, string> = {
  list_files: 'Listing',
  read_file: 'Reading',
  read_files: 'Reading',
  search_files: 'Searching',
  write_file: 'Writing',
  apply_patch: 'Updating',
  delete_file: 'Deleting',
  run_command: 'Running',
  find_files: 'Finding',
  job_output: 'Checking job',
  job_stop: 'Stopping job',
  job_list: 'Jobs',
  git_status: 'Status',
  git_diff: 'Diffing',
  git_log: 'History',
  explore: 'Exploring',
  task: 'Delegating',
  oracle: 'Consulting oracle',
}

/** "read_file src/auth.ts" -> "Reading src/auth.ts" */
export function prettySummary(summary: string): string {
  const spaceIdx = summary.indexOf(' ')
  const name = spaceIdx < 0 ? summary : summary.slice(0, spaceIdx)
  const rest = spaceIdx < 0 ? '' : summary.slice(spaceIdx + 1)
  const verb = TOOL_VERBS[name] ?? name
  return rest ? `${verb} ${rest}` : verb
}

export const SUBAGENT_SYSTEM =
  'You are Hesdor\'s exploratory subagent. Investigate the given task using ONLY read tools (list_files, search_files, read_file, read_files, git_status, git_log). ' +
  'Answer the task precisely in your final message and nothing else. Keep the answer under 800 words. If you cannot answer, say so. You have no write or execute permissions.'

export function systemPromptFor(session: { info: RepoContextInfo; skillsSection?: string; hookContext?: string }, mode: AgentMode): string {
  // Skills are static, so they go before the prompt's volatile tail (cache-friendly prefix).
  const base = buildSystemPrompt(session.info, mode, session.skillsSection)
  // hookContext: output of SessionStart hooks.
  return [base, session.hookContext].filter(Boolean).join('\n\n')
}

export type WorkspaceRoot = { root: string; warning?: string } | { error: string }

/**
 * The directory the agent may work in: the enclosing Git repository, or the
 * current directory when there is none. The home directory and filesystem roots
 * are refused unless `allowHome` is set, since every file you own would be in reach.
 */
export function resolveWorkspaceRoot(cwd: string, allowHome = false, home = os.homedir()): WorkspaceRoot {
  const dir = path.resolve(cwd)
  const gitRoot = findGitRoot(dir)
  const root = gitRoot ?? dir
  if (!allowHome) {
    if (gitRoot && samePath(gitRoot, home)) {
      return {
        error: `the Git repository at ${gitRoot} is your home directory (a dotfiles repo?). cd into a project with its own repository, or pass --allow-home.`,
      }
    }
    if (samePath(root, home) || path.parse(root).root === root) {
      return {
        error: `refusing to use ${root} as the workspace: it is your home directory or a filesystem root. cd into a project, or pass --allow-home.`,
      }
    }
  }
  return gitRoot
    ? { root }
    : { root, warning: `not inside a Git repository: using ${root} as the workspace (git tools are unavailable)` }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a?.ready || !b?.ready) return a?.ready ? a : b?.ready ? b : (a ?? b)
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0))
  const out: Usage = { ready: true }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const value = sum(a[key], b[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

export interface TurnOptions {
  provider: ModelProvider
  registry: ToolRegistry
  plugins: LoadedPlugin[]
  systemPrompt: string
  prompt: string
  history?: ChatMessage[]
  root: string
  mode: AgentMode
  signal: AbortSignal
  emit: (event: RunEvent) => void
  /** Events from explore subagents (their own steps and tool calls); dropped when omitted. */
  emitSubagent?: (event: RunEvent) => void
  requestApproval: ToolContext['requestApproval']
  approvalsEnabled: boolean
  reviewChange?: ToolContext['reviewChange']
  state: ToolContext['state']
  maxSteps?: number
  /** Provider for a task agent's `model:` (see agentProviderFor). Omitted: agents use the session model. */
  providerFor?: (model: string) => Promise<ModelProvider>
  /** Stop before the next model request once spentUsd plus this turn's cost reaches it (USD). */
  budgetUsd?: number
  /** Cost of earlier turns in the same session, counted against budgetUsd. */
  spentUsd?: number
  /** Session id recorded in this turn's checkpoint (listCheckpoints filters by it). */
  sessionId?: string
  /** Images attached to the prompt (see images.ts). */
  images?: ChatImage[]
  /** Model roles from resolveRoles: small (compaction), subagent, fallback chain, guardian. */
  roles?: Partial<Pick<Roles, 'small' | 'subagent' | 'fallback' | 'guardian'>>
}

/** Errors that move the rest of a turn to the next roles.fallback model. */
const FALLBACK_KINDS = new Set(['overloaded', 'rate_limit', 'quota_exhausted', 'network'])

export interface TurnResult extends Omit<AgentResult, 'status'> {
  /** budget_exceeded: stopped because budgetUsd was reached. */
  status: AgentResult['status'] | 'budget_exceeded'
  /** USD cost of this turn including subagents; undefined when no price is known. */
  costUsd?: number
  /** Tokens in the context after the last main-loop request (its input plus output). */
  contextTokens?: number
  /** Model calls made by the main loop. */
  steps: number
  /** The final assistant text of this turn ('' when there is none). */
  text: string
  /** Provider error class (auth, rate_limit, network, ...) when the provider failed the run. */
  errorKind?: string
}

/** One agent turn with the explore subagent wired in; usage includes the subagent's tokens. */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  let lastProviderError: unknown
  const raw = opts.provider
  const info = getModelInfo(raw.name, raw.model)
  let costUsd: number | undefined
  let contextTokens: number | undefined
  let overBudget = false
  // Prices every request (main loop, roles and subagents) at its own model's price, and refuses the next one once the budget is spent.
  const priced = (p: ModelProvider): ModelProvider => {
    const pInfo = getModelInfo(p.name, p.model)
    return {
      name: p.name,
      model: p.model,
      async *stream(messages, tools, signal) {
        if (opts.budgetUsd !== undefined && (opts.spentUsd ?? 0) + (costUsd ?? 0) >= opts.budgetUsd) {
          overBudget = true
          // The loop ends a run on AbortError the same way it ends a cancel, with a valid history.
          throw Object.assign(new Error('cost budget reached'), { name: 'AbortError' })
        }
        for await (const chunk of p.stream(messages, tools, signal)) {
          if (chunk.type === 'finish' && chunk.usage?.ready) {
            const cost = requestCostUsd(chunk.usage, pInfo)
            if (cost !== undefined) costUsd = (costUsd ?? 0) + cost
          }
          yield chunk
        }
      },
    }
  }
  // The main model, then roles.fallback in order; a switch lasts for the rest of this turn.
  const chain = [raw, ...(opts.roles?.fallback ?? [])].map(priced)
  let active = 0
  let failures = 0
  const inner: ModelProvider = {
    name: raw.name,
    model: raw.model,
    async *stream(messages, tools, signal) {
      for (;;) {
        const p = chain[active]!
        let yielded = false
        try {
          for await (const chunk of p.stream(messages, tools, signal)) {
            yielded = true
            yield chunk
          }
          failures = 0
          return
        } catch (err) {
          const e = err as { kind?: unknown; retryable?: unknown } | undefined
          if (yielded || signal.aborted || active + 1 >= chain.length || !FALLBACK_KINDS.has(String(e?.kind))) throw err
          // Retryable errors switch only once the loop's own retries are used up.
          if (e?.retryable === true && ++failures < MAX_ATTEMPTS) throw err
          failures = 0
          active++
          const to = chain[active]!
          opts.emit({ type: 'provider.fallback', from: `${p.name}/${p.model}`, to: `${to.name}/${to.model}`, reason: String(e?.kind) })
        }
      }
    },
  }
  // Remember the provider's own error so its class survives the loop, which keeps only the message.
  const provider: ModelProvider = {
    name: inner.name,
    model: inner.model,
    async *stream(messages, tools, signal) {
      try {
        for await (const chunk of inner.stream(messages, tools, signal)) {
          if (chunk.type === 'finish' && chunk.usage?.inputTokens !== undefined) {
            contextTokens = chunk.usage.inputTokens + (chunk.usage.outputTokens ?? 0)
          }
          yield chunk
        }
      } catch (err) {
        lastProviderError = err
        throw err
      }
    },
  }

  const submit = await createHookDispatcher(opts.plugins, { cwd: opts.root, signal: opts.signal, mode: opts.mode, emit: opts.emit }).run(
    'UserPromptSubmit',
    { prompt: opts.prompt },
  )
  if (submit.block !== undefined) {
    const error = `prompt blocked by a hook: ${submit.block}`
    opts.emit({ type: 'run.failed', error })
    return { status: 'failed', error, messages: [{ role: 'system', content: opts.systemPrompt }, ...(opts.history ?? [])], steps: 0, text: '' }
  }
  const prompt = submit.context.length > 0 ? `${opts.prompt}\n\n${hookContextBlock(submit.context)}` : opts.prompt
  const permissions = await loadPermissions(opts.root)
  await checkpointTurn(opts.root, opts.sessionId ?? '', opts.history?.length ?? 0, { prompt: opts.prompt, emit: opts.emit })

  let steps = 0
  // Taken from events, not result.messages: compaction can replace the history the turn started from.
  let lastText = ''
  let subUsage: Usage | undefined
  // Guardian: reviews approvals no rule settles before the human is asked (fail closed, see guardian.ts).
  const guardian = opts.roles?.guardian
  const guard: GuardContext | undefined = guardian && {
    task: taskSummary(opts.prompt, opts.history),
    signal: opts.signal,
    emit: opts.emit,
    provider: priced(guardian.provider),
    onUsage: (usage) => (subUsage = addUsage(subUsage, usage)),
  }
  const requestApproval = guardian && guard ? guardApproval(guardian, opts.requestApproval, guard) : opts.requestApproval
  const reviewChange = guardian && guard && opts.reviewChange ? guardReview(guardian, opts.reviewChange, guard) : opts.reviewChange
  const small = opts.roles?.small && priced(opts.roles.small)
  const subRole = opts.roles?.subagent && priced(opts.roles.subagent)
  const ctx: ToolContext = {
    root: opts.root,
    mode: opts.mode,
    model: provider.model,
    signal: opts.signal,
    emit: (event) => {
      if (event.type === 'assistant.message') {
        steps++
        if (event.content.trim() !== '') lastText = event.content
      }
      opts.emit(event)
    },
    requestApproval,
    approvalsEnabled: opts.approvalsEnabled,
    permissions,
    // Only models the catalog marks as vision models get images from read_file.
    imageInput: info?.imageInput === true,
    ...(reviewChange ? { reviewChange } : {}),
    state: opts.state,
    // One runner for the read-only explore agent and task agents. Plugins and hooks see (and can deny) their
    // calls; the sub ctx has no `subagent`, so nesting stops at depth 1.
    subagent: async (task, subMaxSteps = 5, agent) => {
      let registry = opts.registry.readOnly()
      if (agent) {
        registry = new ToolRegistry()
        for (const tool of opts.registry.list()) if (agent.tools.includes(tool.name)) registry.register(tool)
      }
      // An agent's own `model:` (and the oracle's) wins, then roles.subagent, then the turn's model.
      const subProvider = agent?.model && opts.providerFor ? priced(await opts.providerFor(agent.model)) : (subRole ?? inner)
      const sub = await runAgentLoop({
        provider: subProvider,
        registry,
        plugins: opts.plugins,
        agent: agent?.name ?? 'explore',
        ctx: {
          root: opts.root,
          // Task agents act under the turn's mode and approvals; explore is always read-only.
          mode: agent ? opts.mode : 'ask',
          model: subProvider.model,
          signal: opts.signal,
          emit: opts.emitSubagent ?? (() => {}),
          requestApproval: agent ? requestApproval : () => Promise.resolve(false),
          approvalsEnabled: agent ? opts.approvalsEnabled : false,
          permissions,
          ...(agent && reviewChange ? { reviewChange } : {}),
          // Own jobs and read stamps (it must not drain the main agent's job output); a task agent
          // shares the undo stack so /undo reverts its edits.
          state: { activeChild: null, snapshots: agent ? opts.state.snapshots : [], redo: agent ? opts.state.redo : [] },
        },
        systemPrompt: agent
          ? `${agent.systemPrompt}\n\nWorkspace root: ${opts.root}. Your final message is returned to the main agent as your answer.`
          : SUBAGENT_SYSTEM,
        userPrompt: task,
        history: [],
        maxSteps: Math.min(subMaxSteps, agent ? 50 : 10),
      })
      subUsage = addUsage(subUsage, sub.usage)
      const lastText = lastAssistantText(sub.messages)
      return lastText ? lastText.slice(0, 6000) : (sub.error ?? 'subagent produced no answer')
    },
  }

  const result = await runAgentLoop({
    provider,
    registry: opts.registry,
    ctx,
    systemPrompt: opts.systemPrompt,
    userPrompt: prompt,
    ...(opts.history && opts.history.length > 0 ? { history: opts.history } : {}),
    plugins: opts.plugins,
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    ...(info?.contextWindow ? { contextWindow: info.contextWindow } : {}),
    ...(opts.images?.length ? { images: opts.images } : {}),
    ...(small ? { compactionProvider: small } : {}),
  })
  await endTurnCheckpoint(opts.root, opts.sessionId ?? '', opts.history?.length ?? 0)

  const providerErr = lastProviderError as { kind?: unknown; message?: unknown } | undefined
  const errorKind =
    result.status === 'failed' && providerErr && providerErr.message === result.error && typeof providerErr.kind === 'string'
      ? providerErr.kind
      : undefined
  const usage = addUsage(result.usage, subUsage)
  return {
    ...result,
    status: overBudget && result.status === 'cancelled' && !opts.signal.aborted ? 'budget_exceeded' : result.status,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    steps,
    text: lastText,
    ...(errorKind ? { errorKind } : {}),
  }
}

function lastAssistantText(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim() !== '')?.content ?? ''
}

/**
 * Resolves a task agent's (or the oracle's) `model:` with that provider's own key; see roleSelection.
 * A provider without a key fails the tool call with a one-line reason instead of sending no key.
 */
export function agentProviderFor(flags: CliFlags, cfg: HesdorConfig, current: ProviderSelection): (model: string) => Promise<ModelProvider> {
  return async (spec) => {
    const sel = await roleSelection(spec, flags, cfg, current)
    const missing = missingKey(sel)
    if (missing) throw new Error(`${spec}: ${missing}`)
    return createSelectedProvider(sel)
  }
}
