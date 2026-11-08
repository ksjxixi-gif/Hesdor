import { createWorktree, findGitRoot, removeWorktreeIfUnchanged, renderTodos, stopAllJobs } from '@hesdor/agent-core'
import type { Worktree } from '@hesdor/agent-core'
import { CHATGPT_USAGE_URL, getModelInfo } from '@hesdor/providers'
import { writeFile } from 'node:fs/promises'
import type { AgentMode, ChatImage, ChatMessage, ModelProvider, RunEvent, Usage } from '@hesdor/protocol'
import { promptImages } from './images.js'
import type { CliFlags } from './args.js'
import { loadEffectiveConfig, projectConfigTrusted, providerBlocked } from './config-layers.js'
import { runGoal } from './goal.js'
import type { GoalResult } from './goal.js'
import { createSelectedProvider, headlessRefusal, markHeadless, resolveSelection } from './provider-setup.js'
import { agentProviderFor, prettySummary, resolveWorkspaceRoot, runTurn, systemPromptFor } from './run.js'
import type { Escalation, TurnResult } from './run.js'
import { resolveRoles } from './roles.js'
import type { Roles } from './roles.js'
import { createSession } from './session.js'
import { findSession, newSessionId, saveSession, titleFrom } from './sessions.js'
import type { StoredSession } from './sessions.js'
import { isTrusted } from './trust.js'

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

/** Final object of `--output-format json` and last line of `stream-json`. */
export interface HeadlessResult {
  type: 'result'
  status: 'completed' | 'max_steps' | 'budget_exceeded' | 'cancelled' | 'failed'
  result: string
  session_id: string | null
  usage: Usage | null
  /** USD cost of the run including subagents; null when no price is known. */
  cost_usd: number | null
  steps: number
  error: string | null
  error_category: string | null
  /** Provider id of the main model at the start of the run. */
  provider?: string
  /** `provider/model` of the main model at the start of the run (escalations can switch it later). */
  model?: string
  /** Active model profile (--profile, HESDOR_PROFILE or config), null when none. */
  profile?: string | null
  /** Switches to a stronger model because the run was stuck (economy and balanced profiles, roles.escalation). */
  escalations?: Escalation[]
  /** --goal only: how the goal loop ended (met, impossible, max_turns, or the stopping turn's status). */
  goal?: { status: GoalResult['status']; reason: string; turns: number }
}

/** Test seams: a scripted provider and a working directory. */
export interface HeadlessDeps {
  provider?: ModelProvider
  cwd?: string
  /** Process uid (root check); defaults to process.getuid(). */
  uid?: number
  /**
   * Replaces the final output (and the streamed answer text) of every outcome, early failures included;
   * returns the exit code. Used by `hesdor review`.
   */
  report?: (outcome: HeadlessOutcome, code: number, sessionId: string | null) => Promise<number>
}

export type HeadlessOutcome = Pick<TurnResult, 'status' | 'text' | 'error' | 'errorKind' | 'usage' | 'costUsd' | 'steps'>

/**
 * Non-interactive execution of one prompt (run / ask / plan).
 * text: assistant text on stdout, activity on stderr so pipes stay clean.
 * json / stream-json: machine-readable stdout (see HeadlessResult).
 * Exit codes: 0 completed, 1 failed, 2 max steps, 3 provider error, 4 cost budget reached,
 * 5 review findings at or above --severity (hesdor review), 6 --goal impossible or out of turns, 130 cancelled.
 */
