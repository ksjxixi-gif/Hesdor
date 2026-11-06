import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { AgentMode, RunEvent } from '@hesdor/protocol'
import { childEnv, killTree } from './exec.js'
import type { LoadedPlugin } from './plugins.js'

/**
 * Command hooks in the Claude Code contract: `hooks.json` maps an event to
 * matcher groups of `{ type: "command", command, timeout? }` handlers. Each
 * handler gets the event as JSON on stdin. Exit 0 = ok (stdout may be a JSON
 * decision), exit 2 = block with stderr as the reason, anything else = a
 * non-blocking error. JS plugin hooks go through the same dispatcher.
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface CommandHook {
  type: 'command'
  command: string
  /** Seconds; default 60. */
  timeout?: number
}
export interface HookGroup {
  matcher?: string
  hooks: CommandHook[]
}
export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>

/** Aggregated result of every hook that ran for one event. */
export interface HookOutcome {
  /** Set when a hook blocked (exit 2, `decision: "block"`, `permissionDecision: "deny"`, `continue: false`). */
  block?: string
  /** PreToolUse `permissionDecision: "ask"`: the reason ('' when none). */
  ask?: string
  /** PreToolUse `updatedInput` (the last hook that set it wins). */
  updatedInput?: unknown
  /** Text for the model (`additionalContext`, PostToolUse exit-2 stderr, plain stdout of prompt/session hooks). */
  context: string[]
}

const DEFAULT_TIMEOUT_S = 60
const MAX_OUTPUT = 100_000
const MAX_CONTEXT = 10_000

