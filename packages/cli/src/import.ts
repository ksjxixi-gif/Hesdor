import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createDefaultRegistry } from '@hesdor/agent-core'
import type { ChatMessage, ToolCallRequest } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import { resolveWorkspaceRoot } from './run.js'
import { newSessionId, saveSession, titleFrom } from './sessions.js'

export type ImportSource = 'claude' | 'codex'
const LABEL: Record<ImportSource, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Provider APIs only accept [A-Za-z0-9_-] in tool names and ids. */
const safe = (s: unknown): string => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'

/** Collects items into Hesdor messages: consecutive assistant text and calls form one assistant turn. */
function builder(label: string) {
  const msgs: ChatMessage[] = []
  let cur: ChatMessage | null = null
  const flush = () => {
    if (cur) msgs.push(cur)
    cur = null
  }
  const assistant = (): ChatMessage => (cur ??= { role: 'assistant', content: '' })
  return {
    text(t: string) {
      const a = assistant()
      a.content = a.content ? `${a.content}\n\n${t}` : t
    },
    call(c: ToolCallRequest) {
      ;(assistant().toolCalls ??= []).push(c)
    },
    user(t: string) {
      flush()
      msgs.push({ role: 'user', content: t })
    },
    result(id: string, content: string, isError: boolean) {
      flush()
      msgs.push({ role: 'tool_result', toolCallId: id, content, ...(isError ? { isError } : {}) })
    },
    done(): ChatMessage[] {
      flush()
      return textifyForeign(normalize(msgs), label)
    },
  }
}

const builtins = createDefaultRegistry()

/** A call Hesdor could have made itself: a built-in tool whose arguments pass that tool's schema. */
function isHesdorCall(c: ToolCallRequest): boolean {
  const tool = builtins.get(c.name)
  if (!tool || !('schema' in tool)) return false
  try {
    return tool.schema.safeParse(JSON.parse(c.argumentsJson)).success
  } catch {
    return false
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text)

/**
 * A turn that calls any tool Hesdor lacks (or with unparseable arguments) becomes plain text: the calls are
 * appended to the assistant text and their results folded into the next user message. Strict providers
 * reject tool_use for undefined tools, and the model would otherwise try to call them after resume.
 * Expects normalize()d input, where every call's results directly follow it.
 */
export function textifyForeign(msgs: ChatMessage[], label: string): ChatMessage[] {
  const out: ChatMessage[] = []
  const foreign = new Map<string, string>()
  let results: string[] = []
  const flushResults = () => {
    if (results.length > 0) out.push({ role: 'user', content: results.join('\n\n') })
    results = []
  }
  for (const m of msgs) {
    const name = m.role === 'tool_result' ? foreign.get(m.toolCallId ?? '') : undefined
    if (name !== undefined) {
      results.push(`[result of ${name}${m.isError ? ', error' : ''}] ${clip(m.content, 2000)}`)
      continue
    }
    flushResults()
    if (m.role === 'assistant' && m.toolCalls?.some((c) => !isHesdorCall(c))) {
      const lines = m.toolCalls.map((c) => {
        foreign.set(c.id, c.name)
        return `[${label} tool ${c.name}] ${clip(c.argumentsJson, 500)}`
      })
      const { toolCalls: _calls, ...rest } = m
      out.push({ ...rest, content: [m.content, ...lines].filter(Boolean).join('\n\n') })
      continue
    }
    out.push(m)
  }
  flushResults()
  return normalize(out) // merges the folded results into a following user message
}

/**
 * Make the transcript valid to resume: every tool call gets exactly one result right after its
 * assistant turn, orphan results and empty turns are dropped, and back-to-back user texts merge.
 */
export function normalize(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pending = new Set<string>()
  const closePending = () => {
    for (const id of pending) out.push({ role: 'tool_result', toolCallId: id, content: '(no result recorded)', isError: true })
    pending = new Set()
  }
  for (const m of msgs) {
    if (m.role === 'tool_result') {
      if (m.toolCallId && pending.delete(m.toolCallId)) out.push(m)
      continue
    }
    closePending()
    if (m.role === 'assistant' && m.content.trim() === '' && !m.toolCalls?.length) continue
    const last = out[out.length - 1]
    if (m.role === 'user' && last?.role === 'user') {
      last.content += `\n\n${m.content}`
      continue
    }
    out.push(m)
    pending = new Set(m.toolCalls?.map((c) => c.id))
  }
  closePending()
  return out
}

function jsonLines(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const v = JSON.parse(line) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, any>)
    } catch {
      // a torn last line or a foreign record: skip it
    }
  }
  return out
}

