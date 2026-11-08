import type {
  AgentResult,
  ChatImage,
  ChatMessage,
  ModelProvider,
  RunEvent,
  ToolCallRequest,
  Usage,
} from '@hesdor/protocol'
import { COMPACT_THRESHOLD, DEFAULT_CONTEXT_WINDOW, estimateTokens, pruneToolResults, summarizeHistory } from './compact.js'
import type { ToolContext } from './context.js'
import { createHookDispatcher, hookContextBlock } from './hooks.js'
import type { HookDispatcher } from './hooks.js'
import type { LoadedPlugin } from './plugins.js'
import { assertRiskAllowed, PermissionDeniedError } from './policy.js'
import type { ToolRegistry } from './registry.js'
import { capOutput, formatToolResult, selfLimited } from './tool-output.js'
import { checksFor } from './checks.js'

export const DEFAULT_MAX_STEPS = 100
export const MAX_ATTEMPTS = 4

const TRUNCATED_CALL =
  'ERROR: your response hit the max output token limit, so the arguments of this tool call were cut off and it was NOT run. ' +
  'Split the work into smaller steps: write a smaller file with write_file and add the rest with apply_patch, or edit existing files with apply_patch instead of rewriting them.'

const budgetNotice = (used: number, max: number): string =>
  `\n\n[notice: ${used} of ${max} tool steps used. Finish the most important part and wrap up soon.]`
const BUDGET_DONE =
  '\n\n[the tool step budget is used up, so no more tools will run. Reply now WITHOUT calling tools: summarize what you did, what is still left to do, and anything the user should check.]'

const EDIT_TOOLS = new Set(['write_file', 'apply_patch', 'delete_file'])
/** run_command calls that count as running tests for the run_tests nudge. */
const TEST_COMMAND = /\b(test|tests|vitest|jest|mocha|pytest)\b/
const TEST_NUDGE = '\n\n[hint: files changed. When the change is complete, run run_tests to verify it.]'
/** Polling the same job with the same arguments is normal, not a loop. */
const POLLING_TOOLS = new Set(['job_output', 'job_list'])

export interface AgentLoopOptions {
  provider: ModelProvider
  registry: ToolRegistry
  ctx: ToolContext
  systemPrompt: string
  userPrompt: string
  /** Prior conversation (without the new user prompt). */
  history?: ChatMessage[]
  maxSteps?: number
  /** Plugins receive lifecycle hooks around every tool execution. */
  plugins?: LoadedPlugin[]
  /** Set when this loop is a subagent: hooks see `agent_type` and SubagentStop instead of Stop. */
  agent?: string
  /** The model's context window in tokens; history is compacted above 80% of it. Default 128000. */
  contextWindow?: number
  /** Images attached to the user prompt (`--image`, pasted or `@`-mentioned files). */
  images?: ChatImage[]
  /** Cheaper model for compaction summaries; the main provider is retried when it fails. */
  compactionProvider?: ModelProvider
}

interface PendingCall {
  id: string
  name: string
  args: string
}

interface ModelTurn {
  text: string
  reasoning: string
  providerState: unknown
  finishReason: string | undefined
  pending: Map<number, PendingCall>
}