/** Read and merge hook files; invalid entries become warnings. Missing files are skipped. */
export async function loadHookConfig(files: string[], warn: (message: string) => void = () => {}): Promise<HookConfig> {
  const out: HookConfig = {}
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      warn(`hooks ${file}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // Same shape as Claude Code settings (`{ "hooks": { ... } }`); a bare event map works too.
    const events = isObject(json) && isObject(json.hooks) ? json.hooks : json
    if (!isObject(events)) {
      warn(`hooks ${file}: expected an object of events`)
      continue
    }
    for (const [event, groups] of Object.entries(events)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        warn(`hooks ${file}: unsupported event "${event}" ignored`)
        continue
      }
      if (!Array.isArray(groups)) {
        warn(`hooks ${file}: ${event} must be an array`)
        continue
      }
      for (const group of groups) {
        const handlers = isObject(group) && Array.isArray(group.hooks) ? group.hooks : []
        const valid = handlers.filter(
          (h): h is CommandHook =>
            isObject(h) && h.type === 'command' && typeof h.command === 'string' && h.command.trim() !== '' &&
            (h.timeout === undefined || (typeof h.timeout === 'number' && h.timeout > 0)),
        )
        if (valid.length !== handlers.length || valid.length === 0) {
          warn(`hooks ${file}: ${event} has an invalid entry (only { "type": "command", "command": "..." } handlers are supported)`)
        }
        if (valid.length === 0) continue
        const matcher = isObject(group) && typeof group.matcher === 'string' ? group.matcher : undefined
        ;(out[event as HookEvent] ??= []).push({ ...(matcher !== undefined ? { matcher } : {}), hooks: valid })
      }
    }
  }
  return out
}

/** Wrap a hook config as a plugin so it travels with the session's plugins (main loop and subagents). */
export function commandHooksPlugin(config: HookConfig, file = 'hooks.json'): LoadedPlugin | undefined {
  return Object.keys(config).length > 0 ? { name: 'hooks.json', file, hooks: {}, commandHooks: config } : undefined
}

/** Claude Code matcher rules: empty or `*` = all; only word chars, `|` and `,` = exact list; else unanchored regex. */
export function hookMatches(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (/^[\w\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).some((m) => m.trim() === value)
  try {
    return new RegExp(matcher).test(value)
  } catch {
    return false
  }
}

export interface HookRunOptions {
  cwd: string
  signal: AbortSignal
  mode?: AgentMode
  /** Set inside subagents: their stop event is SubagentStop and stdin carries `agent_type`. */
  agent?: string
  /** User-facing notices: non-blocking hook errors and `systemMessage`. */
  emit?: (event: RunEvent) => void
}

export interface HookDispatcher {
  run(event: HookEvent, fields: Record<string, unknown>, matchValue?: string): Promise<HookOutcome>
  /** JS `tool.execute.before` plugins (in order, may rewrite input), then PreToolUse command hooks. */
  preToolUse(tool: string, input: unknown, callId: string): Promise<HookOutcome>
  /** PostToolUse command hooks (awaited) and JS `tool.execute.after` plugins (fire and forget). */
  postToolUse(tool: string, input: unknown, callId: string, outcome: { result?: unknown; error?: string }): Promise<HookOutcome>
  /** Stop (or SubagentStop inside a subagent). */
  stop(lastMessage: string, stopHookActive: boolean): Promise<HookOutcome>
}

export function createHookDispatcher(plugins: LoadedPlugin[], opts: HookRunOptions): HookDispatcher {
  const notice = (event: HookEvent, message: string): void => opts.emit?.({ type: 'hook.notice', event, message })

  async function run(event: HookEvent, fields: Record<string, unknown>, matchValue?: string): Promise<HookOutcome> {
    const handlers = plugins.flatMap((p) =>
      (p.commandHooks?.[event] ?? []).filter((g) => matchValue === undefined || hookMatches(g.matcher, matchValue)).flatMap((g) => g.hooks),
    )
    const outcome: HookOutcome = { context: [] }
    if (handlers.length === 0) return outcome
    const input = {
      cwd: opts.cwd,
      hook_event_name: event,
      ...(opts.mode ? { permission_mode: opts.mode } : {}),
      ...(opts.agent ? { agent_type: opts.agent } : {}),
      ...fields,
    }
    const results = await Promise.all(handlers.map((h) => runCommand(h, input, opts.cwd, opts.signal)))
    if (opts.signal.aborted) throw abortError()
    const canBlock = event !== 'PostToolUse' && event !== 'SessionStart'
    const plainStdoutIsContext = event === 'UserPromptSubmit' || event === 'SessionStart'
    results.forEach((r, i) => {
      const label = handlers[i]!.command
      if (r.code === 2) {
        const reason = r.stderr.trim() || `blocked by hook \`${label}\``
        if (canBlock) outcome.block ??= reason
        else if (event === 'PostToolUse') outcome.context.push(reason)
        else notice(event, reason)
        return
      }
      if (r.code !== 0) {
        notice(event, `hook \`${label}\` failed: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)}`)
        return
      }
      const out = r.stdout.trim()
      const json = out.startsWith('{') ? parseObject(out) : undefined
      if (!json) {
        if (out && plainStdoutIsContext) outcome.context.push(out.slice(0, MAX_CONTEXT))
        return
      }
      const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {}
      if (typeof json.systemMessage === 'string') notice(event, json.systemMessage)
      const reason = (v: unknown): string => (typeof v === 'string' ? v : '')
      if (json.continue === false && canBlock) outcome.block ??= reason(json.stopReason) || `stopped by hook \`${label}\``
      if (json.decision === 'block') {
        if (canBlock) outcome.block ??= reason(json.reason) || `blocked by hook \`${label}\``
        else if (json.reason) outcome.context.push(reason(json.reason))
      }
      if (event === 'PreToolUse') {
        const why = reason(specific.permissionDecisionReason)
        if (specific.permissionDecision === 'deny') outcome.block ??= why || `denied by hook \`${label}\``
        if (specific.permissionDecision === 'ask') outcome.ask ??= why
        // shortcut: "allow" does not skip Hesdor's own approvals or mode checks; it only adds no objection.
        if (isObject(specific.updatedInput)) outcome.updatedInput = specific.updatedInput
      }
      const extra = specific.additionalContext ?? json.additionalContext
      if (typeof extra === 'string' && extra.trim()) outcome.context.push(extra.slice(0, MAX_CONTEXT))
    })
    return outcome
  }

  return {
    run,
    async preToolUse(tool, input, callId) {
      let current = input
      let changed = false
      for (const plugin of plugins) {
        const hook = plugin.hooks['tool.execute.before']
        if (!hook) continue
        const res = await hook({ tool, input: current })
        if (res?.deny) return { block: `blocked by plugin "${plugin.name}": ${res.deny}`, context: [] }
        if (res && 'input' in res && res.input !== undefined) {
          current = res.input
          changed = true
        }
      }
      const outcome = await run('PreToolUse', { tool_name: tool, tool_input: current, tool_use_id: callId }, tool)
      if (outcome.block !== undefined) outcome.block = `blocked by hook: ${outcome.block}`
      if (outcome.updatedInput === undefined && changed) outcome.updatedInput = current
      return outcome
    },
    async postToolUse(tool, input, callId, result) {
      for (const plugin of plugins) {
        void Promise.resolve()
          .then(() => plugin.hooks['tool.execute.after']?.({ tool, input, ...result }))
          .catch(() => {})
      }
      // Failed calls have no PostToolUse (Claude Code fires PostToolUseFailure there).
      if (result.error !== undefined) return { context: [] }
      return run('PostToolUse', { tool_name: tool, tool_input: input, tool_response: result.result, tool_use_id: callId }, tool)
    },
    stop(lastMessage, stopHookActive) {
      return run(opts.agent ? 'SubagentStop' : 'Stop', { stop_hook_active: stopHookActive, last_assistant_message: lastMessage }, opts.agent)
    },
  }
}

/** Hook text for the model, appended to a tool result or prompt. */
export function hookContextBlock(context: string[]): string {
  return context.map((c) => `<hook-context>\n${c}\n</hook-context>`).join('\n')
}

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

/** Hooks are user-authored shell snippets (as in Claude Code), so they run through the platform shell. */
function runCommand(hook: CommandHook, input: object, cwd: string, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ code: null, stdout: '', stderr: '', error: 'cancelled' })
    let stdout = ''
    let stderr = ''
    let error: string | undefined
    const child = spawn(hook.command, {
      shell: true,
      cwd,
      windowsHide: true,
      env: childEnv({ HESDOR_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd }),
    })
    const stopChild = (why: string): void => {
      error ??= why
      void killTree(child)
    }
    const timer = setTimeout(() => stopChild(`timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_S}s`), (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000)
    const onAbort = (): void => stopChild('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8')
    })
    child.stdin.on('error', () => {}) // the hook may exit without reading stdin
    child.stdin.end(JSON.stringify(input))
    const done = (code: number | null): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      // A killed hook never counts as exit 0 or 2.
      resolve({ code: error ? null : code, stdout, stderr, ...(error ? { error } : {}) })
    }
    child.on('error', (err) => {
      error ??= err.message
      done(null)
    })
    child.on('close', done)
  })
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortError(): Error {
  const err = new Error('run cancelled')
  err.name = 'AbortError'
  return err
}
