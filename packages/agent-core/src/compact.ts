import type { ChatMessage, ModelProvider, Usage } from '@hesdor/protocol'

/** Context window assumed when the model's is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 128_000
/** Compact once the estimated prompt passes this share of the context window. */
export const COMPACT_THRESHOLD = 0.8
/** Tool outputs within this many recent tokens are never pruned. */
export const PRUNE_KEEP_TOKENS = 40_000
export const PRUNED = '[output pruned]'
export const SUMMARY_PREFIX = '[summary of the earlier conversation]'
/** Tokens counted per attached image, whatever its base64 length (providers downscale large images to roughly this). */
export const IMAGE_TOKENS = 1600

/** shortcut: chars/4 is rough (code and CJK differ); swap in a tokenizer if compaction fires too early or late. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length + (m.reasoning?.length ?? 0) + 16 + (m.images?.length ?? 0) * IMAGE_TOKENS * 4
    for (const call of m.toolCalls ?? []) chars += call.name.length + call.argumentsJson.length + 16
  }
  return Math.ceil(chars / 4)
}

/**
 * Phase 1: replace tool outputs older than the most recent `keepTokens` with a marker.
 * Only contents change, so every tool call keeps its result and the history stays valid.
 */
export function pruneToolResults(messages: ChatMessage[], keepTokens = PRUNE_KEEP_TOKENS): { messages: ChatMessage[]; pruned: number } {
  let seen = 0
  let pruned = 0
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!
    if (m.role !== 'tool_result' || m.content === PRUNED) continue
    seen += estimateTokens([m])
    if (seen > keepTokens) {
      const { images: _images, ...rest } = m
      out[i] = { ...rest, content: PRUNED }
      pruned++
    }
  }
  return { messages: out, pruned }
}

const SUMMARY_SYSTEM =
  'You compress a coding-agent conversation into a handoff summary so the work can continue in a fresh context window. ' +
  'Write these sections with markdown headings: Goal, Decisions, Files touched, Current state, Next steps. ' +
  'Be specific: exact file paths, function names, commands, error messages and user preferences. Keep earlier summaries\' facts that still matter. Do not call tools.'

/**
 * Where the kept recent part starts: the last 2 user turns, or less when they alone are over
 * `recentBudget` (one long agent turn), but always at a user or assistant message so no
 * tool result is cut off from its call. Returns 0 when there is nothing older to summarize.
 */
export function summaryCut(messages: ChatMessage[], recentBudget: number): number {
  const users = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  let cut = users.at(-2) ?? users.at(-1) ?? messages.length
  if (estimateTokens(messages.slice(cut)) > recentBudget && users.length > 0) cut = users.at(-1)!
  if (estimateTokens(messages.slice(cut)) > recentBudget) {
    let best = -1
    for (let i = messages.length - 1; i > cut; i--) {
      if (messages[i]!.role !== 'assistant') continue
      if (best >= 0 && estimateTokens(messages.slice(i)) > recentBudget) break
      best = i
    }
    if (best > 0) cut = best
  }
  // messages[0] is the system prompt; something must lie between it and the cut.
  return cut > 1 && messages[0]?.role === 'system' ? cut : 0
}

/**
 * Phase 2: ask the model (without tools) for a structured summary of everything before the
 * kept recent part, and continue from [system, summary as a user turn, recent part].
 * Returns null when there is nothing to summarize.
 */
export async function summarizeHistory(
  provider: ModelProvider,
  messages: ChatMessage[],
  opts: { signal: AbortSignal; recentBudget: number; maxInputTokens: number },
): Promise<{ messages: ChatMessage[]; usage?: Usage } | null> {
  const cut = summaryCut(messages, opts.recentBudget)
  if (cut === 0) return null
  let text = transcript(messages.slice(1, cut))
  const maxChars = opts.maxInputTokens * 4
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.2)
    text = `${text.slice(0, head)}\n[… middle of the conversation omitted …]\n${text.slice(text.length - (maxChars - head))}`
  }
  let summary = ''
  let usage: Usage | undefined
  for await (const chunk of provider.stream(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `Summarize this conversation:\n\n${text}` },
    ],
    [],
    opts.signal,
  )) {
    if (chunk.type === 'text') summary += chunk.text
    else if (chunk.type === 'finish' && chunk.usage?.ready) usage = chunk.usage
  }
  if (summary.trim() === '') throw new Error('the model returned an empty summary')
  return {
    messages: [messages[0]!, { role: 'user', content: `${SUMMARY_PREFIX}\n${summary.trim()}` }, ...messages.slice(cut)],
    ...(usage ? { usage } : {}),
  }
}

function transcript(messages: ChatMessage[]): string {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
  return messages
    .map((m) => {
      if (m.role === 'tool_result') return `[tool result${m.isError ? ', error' : ''}]\n${clip(m.content, 2000)}`
      const calls = (m.toolCalls ?? []).map((c) => `→ ${c.name} ${clip(c.argumentsJson, 500)}`)
      return [`[${m.role}]`, clip(m.content, 8000), ...calls].filter((s) => s !== '').join('\n')
    })
    .join('\n\n')
}