/**
 * The agent loop: stream model output, execute validated + permission-checked
 * tool calls, feed results back, repeat until the model finishes, the step
 * budget is exhausted, or the run is cancelled. All output flows through
 * events — this module never prints.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentResult> {
  const { provider, registry } = opts
  const plugins = opts.plugins ?? []
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
  const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW

  // Fan every event out to plugin `event` hooks without changing the host's emit.
  const baseCtx: ToolContext = {
    ...opts.ctx,
    emit: (event: RunEvent) => {
      opts.ctx.emit(event)
      for (const plugin of plugins) {
        try {
          plugin.hooks.event?.(event)
        } catch {
          // plugin observers must never break a run
        }
      }
    },
  }
  const ctx = baseCtx
  const hooks = createHookDispatcher(plugins, { cwd: ctx.root, signal: ctx.signal, mode: ctx.mode, emit: ctx.emit, ...(opts.agent ? { agent: opts.agent } : {}) })
  let stopHookActive = false

  // Reassigned when the history is compacted.
  let messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: opts.userPrompt, ...(opts.images?.length ? { images: opts.images } : {}) },
  ]
  let compacted = false
  const finish = (result: Omit<AgentResult, 'messages'>): AgentResult => ({
    ...result,
    messages,
    ...(compacted ? { compacted } : {}),
  })

  let steps = 0
  let usageTotal: Usage | undefined
  const addUsage = (usage: Usage | undefined): void => {
    if (!usage?.ready) return
    usageTotal = {
      totalTokens: (usageTotal?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
      inputTokens: (usageTotal?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (usageTotal?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      cacheReadTokens: addOptional(usageTotal?.cacheReadTokens, usage.cacheReadTokens),
      cacheWriteTokens: addOptional(usageTotal?.cacheWriteTokens, usage.cacheWriteTokens),
      ready: true,
    }
  }

  // Prompt tokens of the last request as the provider counted them, and how many messages it held.
  let lastInput: { tokens: number; count: number } | undefined
  const specTokens = (): number => Math.ceil(JSON.stringify(registry.specs()).length / 4)
  const contextTokens = (): number =>
    lastInput
      ? lastInput.tokens + estimateTokens(messages.slice(lastInput.count))
      : estimateTokens(messages) + specTokens()

  /** Prune old tool outputs, then summarize if still too big. `force` after a context overflow error. */
  const compact = async (force: boolean): Promise<boolean> => {
    const threshold = contextWindow * COMPACT_THRESHOLD
    const before = contextTokens()
    if (!force && before <= threshold) return false
    const pruned = pruneToolResults(messages)
    let next = pruned.messages
    let phase: 'prune' | 'summary' = 'prune'
    if (force || estimateTokens(next) + specTokens() > threshold) {
      try {
        const summarize = (p: ModelProvider) =>
          summarizeHistory(p, next, {
            signal: ctx.signal,
            recentBudget: Math.floor(contextWindow * 0.3),
            maxInputTokens: Math.floor(contextWindow * 0.5),
          })
        // The small model may fail (or have a smaller window); the main model is the fallback.
        const summary = opts.compactionProvider
          ? await summarize(opts.compactionProvider).catch((err: unknown) => {
              if (isAbortError(err) || ctx.signal.aborted) throw err
              return summarize(provider)
            })
          : await summarize(provider)
        if (summary) {
          next = summary.messages
          phase = 'summary'
          compacted = true
          addUsage(summary.usage)
        }
      } catch (err) {
        if (isAbortError(err) || ctx.signal.aborted) throw abortError()
        // A failed summary keeps the pruned history; the next request shows whether it fits.
      }
    }
    if (phase === 'prune' && pruned.pruned === 0) return false
    messages = next
    lastInput = undefined
    ctx.emit({ type: 'context.compacted', phase, beforeTokens: before, afterTokens: contextTokens() })
    return true
  }

  const callModel = async (): Promise<ModelTurn> => {
    let overflowHandled = false
    // Retry only while nothing has been yielded, so streamed output is never duplicated.
    for (let attempt = 1; ; attempt++) {
      const turn: ModelTurn = { text: '', reasoning: '', providerState: undefined, finishReason: undefined, pending: new Map() }
      const count = messages.length
      let inputTokens: number | undefined
      let yielded = false
      try {
        for await (const chunk of provider.stream(messages, registry.specs(), ctx.signal)) {
          yielded = true
          if (chunk.type === 'finish') {
            turn.finishReason = chunk.reason
            if (chunk.usage?.inputTokens) inputTokens = chunk.usage.inputTokens
          }
          if (chunk.type === 'text') {
            turn.text += chunk.text
            ctx.emit({ type: 'assistant.delta', text: chunk.text })
          } else if (chunk.type === 'reasoning') {
            turn.reasoning += chunk.text
            ctx.emit({ type: 'assistant.reasoning', text: chunk.text })
          } else if (chunk.type === 'provider_state') {
            turn.providerState = chunk.state
          } else if (chunk.type === 'tool_call') {
            const acc = turn.pending.get(chunk.index) ?? { id: '', name: '', args: '' }
            if (chunk.id) acc.id = chunk.id
            if (chunk.name) acc.name = chunk.name
            acc.args += chunk.argumentsDelta
            turn.pending.set(chunk.index, acc)
          } else if (chunk.type === 'finish') {
            addUsage(chunk.usage)
          }
          // Loop ends when the stream does.
        }
        lastInput = inputTokens ? { tokens: inputTokens, count } : undefined
        return turn
      } catch (err) {
        const retry = err as { retryable?: unknown; retryAfterMs?: unknown; kind?: unknown }
        // Too long for the model: compact once and send again.
        if (!yielded && retry?.kind === 'context_overflow' && !overflowHandled && !ctx.signal.aborted) {
          overflowHandled = true
          if (await compact(true)) continue
        }
        if (yielded || attempt >= MAX_ATTEMPTS || retry?.retryable !== true || ctx.signal.aborted) throw err
        const delayMs =
          typeof retry.retryAfterMs === 'number'
            ? retry.retryAfterMs
            : Math.round(Math.min(1000 * 2 ** (attempt - 1), 30_000) * (0.5 + Math.random() / 2))
        ctx.emit({ type: 'provider.retry', attempt, maxAttempts: MAX_ATTEMPTS, delayMs, reason: retryReason(retry.kind) })
        await sleep(delayMs, ctx.signal)
      }
    }
  }

  /** Append a note to the newest tool result, which the model reads next. */
  const noteOnLastResult = (note: string): boolean => {
    const last = messages.at(-1)
    if (last?.role !== 'tool_result') return false
    messages[messages.length - 1] = { ...last, content: last.content + note }
    return true
  }

  // Loop detection: identical calls since the last successful edit, and edits per path.
  const sameCalls = new Map<string, number>()
  const editsPerPath = new Map<string, number>()
  const loopRefusal = (call: ToolCallRequest): string | undefined => {
    const args = parseArgs(call.argumentsJson)
    const key = `${call.name}\0${args ? JSON.stringify(args) : call.argumentsJson}`
    const same = (sameCalls.get(key) ?? 0) + 1
    sameCalls.set(key, same)
    if (same >= 3 && !POLLING_TOOLS.has(call.name)) {
      return `you are looping: this is call #${same} of ${call.name} with identical arguments, and nothing was edited in between, so it was NOT run. Change approach: re-read the relevant code, try a different fix, or tell the user what blocks you.`
    }
    for (const target of EDIT_TOOLS.has(call.name) ? editedPaths(asRecord(args)) : []) {
      const edits = (editsPerPath.get(target) ?? 0) + 1
      editsPerPath.set(target, edits)
      if (edits === 5) {
        return `you may be looping: this is edit #5 to ${target} in this run, so it was NOT applied. Step back: re-read the file and the error, then make one complete, correct edit instead of many small ones.`
      }
    }
    return undefined
  }

  let edited = false
  let testsRan = false
  let testNudged = false
  // Stuck signals for the host (run.ts escalates on them): model turns in a row with cut-off or invalid
  // calls, and failing run_tests in a row without fewer failures.
  let badTurns = 0
  let failingTests = 0
  let lastFailures: number | undefined
  const stuck = (reason: 'loop' | 'tests_failing' | 'invalid_calls', detail: string): void => ctx.emit({ type: 'run.stuck', reason, detail })
  const trackTests = (result: Record<string, unknown>): void => {
    if (result.result === 'passed') {
      failingTests = 0
      lastFailures = undefined
      return
    }
    const failures = (Array.isArray(result.failures) ? result.failures.length : 0) + (typeof result.moreFailures === 'number' ? result.moreFailures : 0)
    failingTests = lastFailures !== undefined && failures < lastFailures ? 1 : failingTests + 1
    lastFailures = failures
    if (failingTests >= 3) {
      failingTests = 0
      stuck('tests_failing', `run_tests failed 3 times in a row without fewer failures (${failures} failing)`)
    }
  }

  const warnAt = Math.ceil(maxSteps * 0.8)
  ctx.emit({ type: 'run.started', mode: ctx.mode, model: provider.model })

  try {
    while (steps < maxSteps) {
      if (ctx.signal.aborted) throw abortError()
      steps++

      await compact(false)
      const { text, reasoning, providerState, finishReason, pending } = await callModel()

      const truncated = finishReason === 'length'
      // Calls whose JSON was cut by the token limit are stored as {} (strict providers reject broken
      // arguments in history) and answered with TRUNCATED_CALL instead of being run.
      const cutCalls = new Set<string>()
      const toolCalls: ToolCallRequest[] = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call], i) => {
          const id = call.id || `call_${steps}_${i}`
          const cut = truncated && !isJson(call.args || '{}')
          if (cut) cutCalls.add(id)
          return { id, name: call.name || `unknown_tool_${index}`, argumentsJson: cut ? '{}' : call.args }
        })

      // An empty assistant turn (a bare end_turn) would make every later request invalid.
      if (text !== '' || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(providerState !== undefined ? { providerState } : {}),
        })
      }
      ctx.emit({ type: 'assistant.message', content: text, toolCalls })

      if (toolCalls.length === 0) {
        // A Stop hook may send the model back to work, once per run (no endless loops).
        const stop = await hooks.stop(text, stopHookActive)
        if (stop.block !== undefined && !stopHookActive) {
          stopHookActive = true
          messages.push({ role: 'user', content: `A stop hook asked you to continue: ${stop.block}` })
          continue
        }
        const extra = { ...(usageTotal ? { usage: usageTotal } : {}), ...(truncated ? { truncated } : {}) }
        ctx.emit({ type: 'run.completed', steps, ...extra })
        return finish({ status: 'completed', ...extra })
      }

      let badTurn = cutCalls.size > 0
      for (const call of toolCalls) {
        if (ctx.signal.aborted) {
          // Every tool call needs a result or the history is invalid on resume.
          for (const skipped of toolCalls.slice(toolCalls.indexOf(call))) {
            messages.push({ role: 'tool_result', toolCallId: skipped.id, content: 'cancelled by the user before it ran', isError: true })
          }
          throw abortError()
        }
        if (cutCalls.has(call.id)) {
          ctx.emit({ type: 'tool.failed', callId: call.id, name: call.name, error: 'arguments cut off by the max output token limit' })
          messages.push({ role: 'tool_result', toolCallId: call.id, content: TRUNCATED_CALL, isError: true })
          continue
        }
        const refusal = loopRefusal(call)
        if (refusal) {
          ctx.emit({ type: 'tool.failed', callId: call.id, name: call.name, error: 'refused: the agent is repeating itself' })
          messages.push({ role: 'tool_result', toolCallId: call.id, content: `ERROR: ${refusal}`, isError: true })
          stuck('loop', refusal)
          continue
        }
        const out: CallOutcome = {}
        const resultMessage = await executeCall(call, registry, ctx, hooks, out)
        if (out.invalid) badTurn = true
        if (call.name === 'run_tests' && out.result !== undefined) trackTests(asRecord(out.result))
        if (EDIT_TOOLS.has(call.name) && !resultMessage.isError) sameCalls.clear() // re-running tests after an edit is not a loop
        if (EDIT_TOOLS.has(call.name) && !resultMessage.isError) edited = true
        if (call.name === 'run_tests' || (call.name === 'run_command' && TEST_COMMAND.test(call.argumentsJson))) testsRan = true
        messages.push(resultMessage)
      }
      badTurns = badTurn ? badTurns + 1 : 0
      if (badTurns >= 2) {
        badTurns = 0
        stuck('invalid_calls', 'the model sent cut-off or invalid tool calls 2 turns in a row')
      }
      // Once per run: files changed and no tests ran yet, and the project has a test runner.
      if (edited && !testsRan && !testNudged && registry.get('run_tests')) {
        testNudged = true
        if ((await checksFor(ctx).catch(() => undefined))?.test) noteOnLastResult(TEST_NUDGE)
      }
      if (steps === warnAt && warnAt < maxSteps) noteOnLastResult(budgetNotice(steps, maxSteps))
    }

    // Budget used up: one last call so the run ends with a summary instead of a dangling tool call.
    if (noteOnLastResult(BUDGET_DONE)) {
      try {
        // Tools stay in the request, which keeps it valid with tool calls in the history (and cached);
        // calls the model makes anyway are dropped.
        const final = await callModel()
        if (final.text !== '') {
          messages.push({
            role: 'assistant',
            content: final.text,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            ...(final.providerState !== undefined && final.pending.size === 0 ? { providerState: final.providerState } : {}),
          })
        }
        ctx.emit({ type: 'assistant.message', content: final.text, toolCalls: [] })
      } catch (err) {
        if (isAbortError(err)) throw err
        // The budget stop stays the result; the summary is a courtesy.
      }
    }
    ctx.emit({ type: 'run.completed', steps, ...(usageTotal ? { usage: usageTotal } : {}) })
    return finish({ status: 'max_steps', ...(usageTotal ? { usage: usageTotal } : {}) })
  } catch (err) {
    if (isAbortError(err)) {
      ctx.emit({ type: 'run.cancelled' })
      return finish({ status: 'cancelled' })
    }
    const message = err instanceof Error ? err.message : String(err)
    ctx.emit({ type: 'run.failed', error: message })
    return finish({ status: 'failed', error: message })
  }
}

