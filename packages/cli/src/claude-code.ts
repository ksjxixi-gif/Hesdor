import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentMode, ChatImage, RunEvent, TodoItem, Usage } from '@hesdor/protocol'
import type { TurnOptions, TurnResult } from './run.js'

/**
 * The `claude-code` provider: Hesdor shows the work of the user's own signed-in Claude Code (`claude -p`,
 * stream-json) instead of running its own loop, so a Claude plan pays. Hesdor never sees a Claude credential;
 * Claude Code's own tools, permissions and settings apply, not Hesdor's.
 */

/**
 * The Claude Code conversation of a Hesdor session: a UUID derived from the session id, so later turns
 * (and a Hesdor restart that resumes the session) continue it without storing anything.
 */
export function conversationId(sessionId: string): string {
  const h = createHash('sha256').update(`hesdor-claude-code:${sessionId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export type Conversation = { id: string; resume: boolean }

export function claudeCodeArgs(mode: AgentMode, model: string, conversation?: Conversation): string[] {
  // build may edit files; plan and ask stay read-only. Commands follow the user's Claude Code permission rules.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode === 'build' ? 'acceptEdits' : 'plan']
  if (model && model !== 'default') args.push('--model', model)
  if (conversation) args.push(conversation.resume ? '--resume' : '--session-id', conversation.id)
  return args
}

/** The prompt as Claude Code's stream-json input: one user message line, with any attached images. */
export function userMessage(prompt: string, images: ChatImage[] = []): string {
  // Images first, then the question (the order Anthropic's vision guide recommends).
  const content = [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
    { type: 'text', text: prompt },
  ]
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

/** Claude Code refused the conversation flag: `--resume` of one it never saw, or `--session-id` of one it has. */
export function wrongConversationFlag(output: string): boolean {
  return /No conversation found with session ID|Session ID \S+ is already in use/i.test(output)
}

/** One line for a tool call: its name and the input that matters most. */
export function toolSummary(name: string, input: Record<string, unknown>, root: string): string {
  const raw = [input.file_path, input.notebook_path, input.path, input.command, input.pattern, input.url, input.query, input.description].find(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  if (!raw) return name
  const shown = path.isAbsolute(raw) && raw.startsWith(root) ? path.relative(root, raw) || '.' : raw
  const line = shown.split('\n')[0]!
  return `${name} ${line.length > 100 ? `${line.slice(0, 99)}…` : line}`
}

function todosOf(input: Record<string, unknown>): TodoItem[] | undefined {
  if (!Array.isArray(input.todos)) return undefined
  return input.todos.flatMap((t: { content?: unknown; status?: unknown }) =>
    typeof t?.content === 'string'
      ? [{ content: t.content, status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending' }]
      : [],
  )
}

function usageOf(u: Record<string, number | undefined> | undefined): Usage | undefined {
  if (!u) return undefined
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const input = (u.input_tokens ?? 0) + read + write
  const output = u.output_tokens ?? 0
  return { ready: true, inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: read, cacheWriteTokens: write }
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : ''

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** Line-by-line translation of Claude Code's stream-json into Hesdor run events. */
export function createTranslator(root: string, emit: (e: RunEvent) => void, emitSubagent?: (e: RunEvent) => void) {
  const calls = new Map<string, { name: string; summary: string; path?: string }>()
  const state: { sessionId?: string; result?: Record<string, unknown>; onPlan: boolean } = { onPlan: false }
  const handle = (m: Record<string, any>, mode: AgentMode): void => {
    const sub = m.parent_tool_use_id != null
    const out = sub ? emitSubagent : emit
    if (m.type === 'system' && m.subtype === 'init') {
      state.sessionId = m.session_id
      emit({ type: 'run.started', mode, model: `claude-code/${m.model ?? 'default'}` })
    } else if (m.type === 'rate_limit_event') {
      state.onPlan = true
    } else if (m.type === 'stream_event' && !sub && m.event?.type === 'content_block_delta') {
      const d = m.event.delta
      if (d?.type === 'text_delta' && d.text) emit({ type: 'assistant.delta', text: d.text })
      else if (d?.type === 'thinking_delta' && d.thinking) emit({ type: 'assistant.reasoning', text: d.thinking })
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b?.type !== 'tool_use') continue
        const input = (b.input ?? {}) as Record<string, unknown>
        const summary = toolSummary(b.name, input, root)
        const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        calls.set(b.id, { name: b.name, summary, ...(file && EDIT_TOOLS.has(b.name) ? { path: file } : {}) })
        out?.({ type: 'tool.started', callId: b.id, name: b.name, summary })
        const todos = b.name === 'TodoWrite' ? todosOf(input) : undefined
        if (todos && !sub) emit({ type: 'todo.updated', todos })
      }
    } else if (m.type === 'user') {
      for (const b of m.message?.content ?? []) {
        if (b?.type !== 'tool_result') continue
        const call = calls.get(b.tool_use_id) ?? { name: 'tool', summary: 'tool' }
        if (b.is_error) out?.({ type: 'tool.failed', callId: b.tool_use_id, name: call.name, error: textOf(b.content).slice(0, 500) })
        else {
          out?.({ type: 'tool.completed', callId: b.tool_use_id, name: call.name, summary: call.summary })
          if (call.path && !sub) emit({ type: 'file.changed', path: call.path, op: 'write' })
        }
      }
    } else if (m.type === 'result') {
      state.result = m
    }
  }
  return { handle, state }
}

/** A turn run by the user's Claude Code. Its result is shaped like a Hesdor turn so every front end works unchanged. */
export async function runClaudeCodeTurn(opts: TurnOptions): Promise<TurnResult> {
  const history = opts.history ?? []
  const earlier = history.some((m) => m.role === 'user')
  // Earlier turns: continue their Claude Code conversation. If they ran on another provider, Claude Code says so and we start one.
  let conversation: Conversation | undefined = opts.sessionId ? { id: conversationId(opts.sessionId), resume: earlier } : undefined
  // Claude Code prefers an API key in the environment over the user's Claude login; this provider is for the login.
  const env = { ...process.env }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE']) delete env[k]

  const finish = (r: Omit<TurnResult, 'messages' | 'steps' | 'text'> & { steps?: number; text?: string }): TurnResult => {
    const text = r.text ?? ''
    return {
      steps: 0,
      ...r,
      text,
      messages: [...history, { role: 'user', content: opts.prompt, ...(opts.images?.length ? { images: opts.images } : {}) }, ...(text ? [{ role: 'assistant' as const, content: text }] : [])],
    }
  }

  const attempt = async () => {
    const { handle, state } = createTranslator(opts.root, opts.emit, opts.emitSubagent)
    let stderr = ''
    const exit = await new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
      // shortcut: no shell, so on Windows only an installed claude.exe (native installer, winget) is found; add a .cmd lookup if npm installs need it.
      const child = spawn('claude', claudeCodeArgs(opts.mode, opts.provider.model, conversation), { cwd: opts.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const abort = (): void => void child.kill()
      opts.signal.addEventListener('abort', abort, { once: true })
      child.on('error', (error: NodeJS.ErrnoException) => resolve({ code: null, error }))
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          handle(JSON.parse(line), opts.mode)
        } catch {
          // not a JSON event (a stray log line)
        }
      })
      child.on('close', (code) => {
        opts.signal.removeEventListener('abort', abort)
        resolve({ code })
      })
      child.stdin.end(userMessage(opts.prompt, opts.images))
    })
    return { exit, stderr, state }
  }

  let { exit, stderr, state } = await attempt()
  const errors = (state.result as { errors?: unknown } | undefined)?.errors
  if (conversation && !state.sessionId && !opts.signal.aborted && wrongConversationFlag(`${stderr}\n${Array.isArray(errors) ? errors.join('\n') : ''}`)) {
    conversation = { ...conversation, resume: !conversation.resume }
    if (!conversation.resume && earlier) {
      opts.emit({ type: 'hook.notice', event: 'claude-code', message: 'Claude Code starts a new conversation here; it does not see the earlier turns of this session.' })
    }
    ;({ exit, stderr, state } = await attempt())
  }

  if (opts.signal.aborted) {
    opts.emit({ type: 'run.cancelled' })
    return finish({ status: 'cancelled' })
  }
  if (exit.error) {
    const error =
      exit.error.code === 'ENOENT'
        ? 'Claude Code (`claude`) is not installed or not on PATH. Install it, sign in with `claude auth login`, then try again.'
        : `could not start Claude Code: ${exit.error.message}`
    opts.emit({ type: 'run.failed', error })
    return finish({ status: 'failed', error, errorKind: 'unknown' })
  }

  const r = state.result as Record<string, any> | undefined
  if (!r) {
    const error = `Claude Code exited (${exit.code}) without a result${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`
    opts.emit({ type: 'run.failed', error })
    return finish({ status: 'failed', error, errorKind: 'unknown' })
  }
  const denied: { tool_name?: string }[] = Array.isArray(r.permission_denials) ? r.permission_denials : []
  if (denied.length > 0) {
    const names = [...new Set(denied.map((d) => d.tool_name ?? 'tool'))].join(', ')
    opts.emit({ type: 'hook.notice', event: 'claude-code', message: `Claude Code was not allowed to run ${denied.length} action(s) (${names}); allow them in Claude Code's own permission settings.` })
  }
  const usage = usageOf(r.usage)
  // On a Claude plan the cost Claude Code reports is notional; only an API key is billed per request.
  const cost = !state.onPlan && typeof r.total_cost_usd === 'number' ? { costUsd: r.total_cost_usd } : {}
  const steps = typeof r.num_turns === 'number' ? r.num_turns : 0
  const text = typeof r.result === 'string' ? r.result : ''
  if (r.is_error || r.subtype !== 'success') {
    const error = text || String(r.subtype ?? 'Claude Code failed')
    if (r.subtype === 'error_max_turns') {
      opts.emit({ type: 'run.completed', steps, ...(usage ? { usage } : {}) })
      return finish({ status: 'max_steps', steps, text, ...(usage ? { usage } : {}), ...cost })
    }
    opts.emit({ type: 'run.failed', error })
    return finish({ status: 'failed', error, errorKind: /log ?in|api key|authenticat|credential/i.test(error) ? 'auth' : 'unknown', steps, ...(usage ? { usage } : {}), ...cost })
  }
  opts.emit({ type: 'run.completed', steps, ...(usage ? { usage } : {}) })
  return finish({ status: 'completed', steps, text, ...(usage ? { usage } : {}), ...cost })
}