/** Text of an Anthropic/OpenAI content value: a string or an array of typed blocks. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : String(b?.type ?? '').includes('image') ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

// Harness noise in user turns: slash-command echoes, injected context and instructions.
const NOISE = /^\s*(<(command-|local-command-|environment_context|user_instructions|permissions|system-reminder)|# AGENTS\.md instructions)/

/**
 * Claude Code transcript (~/.claude/projects/<encoded cwd>/<session id>.jsonl): one JSON record per
 * line; `user`/`assistant` records carry an Anthropic `message`, assistant content blocks may be
 * split across lines. Sidechain (subagent) and meta records, thinking and unknown types are skipped.
 */
export function convertClaude(text: string): ChatMessage[] {
  const b = builder(LABEL.claude)
  for (const o of jsonLines(text)) {
    if (o.isSidechain || o.isMeta || !o.message || (o.type !== 'user' && o.type !== 'assistant')) continue
    const content = o.message.content
    if (o.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : [{ type: 'text', text: content }]) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) b.text(block.text)
        else if (block?.type === 'tool_use') b.call({ id: safe(block.id), name: safe(block.name), argumentsJson: JSON.stringify(block.input ?? {}) })
      }
      continue
    }
    if (typeof content === 'string') {
      if (!NOISE.test(content)) b.user(content)
      continue
    }
    const texts: string[] = []
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'tool_result') b.result(safe(block.tool_use_id), blocksText(block.content), !!block.is_error)
      else if (block?.type === 'text' && typeof block.text === 'string' && !NOISE.test(block.text)) texts.push(block.text)
      else if (block?.type === 'image') texts.push('[image]')
    }
    if (texts.length > 0) b.user(texts.join('\n'))
  }
  return b.done()
}

/** Codex tool output: a string, an array of content items, or (older versions) an object with `content`. */
function codexOutput(output: unknown): string {
  if (output && typeof output === 'object' && !Array.isArray(output) && 'content' in output) return blocksText((output as { content: unknown }).content)
  return blocksText(output)
}

/**
 * Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl): lines are
 * { timestamp, type, payload }. Only `response_item` lines are the conversation; reasoning,
 * developer messages, event_msg, turn_context and unknown types are skipped.
 */
export function convertCodex(text: string): ChatMessage[] {
  const b = builder(LABEL.codex)
  for (const o of jsonLines(text)) {
    const p = o.payload
    if (o.type !== 'response_item' || !p || typeof p !== 'object') continue
    switch (p.type) {
      case 'message': {
        const t = blocksText(p.content)
        if (p.role === 'assistant' && t.trim()) b.text(t)
        else if (p.role === 'user' && t.trim() && !NOISE.test(t)) b.user(t)
        break
      }
      case 'function_call':
        b.call({ id: safe(p.call_id), name: safe(p.name), argumentsJson: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}) })
        break
      case 'custom_tool_call':
        b.call({ id: safe(p.call_id), name: safe(p.name), argumentsJson: JSON.stringify({ input: p.input }) })
        break
      case 'local_shell_call':
        b.call({ id: safe(p.call_id ?? p.id), name: 'local_shell', argumentsJson: JSON.stringify(p.action ?? {}) })
        break
      case 'function_call_output':
      case 'custom_tool_call_output':
        b.result(safe(p.call_id), codexOutput(p.output), p.output?.success === false)
        break
    }
  }
  return b.done()
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)