/** What executeCall saw, for the stuck signals: a call the model got wrong, and the tool's raw result. */
interface CallOutcome {
  invalid?: boolean
  result?: unknown
}

async function executeCall(
  call: ToolCallRequest,
  registry: ToolRegistry,
  ctx: ToolContext,
  hooks: HookDispatcher,
  out: CallOutcome = {},
): Promise<ChatMessage> {
  const fail = (error: string): ChatMessage => {
    ctx.emit({ type: 'tool.failed', callId: call.id, name: call.name, error })
    return { role: 'tool_result', toolCallId: call.id, content: `ERROR: ${error}`, isError: true }
  }
  const invalid = (error: string): ChatMessage => {
    out.invalid = true
    return fail(error)
  }

  const tool = registry.get(call.name)
  if (!tool) return invalid(`unknown tool "${call.name}"`)

  ctx.emit({ type: 'tool.started', callId: call.id, name: call.name, summary: describeCall(call) })

  let rawInput: unknown
  try {
    rawInput = JSON.parse(call.argumentsJson || '{}')
  } catch {
    return invalid(`arguments are not valid JSON`)
  }

  // Validates the model's arguments, and again any input a plugin or hook rewrote (L17).
  const validate = (value: unknown, what: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (!('schema' in tool) || !tool.schema) return { ok: true, value }
    const parsed = tool.schema.safeParse(value)
    if (parsed.success) return { ok: true, value: parsed.data }
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, error: `invalid ${what} for "${call.name}" — ${issues}` }
  }
  const checked = validate(rawInput, 'arguments')
  if (!checked.ok) return invalid(checked.error)
  let input = checked.value
  let hookContext: string[] = []

  try {
    assertRiskAllowed(ctx.mode, tool.name, tool.risk)

    // JS plugin before-hooks, then PreToolUse command hooks.
    const pre = await hooks.preToolUse(tool.name, input, call.id)
    if (pre.block !== undefined) throw new PermissionDeniedError(pre.block)
    if (pre.updatedInput !== undefined) {
      const rewritten = validate(pre.updatedInput, 'hook-modified arguments')
      if (!rewritten.ok) return fail(rewritten.error)
      input = rewritten.value
    }
    if (pre.ask !== undefined) {
      const title = `A hook asks you to approve ${describeCall({ ...call, argumentsJson: JSON.stringify(input) })}`
      const approved = ctx.approvalsEnabled && (await ctx.requestApproval({ title, ...(pre.ask ? { detail: pre.ask } : {}) }))
      if (!approved) throw new PermissionDeniedError(`denied: a hook asked for approval and it was not given${pre.ask ? ` (${pre.ask})` : ''}`)
    }

    // Taint (roadmap C7): once web or MCP output is in the conversation, approval prompts say so.
    const toolCtx: ToolContext = ctx.state.tainted
      ? { ...ctx, requestApproval: (req) => ctx.requestApproval({ ...req, title: `${req.title} (after reading web/MCP content)` }) }
      : ctx
    const result = await tool.execute(input as never, toolCtx)
    out.result = result
    if (tool.risk === 'NETWORK') ctx.state.tainted = true
    hookContext = [...pre.context, ...(await hooks.postToolUse(tool.name, input, call.id, { result })).context]

    ctx.emit({
      type: 'tool.completed',
      callId: call.id,
      name: tool.name,
      summary: describeDone(tool.name, asRecord(input)),
    })
    const content = await resultText(tool.name, result, ctx.root, call.id)
    // A result's `image` (read_file on an image for a vision model) goes to the model as an image.
    const image = asRecord(result).image as ChatImage | undefined
    return {
      role: 'tool_result',
      toolCallId: call.id,
      content: hookContext.length > 0 ? `${content}\n${hookContextBlock(hookContext)}` : content,
      isError: false,
      ...(typeof image?.mediaType === 'string' && typeof image.data === 'string' ? { images: [image] } : {}),
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    void hooks.postToolUse(tool.name, input, call.id, { error: message })
    return fail(message)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Plain text for the model; long output keeps its head and tail and is spilled to .hesdor/out. */
async function resultText(name: string, result: unknown, root: string, callId: string): Promise<string> {
  let text: string
  try {
    text = formatToolResult(name, result)
  } catch {
    text = String(result) // e.g. a circular object from an MCP tool
  }
  return selfLimited(name) ? text : capOutput(text, root, callId)
}

function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return undefined
  }
}

