import type {
  AgentResult,
  ChatMessage,
  ModelProvider,
  RunEvent,
  ToolCallRequest,
} from '@hesdor/protocol'
import type { ToolContext } from './context.js'
import type { LoadedPlugin } from './plugins.js'
import { assertRiskAllowed, PermissionDeniedError } from './policy.js'
import type { ToolRegistry } from './registry.js'

export const DEFAULT_MAX_STEPS = 30

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
}

interface PendingCall {
  id: string
  name: string
  args: string
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

  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: opts.userPrompt },
  ]
  const finish = (result: Omit<AgentResult, 'messages'>): AgentResult => ({ ...result, messages })

  let steps = 0
  ctx.emit({ type: 'run.started', mode: ctx.mode, model: provider.model })

  try {
    while (steps < maxSteps) {
      if (ctx.signal.aborted) throw abortError()
      steps++

      let text = ''
      const pending = new Map<number, PendingCall>()
      for await (const chunk of provider.stream(messages, registry.specs(), ctx.signal)) {
        if (chunk.type === 'text') {
          text += chunk.text
          ctx.emit({ type: 'assistant.delta', text: chunk.text })
        } else if (chunk.type === 'tool_call') {
          const acc = pending.get(chunk.index) ?? { id: '', name: '', args: '' }
          if (chunk.id) acc.id = chunk.id
          if (chunk.name) acc.name = chunk.name
          acc.args += chunk.argumentsDelta
          pending.set(chunk.index, acc)
        }
        // 'finish' chunks carry no payload we need; loop ends when the stream does.
      }

      const toolCalls: ToolCallRequest[] = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call], i) => ({
          id: call.id || `call_${steps}_${i}`,
          name: call.name || `unknown_tool_${index}`,
          argumentsJson: call.args,
        }))

      messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      })
      ctx.emit({ type: 'assistant.message', content: text, toolCalls })

      if (toolCalls.length === 0) {
        ctx.emit({ type: 'run.completed', steps })
        return finish({ status: 'completed' })
      }

      for (const call of toolCalls) {
        const resultMessage = await executeCall(call, registry, ctx, plugins)
        messages.push(resultMessage)
      }
    }

    ctx.emit({ type: 'run.completed', steps })
    return finish({ status: 'max_steps' })
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

async function executeCall(
  call: ToolCallRequest,
  registry: ToolRegistry,
  ctx: ToolContext,
  plugins: LoadedPlugin[],
): Promise<ChatMessage> {
  const fail = (error: string): ChatMessage => {
    ctx.emit({ type: 'tool.failed', callId: call.id, name: call.name, error })
    return { role: 'tool_result', toolCallId: call.id, content: `ERROR: ${error}`, isError: true }
  }

  const tool = registry.get(call.name)
  if (!tool) return fail(`unknown tool "${call.name}"`)

  ctx.emit({ type: 'tool.started', callId: call.id, name: call.name, summary: describeCall(call) })

  let rawInput: unknown
  try {
    rawInput = JSON.parse(call.argumentsJson || '{}')
  } catch {
    return fail(`arguments are not valid JSON`)
  }

  let input: unknown = rawInput
  if ('schema' in tool && tool.schema) {
    const parsed = tool.schema.safeParse(rawInput)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      return fail(`invalid arguments for "${call.name}" — ${issues}`)
    }
    input = parsed.data
  }

  try {
    assertRiskAllowed(ctx.mode, tool.name, tool.risk)

    for (const plugin of plugins) {
      const hook = plugin.hooks['tool.execute.before']
      if (!hook) continue
      const outcome = await hook({ tool: tool.name, input })
      if (outcome?.deny) {
        throw new PermissionDeniedError(`blocked by plugin "${plugin.name}": ${outcome.deny}`)
      }
      if (outcome && 'input' in outcome && outcome.input !== undefined) {
        input = outcome.input
      }
    }

    const result = await tool.execute(input as never, ctx)

    for (const plugin of plugins) {
      void Promise.resolve()
        .then(() => plugin.hooks['tool.execute.after']?.({ tool: tool.name, input, result }))
        .catch(() => {})
    }

    ctx.emit({
      type: 'tool.completed',
      callId: call.id,
      name: tool.name,
      summary: describeDone(tool.name, asRecord(input)),
    })
    return { role: 'tool_result', toolCallId: call.id, content: stringifyResult(result), isError: false }
  } catch (err) {
    if (isAbortError(err)) throw err
    const message = err instanceof Error ? err.message : String(err)
    for (const plugin of plugins) {
      void Promise.resolve()
        .then(() => plugin.hooks['tool.execute.after']?.({ tool: tool.name, input, error: message }))
        .catch(() => {})
    }
    return fail(message)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringifyResult(result: unknown): string {
  let json: string
  try {
    json = JSON.stringify(result, null, 1) ?? String(result)
  } catch {
    json = String(result)
  }
  if (json.length > 24_000) {
    json = `${json.slice(0, 24_000)}\n... (truncated)`
  }
  return json
}

/** Compact "name arg" summary used for tool.started events. */
function describeCall(call: ToolCallRequest): string {
  try {
    const o = JSON.parse(call.argumentsJson || '{}') as Record<string, unknown>
    const hint =
      typeof o.path === 'string'
        ? o.path
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
  const p = typeof input.path === 'string' ? input.path : undefined
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  const err = new Error('run cancelled')
  err.name = 'AbortError'
  return err
}