async function newestFirst(files: string[]): Promise<string[]> {
  const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(f).catch(() => null))?.mtimeMs ?? 0 })))
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.f)
}

/** Claude Code transcripts for these directories (folder name = path with non-alphanumerics as "-"). */
export async function claudeSessions(dirs: string[], home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')): Promise<string[]> {
  const projects = path.join(home, 'projects')
  const wanted = new Set(dirs.map((d) => path.resolve(d).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()))
  const names = await readdir(projects).catch(() => [] as string[])
  const files: string[] = []
  for (const name of names.filter((n) => wanted.has(n.toLowerCase()))) {
    for (const f of await readdir(path.join(projects, name)).catch(() => [] as string[])) {
      if (f.endsWith('.jsonl')) files.push(path.join(projects, name, f))
    }
  }
  return newestFirst(files)
}

async function firstLine(file: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) return line
    return ''
  } finally {
    rl.close()
  }
}

/** Codex rollouts whose session_meta cwd is one of these directories (all of them when `dirs` is empty). */
export async function codexSessions(dirs: string[], home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')): Promise<string[]> {
  const root = path.join(home, 'sessions')
  const all = await readdir(root, { recursive: true }).catch(() => [] as string[])
  const files = all.filter((f) => /rollout-.*\.jsonl$/.test(f)).map((f) => path.join(root, f))
  const matching: string[] = []
  for (const f of files) {
    if (dirs.length === 0) {
      matching.push(f)
      continue
    }
    try {
      const meta = JSON.parse(await firstLine(f)) as { type?: string; payload?: { cwd?: string } }
      const cwd = meta.payload?.cwd
      if (meta.type === 'session_meta' && typeof cwd === 'string' && dirs.some((d) => samePath(d, cwd))) matching.push(f)
    } catch {
      // unreadable or foreign file
    }
  }
  return newestFirst(matching)
}

/** `hesdor import claude|codex [<path or session id>] [--latest]`. Reads the source, never writes it. */
export async function runImport(args: string, flags: CliFlags): Promise<number> {
  const [source, ...rest] = args.split(' ')
  const target = rest.join(' ').trim()
  if (source !== 'claude' && source !== 'codex') {
    console.error('✗ usage: hesdor import claude|codex [<path or session id>] [--latest]')
    return 1
  }
  const ws = resolveWorkspaceRoot(process.cwd(), flags.allowHome)
  if ('error' in ws) {
    console.error(`✗ ${ws.error}`)
    return 1
  }
  try {
    let file: string | undefined
    if (target && !flags.latest && existsSync(target)) file = path.resolve(target)
    else {
      const dirs = [ws.root, process.cwd()]
      // An explicit id may belong to any workspace; --latest and no argument mean this one.
      const candidates = source === 'claude' ? await claudeSessions(dirs) : await codexSessions(target && !flags.latest ? [] : dirs)
      const matches = target && !flags.latest ? candidates.filter((f) => path.basename(f).includes(target)) : candidates.slice(0, 1)
      if (matches.length > 1) throw new Error(`"${target}" matches ${matches.length} ${LABEL[source]} sessions; use a longer id or a path`)
      file = matches[0]
      if (!file) throw new Error(target && !flags.latest ? `no ${LABEL[source]} session "${target}" found` : `no ${LABEL[source]} session found for ${ws.root}`)
    }
    const text = await readFile(file, 'utf8')
    const messages = source === 'claude' ? convertClaude(text) : convertCodex(text)
    if (messages.length === 0) throw new Error(`${file} holds no conversation Hesdor can import`)
    const id = newSessionId()
    await saveSession(ws.root, { id, title: `Imported from ${LABEL[source]}: ${titleFrom(messages)}`, messages })
    console.log(`✓ imported ${messages.length} messages from ${file}`)
    console.log(`  session ${id} — resume with: hesdor -r ${id}`)
    return 0
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