/** Files an edit call touches: `path`, or the file headers of a V4A patch in `input`. */
export function editedPaths(args: Record<string, unknown>): string[] {
  if (typeof args.path === 'string') return [args.path]
  if (typeof args.input !== 'string') return []
  return [...args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm)].map((m) => m[1]!)
}

/** Compact "name arg" summary used for tool.started events. */
function describeCall(call: ToolCallRequest): string {
  try {
    const o = JSON.parse(call.argumentsJson || '{}') as Record<string, unknown>
    const paths = editedPaths(o)
    const hint =
      paths.length > 0
        ? paths.join(', ')
        : typeof o.command === 'string'
          ? o.command
          : typeof o.pattern === 'string'
            ? o.pattern
            : ''
    return hint ? `${call.name} ${truncate(hint, 60)}` : call.name
  } catch {
    return call.name
  }
}

function describeDone(name: string, input: Record<string, unknown>): string {
  const p = editedPaths(input).join(', ') || undefined
  switch (name) {
    case 'write_file':
      return p ? `wrote ${p}` : name
    case 'apply_patch':
      return p ? `patched ${p}` : name
    case 'delete_file':
      return p ? `deleted ${p}` : name
    default:
      return describeCall({
        id: '',
        name,
        argumentsJson: JSON.stringify(input),
      })
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function addOptional(a?: number, b?: number): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

function retryReason(kind: unknown): string {
  if (kind === 'rate_limit') return 'rate limited'
  if (kind === 'overloaded') return 'provider overloaded'
  return 'network error'
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  const err = new Error('run cancelled')
  err.name = 'AbortError'
  return err
}