export async function runHeadless(mode: AgentMode, prompt: string, flags: CliFlags, deps: HeadlessDeps = {}): Promise<number> {
  const format = flags.outputFormat ?? 'text'
  markHeadless()
  const line = (obj: unknown): void => {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  /** Ends a run that never reached the agent loop. */
  const fail = (code: number, error: string, category: string): number | Promise<number> => {
    if (deps.report) return deps.report({ status: 'failed', text: '', error, errorKind: category, steps: 0 }, code, null)
    if (format === 'text') console.error(`✗ ${error}`)
    else {
      line({
        type: 'result',
        status: 'failed',
        result: '',
        session_id: null,
        usage: null,
        cost_usd: null,
        steps: 0,
        error,
        error_category: category,
      } satisfies HeadlessResult)
    }
    return code
  }

  if (prompt === '-' || (prompt === '' && !process.stdin.isTTY)) prompt = (await readStdin()).trim()
  if (prompt === '') return fail(1, `"hesdor ${mode === 'build' ? 'run' : mode}" needs a prompt (argument, "-" or piped stdin)`, 'usage')
  // As root, one prompt-injected command can change the whole machine (CI containers often run as root).
  if ((deps.uid ?? process.getuid?.()) === 0 && !flags.allowRoot) {
    return fail(1, 'refusing to run headless as root: use an unprivileged user, or pass --allow-root (e.g. in a throwaway container)', 'usage')
  }

  const ws = resolveWorkspaceRoot(deps.cwd ?? process.cwd(), flags.allowHome)
  if ('error' in ws) return fail(1, ws.error, 'workspace')
  let root = ws.root
  const warn = (m: string): void => console.error(`${DIM}• ${m}${RESET}`)
  if (ws.warning) warn(ws.warning)
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    warn('running on pull_request_target: this workflow has secrets and write access while the pull request is untrusted; use pull_request')
  }

  let resumed: StoredSession | undefined
  if (flags.continue || flags.resume !== undefined) {
    try {
      resumed = await findSession(root, flags.resume)
    } catch (err) {
      return fail(1, err instanceof Error ? err.message : String(err), 'session')
    }
  }

  let provider: ModelProvider
  let providerId: string
  let providerFor: ((model: string) => Promise<ModelProvider>) | undefined
  let roles: Roles | undefined
  let profile: string | undefined
  let oracle: string | undefined
  if (deps.provider) {
    provider = deps.provider
    providerId = deps.provider.name
  } else {
    try {
      // Layers: managed > flags > env > trusted project .hesdor/config.json > user config.json (config-layers.ts).
      const eff = await loadEffectiveConfig(flags, { root, trusted: await projectConfigTrusted(root, flags.trustWorkspace) })
      for (const w of eff.warnings) warn(w)
      const cfg = eff.config
      flags = eff.flags
      const sel = await resolveSelection(flags, cfg)
      const blocked = providerBlocked(eff.managed, sel.providerId)
      if (blocked) return fail(1, blocked, 'config')
      const refusal = headlessRefusal(sel.providerId)
      if (refusal) return fail(1, refusal, 'config')
      if (sel.keySource === 'none') {
        return fail(
          3,
          `no API credential found — run \`hesdor setup\` to save a key${sel.envKey ? ` or export ${sel.envKey}` : ''}`,
          'auth',
        )
      }
      provider = createSelectedProvider(sel)
      providerId = sel.providerId
      // OpenAI's UI guidelines: say when requests use the user's ChatGPT plan.
      if (sel.providerId === 'chatgpt' && format === 'text') warn(`using your ChatGPT plan (manage usage: ${CHATGPT_USAGE_URL})`)
      providerFor = agentProviderFor(flags, cfg, sel) // subagents with their own `model:` use that provider's key
      roles = await resolveRoles(flags, cfg, sel, { headless: true })
      profile = cfg.profile
      oracle = cfg.roles?.oracle ?? ''
      for (const w of roles.warnings) warn(w)
    } catch (err) {
      return fail(1, err instanceof Error ? err.message : String(err), 'config')
    }
  }
  // An unenforceable money limit must not run silently.
  if (flags.maxBudgetUsd !== undefined && !getModelInfo(providerId, provider.model)?.cost) {
    return fail(1, `--max-budget-usd: no price is known for ${providerId}/${provider.model}`, 'usage')
  }
  let images: ChatImage[]
  try {
    images = await promptImages(flags.images ?? [], prompt, deps.cwd ?? process.cwd(), root)
  } catch (err) {
    return fail(1, err instanceof Error ? err.message : String(err), 'usage')
  }
  if (images.length > 0 && getModelInfo(providerId, provider.model)?.imageInput === false) {
    warn(`${providerId}/${provider.model} does not accept images; the model only sees a note that they were omitted`)
  }

  let worktree: Worktree | undefined
  if (flags.worktree !== undefined) {
    if (!findGitRoot(root)) return fail(1, '--worktree needs a Git repository', 'workspace')
    const name = flags.worktree || `${mode === 'build' ? 'run' : mode}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`
    try {
      worktree = await createWorktree(root, name)
    } catch (err) {
      return fail(1, `could not create the worktree: ${err instanceof Error ? err.message : String(err)}`, 'workspace')
    }
    warn(`working in ${worktree.path} on branch ${worktree.branch}`)
    root = worktree.path
  }

  const warnings: string[] = []
  // Created after every early return above, so its MCP children are always disposed below.
  const session = await createSession({
    root,
    warn: (m) => {
      warnings.push(m)
      warn(m)
    },
    // Headless never prompts: only a pinned approval or an explicit flag loads project code.
    trust: async (_files, print) => flags.trustWorkspace === true || (await isTrusted(root, print)),
    ...(oracle !== undefined ? { oracle } : {}),
  })
  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.on('SIGINT', onSigint)

  let sessionId = resumed?.id ?? newSessionId()
  const history: ChatMessage[] = resumed?.messages ?? []

  let printedOutputLines = 0
  const printText = (event: RunEvent): void => {
    if (flags.debug) console.error(`${DIM}[debug] ${JSON.stringify(event)}${RESET}`)
    switch (event.type) {
      case 'assistant.delta':
        if (!deps.report) process.stdout.write(event.text)
        break
      case 'tool.started':
        console.error(`${DIM}${YELLOW}●${RESET}${DIM} ${prettySummary(event.summary)}${RESET}`)
        break
      case 'tool.failed':
        console.error(`${RED}  ✗ ${event.name}: ${event.error}${RESET}`)
        break
      case 'command.output':
        if (printedOutputLines < 100) {
          printedOutputLines++
          console.error(`${DIM}  │ ${event.line}${RESET}`)
        } else if (printedOutputLines === 100) {
          printedOutputLines++
          console.error(`${DIM}  │ … (further output hidden)${RESET}`)
        }
        break
      case 'run.failed':
        console.error(`${RED}✗ run failed: ${event.error}${RESET}`)
        break
      case 'provider.retry':
        console.error(`${DIM}  retrying in ${Math.ceil(event.delayMs / 1000)}s (${event.reason}, attempt ${event.attempt + 1}/${event.maxAttempts})${RESET}`)
        break
      case 'run.completed':
        if (event.truncated) console.error(`${YELLOW}• the answer was cut off by the max output token limit${RESET}`)
        break
      case 'checkpoint.skipped':
      case 'hook.notice':
        console.error(`${YELLOW}• ${event.type === 'checkpoint.skipped' ? `checkpoints off: ${event.reason}` : event.message}${RESET}`)
        break
      case 'context.compacted':
        console.error(`${DIM}• context compacted (${event.phase}): ~${event.beforeTokens} → ~${event.afterTokens} tokens${RESET}`)
        break
      case 'todo.updated':
        console.error(`${DIM}• plan\n${renderTodos(event.todos)}${RESET}`)
        break
      case 'provider.fallback':
        console.error(`${YELLOW}• ${event.from} failed (${event.reason}); continuing with ${event.to}${RESET}`)
        break
      case 'provider.escalated':
        console.error(`${DIM}• stuck (${event.reason.replace('_', ' ')}): escalating from ${event.from} to ${event.to}${RESET}`)
        break
      case 'approval.guardian':
        console.error(`${event.decision === 'allow' ? DIM : YELLOW}• guardian ${event.decision}: ${event.action} (${event.reason})${RESET}`)
        break
      case 'goal.evaluated':
        console.error(`${event.verdict === 'met' ? DIM : YELLOW}• goal check ${event.turn}: ${event.verdict} (${event.reason})${RESET}`)
        break
      default:
        break
    }
  }
  const emit = (event: RunEvent): void => {
    if (format === 'text') printText(event)
    else if (format === 'stream-json') line(event)
  }
  const emitSubagent = (event: RunEvent): void => {
    if (format === 'stream-json') line({ type: 'subagent', event })
    else if (format === 'text') {
      if (flags.debug) console.error(`${DIM}[debug:subagent] ${JSON.stringify(event)}${RESET}`)
      if (event.type === 'tool.started') console.error(`${DIM}    ↳ ${prettySummary(event.summary)}${RESET}`)
      else if (event.type === 'tool.failed') console.error(`${DIM}    ↳ ✗ ${event.name}: ${event.error}${RESET}`)
    }
  }

  try {
    if (format === 'stream-json') {
      line({
        type: 'init',
        session_id: sessionId,
        ...(resumed ? { resumed: true } : {}),
        provider: providerId,
        model: provider.model,
        ...(profile ? { profile } : {}),
        mode,
        root,
        tools: session.registry.list().map((t) => t.name),
        plugins: session.plugins.map((p) => p.name),
        mcp_servers: session.mcpServerNames,
        warnings,
      })
    }

    // One turn; --goal runs several, each continuing the last one's history and counting against the same budget.
    let turnHistory = history
    let turns = 0
    let spentUsd = 0
    let compacted = false
    const escalations: Escalation[] = []
    const turn = async (turnPrompt: string, turnEmit: (event: RunEvent) => void): Promise<TurnResult> => {
      if (turns++ > 0 && format === 'text' && !deps.report) process.stdout.write('\n')
      const r = await runTurn({
        trustWorkspace: flags.trustWorkspace,
        provider,
        registry: session.registry,
        plugins: session.plugins,
        systemPrompt: systemPromptFor(session, mode),
        prompt: turnPrompt,
        history: turnHistory,
        root,
        mode,
        signal: controller.signal,
        emit: turnEmit,
        emitSubagent,
        // Headless runs auto-approve (--yes) or are denied before this is called. With --guardian, unclassified
        // commands run as they would without approvals, and the rest is refused unless the guardian allows it.
        requestApproval: (req) => Promise.resolve(flags.yes || (roles?.guardian !== undefined && req.source === 'default')),
        approvalsEnabled: flags.yes || roles?.guardian !== undefined,
        ...(roles ? { roles } : {}),
        state: { activeChild: null, snapshots: [], redo: [] },
        sessionId,
        ...(images.length > 0 && turns === 1 ? { images } : {}),
        ...(providerFor ? { providerFor } : {}),
        ...(flags.maxSteps ? { maxSteps: flags.maxSteps } : {}),
        ...(flags.maxBudgetUsd !== undefined ? { budgetUsd: flags.maxBudgetUsd, spentUsd } : {}),
      })
      turnHistory = r.messages.filter((m) => m.role !== 'system')
      spentUsd += r.costUsd ?? 0
      compacted ||= r.compacted === true
      escalations.push(...(r.escalations ?? []))
      return r
    }
    const goal =
      flags.goal !== undefined
        ? await runGoal({
            condition: flags.goal,
            prompt,
            turn,
            evaluator: roles?.small ?? provider,
            emit,
            signal: controller.signal,
            onEvaluatorCost: (usd) => (spentUsd += usd),
            ...(flags.maxGoalTurns ? { maxTurns: flags.maxGoalTurns } : {}),
          })
        : undefined
    const single = goal ? undefined : await turn(prompt, emit)
    // Goal runs report the last turn's answer with usage, cost and steps summed over every turn.
    const result: TurnResult = goal
      ? { ...goal.last, ...(goal.usage ? { usage: goal.usage } : {}), ...(goal.costUsd !== undefined ? { costUsd: goal.costUsd } : {}), steps: goal.steps }
      : single!

    const messages = result.messages.filter((m) => m.role !== 'system')
    // A compacted history no longer extends the old transcript: keep that one and link a new session to it.
    const parentId = compacted ? sessionId : undefined
    if (parentId) sessionId = newSessionId()
    try {
      await saveSession(root, {
        id: sessionId,
        messages,
        title: titleFrom(messages),
        ...(parentId ? { parentId } : resumed ? { createdAt: resumed.createdAt } : {}),
      })
    } catch (err) {
      warn(`could not save the session: ${err instanceof Error ? err.message : String(err)}`)
    }
    const status = goal?.status ?? result.status
    let code =
      status === 'completed' || status === 'met'
        ? 0
        : status === 'impossible' || status === 'max_turns'
          ? 6
          : status === 'max_steps'
            ? 2
            : status === 'budget_exceeded'
              ? 4
              : status === 'cancelled'
                ? 130
                : result.errorKind
                  ? 3
                  : 1
    if (deps.report) return await deps.report(result, code, sessionId)
    if (flags.outputFile && result.text !== '') {
      try {
        await writeFile(flags.outputFile, result.text, 'utf8')
      } catch (err) {
        console.error(`${RED}✗ could not write ${flags.outputFile}: ${err instanceof Error ? err.message : String(err)}${RESET}`)
        if (code === 0) code = 1
      }
    }
    if (format === 'text') {
      process.stdout.write('\n')
      if (result.status === 'cancelled') console.error(`${YELLOW}• run cancelled${RESET}`)
      if (result.status === 'max_steps') console.error(`${YELLOW}• stopped: tool-call step budget reached (raise with --max-steps)${RESET}`)
      if (result.status === 'budget_exceeded') console.error(`${YELLOW}• stopped: cost budget of ${flags.maxBudgetUsd} reached (raise with --max-budget-usd)${RESET}`)
      if (goal) console.error(`${goal.status === 'met' ? DIM : YELLOW}• goal ${goal.status.replace('_', ' ')} after ${goal.turns} turn${goal.turns === 1 ? '' : 's'}: ${goal.reason}${RESET}`)
    } else {
      line({
        type: 'result',
        status: result.status,
        result: result.text,
        session_id: sessionId,
        usage: result.usage ?? null,
        cost_usd: result.costUsd ?? null,
        steps: result.steps,
        error: result.error ?? (goal?.status === 'failed' ? goal.reason : null),
        error_category: result.errorKind ?? (status === 'failed' ? 'agent' : null),
        provider: providerId,
        model: `${providerId}/${provider.model}`,
        profile: profile ?? null,
        escalations,
        ...(goal ? { goal: { status: goal.status, reason: goal.reason, turns: goal.turns } } : {}),
      } satisfies HeadlessResult)
    }
    return code
  } finally {
    process.removeListener('SIGINT', onSigint)
    session.dispose()
    await stopAllJobs() // background dev servers must not outlive the run
    if (worktree) await finishWorktree(ws.root, worktree)
  }
}

/** Removes an unchanged worktree; otherwise says where the work is. Never deletes changes. */
async function finishWorktree(repoRoot: string, wt: Worktree): Promise<void> {
  try {
    if (await removeWorktreeIfUnchanged(repoRoot, wt)) {
      console.error(`${DIM}• no changes in the worktree: removed ${wt.path} and branch ${wt.branch}${RESET}`)
      return
    }
  } catch {
    // keep it: a failed check must never lose work
  }
  console.error(
    `${YELLOW}• worktree kept: ${wt.path} (branch ${wt.branch})${RESET}\n` +
      `  review: git -C "${wt.path}" status   /   git -C "${wt.path}" diff ${wt.base.slice(0, 12)}\n` +
      `  merge:  commit there, then git merge ${wt.branch}\n` +
      `  remove: git worktree remove "${wt.path}" && git branch -D ${wt.branch}`,
  )
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}
