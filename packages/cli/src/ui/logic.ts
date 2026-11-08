import type { CustomCommand } from '@hesdor/agent-core'
import type { ChatMessage, RunEvent, Usage } from '@hesdor/protocol'
import { getPreset } from '@hesdor/providers'
import type { CliFlags } from '../args.js'
import { chatgptPlanNotice } from '../chatgpt-login.js'
import { savedModel } from '../config.js'
import type { HesdorConfig } from '../config.js'
import { providerBlocked } from '../config-layers.js'
import type { ManagedSettings } from '../config-layers.js'
import type { GoalOptions, GoalResult } from '../goal.js'
import type { ProviderSelection } from '../provider-setup.js'
import { addUsage } from '../run.js'
import type { TurnResult } from '../run.js'

/** Pure TUI logic, kept out of App.tsx so it can be tested without rendering. */

/** Running totals for the footer status line. */
export interface SessionStats {
  usage?: Usage
  costUsd?: number
  contextTokens?: number
}

/** Add one turn: usage and cost are summed, the context size is the latest turn's. */
export function addTurn(stats: SessionStats, turn: Pick<TurnResult, 'usage' | 'costUsd' | 'contextTokens'>): SessionStats {
  const usage = addUsage(stats.usage, turn.usage)
  const costUsd = stats.costUsd === undefined && turn.costUsd === undefined ? undefined : (stats.costUsd ?? 0) + (turn.costUsd ?? 0)
  const contextTokens = turn.contextTokens ?? stats.contextTokens
  return {
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  }
}

/**
 * Flags for the next run. The in-session provider and model beat -p/-m (CLI-5); a one-off
 * --base-url belongs to the provider it was given with and is dropped after a switch.
 */
export function runFlags(flags: CliFlags, launchProviderId: string, providerId: string, model: string, effort?: CliFlags['effort']): CliFlags {
  // The session's effort (seeded from --effort) replaces the flag, so /effort default can clear it.
  const { baseUrl, effort: _launchEffort, ...rest } = flags
  return {
    ...rest,
    ...(baseUrl && providerId === launchProviderId ? { baseUrl } : {}),
    provider: providerId,
    model,
    ...(effort ? { effort } : {}),
  }
}

/** Model to use after switching to `providerId`: its saved model, else its preset default; never the old provider's. */
export function modelForProvider(cfg: HesdorConfig, providerId: string): string {
  return savedModel(cfg, providerId, false) ?? getPreset(providerId)?.defaultModel ?? 'local-model'
}

/**
 * Enter in the command palette: a bare "/prefix" runs the highlighted command (CLI-12);
 * undefined means run the input as typed (it has arguments, or nothing matches).
 */
export function paletteTarget(input: string, filtered: Array<{ name: string }>, sel: number): string | undefined {
  return /^\/\S*$/.test(input.trim()) ? filtered[sel]?.name : undefined
}

/** Commands that only read state, so they may run while the agent works (CLI-18). */
export const READ_ONLY_COMMANDS = new Set(['help', 'status', 'sessions', 'tools', 'skills', 'plugins', 'config'])

/** Rewinding the chat to a checkpoint: history before that turn, and its prompt to edit and resend. */
export function rewindChat(history: ChatMessage[], checkpoint: { turnIndex: number; prompt: string }): { history: ChatMessage[]; prompt: string } {
  return { history: history.slice(0, checkpoint.turnIndex), prompt: checkpoint.prompt }
}

/**
 * Earlier sessions whose checkpoints still apply after chat rewinds: a rewound session's history is the
 * old one's first `maxTurn` messages, so checkpoints up to that turn index stay valid for it.
 */
export type RewindScope = Array<{ sessionId: string; maxTurn: number }>

/** Scope of the session a chat rewind of `sessionId` to `turnIndex` starts. */
export function scopeAfterRewind(scope: RewindScope, sessionId: string, turnIndex: number): RewindScope {
  return [...scope.map((s) => ({ ...s, maxTurn: Math.min(s.maxTurn, turnIndex) })), { sessionId, maxTurn: turnIndex }]
}

/** Checkpoints /rewind offers: the session's own, plus the earlier sessions' still within its history. */
export function rewindableCheckpoints<C extends { sessionId: string; turnIndex: number }>(all: C[], sessionId: string, scope: RewindScope): C[] {
  return all.filter((c) => c.sessionId === sessionId || scope.some((s) => s.sessionId === c.sessionId && c.turnIndex <= s.maxTurn))
}

/** After /model while a profile picked the main model: the choice lasts this session only (undefined: no note). */
export function profileModelNote(eff: { profile?: { name: string }; sources: Record<string, string> }, model: string): string | undefined {
  if (!eff.profile || eff.sources.provider !== 'profile') return undefined
  const unset = eff.sources.profile === 'user' ? '`hesdor config set profile none` or ' : ''
  return `profile ${eff.profile.name} picks the model at each start: ${model} applies to this session; to keep it, use ${unset}start with -m ${model}`
}

// shortcut: approximate East Asian width table (no string-width dependency); upgrade if emoji/CJK wrapping is off.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u

/** Terminal columns a string occupies. */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
  return w
}

/** Wrap text to `width` columns (words where possible), one entry per terminal row. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width)
  const rows: string[] = []
  for (const para of text.replace(/\r/g, '').replace(/\t/g, '    ').split('\n')) {
    let line = ''
    let lineW = 0
    for (const ch of para) {
      const w = displayWidth(ch)
      if (lineW + w > max && line !== '') {
        const cut = line.lastIndexOf(' ')
        if (ch !== ' ' && cut > 0) {
          rows.push(line.slice(0, cut))
          line = line.slice(cut + 1)
        } else {
          rows.push(line)
          line = ''
        }
        if (ch === ' ' && line === '') {
          lineW = 0
          continue
        }
        lineW = displayWidth(line)
      }
      line += ch
      lineW += w
    }
    rows.push(line)
  }
  return rows
}

/** Why `providerId` cannot be used under managed settings (allow list or a locked provider), else undefined. */
/** Why a session setting cannot be changed here: managed settings lock it. */
export function managedLock(managed: ManagedSettings | undefined, key: 'mode' | 'effort'): string | undefined {
  const locked = managed?.[key]
  return locked === undefined ? undefined : `${key} is locked to "${locked}" by managed settings`
}

export function providerRefusal(managed: ManagedSettings, providerId: string): string | undefined {
  return (
    providerBlocked(managed, providerId) ??
    (managed.provider && managed.provider !== providerId ? `the provider is locked to "${managed.provider}" by managed settings` : undefined)
  )
}

/** One-line reason a run cannot start with this selection (managed settings, then a missing credential). */
export function selectionProblem(managed: ManagedSettings, sel: Pick<ProviderSelection, 'providerId' | 'keySource' | 'envKey'>): string | undefined {
  const refused = providerRefusal(managed, sel.providerId)
  if (refused) return refused
  if (sel.keySource !== 'none') return undefined
  if (sel.providerId === 'chatgpt') return 'not signed in to ChatGPT: pick chatgpt in /provider to sign in'
  return `no API key for ${sel.providerId} — use /provider to add one${sel.envKey ? ` or export ${sel.envKey}` : ''}`
}

/** The prompt a slash command sends: an MCP prompt's own expansion, else the template with $ARGUMENTS filled. */
export function expandCommand(cmd: Pick<CustomCommand, 'template' | 'expand'>, args: string): Promise<string> {
  return cmd.expand ? cmd.expand(args) : Promise.resolve(cmd.template.replace(/\$ARGUMENTS/g, args))
}

export interface Notice {
  text: string
  tone: 'info' | 'error' | 'warn' | 'success'
}

/** Transcript lines for images attached to a prompt. */
export function imageNotices(count: number, model: string, imageInput: boolean | undefined): Notice[] {
  if (count === 0) return []
  return [
    { text: `📎 ${count} image${count === 1 ? '' : 's'} attached`, tone: 'info' },
    ...(imageInput === false ? [{ text: `${model} does not accept images; it only sees a note that they were omitted`, tone: 'warn' as const }] : []),
  ]
}

/** Status line after a turn that did not complete normally (undefined: nothing to add). */
export function turnNotice(result: Pick<TurnResult, 'status' | 'error' | 'errorKind'>, providerId: string, maxBudgetUsd?: number): Notice | undefined {
  if (result.status === 'max_steps') return { text: 'stopped: tool-call budget reached (--max-steps to raise)', tone: 'warn' }
  if (result.status === 'budget_exceeded') return { text: `stopped: cost budget of $${maxBudgetUsd} reached (--max-budget-usd to raise)`, tone: 'warn' }
  if (result.status !== 'failed') return undefined
  const plan = chatgptPlanNotice('chatgpt')!
  if (result.errorKind === 'quota_exhausted' && (providerId === 'chatgpt' || /ChatGPT plan/.test(result.error ?? ''))) {
    return { text: `Usage limit reached · ${plan.linkText}: ${plan.url}`, tone: 'error' }
  }
  return { text: result.error ?? 'run failed', tone: 'error' }
}

/** Final line of a /goal run. */
export function goalNotice(goal: Pick<GoalResult, 'status' | 'reason' | 'turns'>): Notice {
  const turns = `${goal.turns} turn${goal.turns === 1 ? '' : 's'}`
  switch (goal.status) {
    case 'met':
      return { text: `goal met after ${turns}: ${goal.reason}`, tone: 'success' }
    case 'impossible':
      return { text: `goal impossible after ${turns}: ${goal.reason}`, tone: 'warn' }
    case 'max_turns':
      return { text: goal.reason, tone: 'warn' }
    case 'cancelled':
      return { text: `goal cancelled after ${turns}`, tone: 'warn' }
    default:
      return { text: `goal stopped (${goal.status}) after ${turns}: ${goal.reason}`, tone: 'error' }
  }
}

/**
 * A turn function for runGoal (and single prompts): each call continues `history` and stores the turn's
 * messages back, then calls `after`. `first` is true only for the first call (images go with it).
 */
export function continuingTurn(
  run: (prompt: string, history: ChatMessage[], emit: (event: RunEvent) => void, first: boolean) => Promise<TurnResult>,
  history: { current: ChatMessage[] },
  after: (result: TurnResult) => void = () => {},
): GoalOptions['turn'] {
  let first = true
  return async (prompt, emit) => {
    const result = await run(prompt, history.current, emit, first)
    first = false
    history.current = result.messages.filter((m) => m.role !== 'system')
    after(result)
    return result
  }
}

// ── MCP elicitation forms ─────────────────────────────────────────────────

export interface FormField {
  key: string
  label: string
  description?: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum'
  required: boolean
  /** enum and boolean: the choices; '' means "no answer" (optional fields only). */
  options?: Array<{ value: string; label: string }>
  /** Text the field starts with (the schema default). */
  initial: string
  /** Number range, or string length range. */
  min?: number
  max?: number
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Form fields for an elicitation `requestedSchema`; `unsupported` lists fields the form cannot show (multi-select). */
export function formFields(schema: unknown): { fields: FormField[]; unsupported: Array<{ key: string; required: boolean }> } {
  const s = (schema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: unknown }
  const required = new Set(Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string') : [])
  const fields: FormField[] = []
  const unsupported: Array<{ key: string; required: boolean }> = []
  for (const [key, p] of Object.entries(s.properties ?? {})) {
    if (!p || typeof p !== 'object') continue
    const description = str(p.description)
    const base = { key, label: str(p.title) ?? key, ...(description ? { description } : {}), required: required.has(key) }
    const none = base.required ? [] : [{ value: '', label: '(no answer)' }]
    const dflt = p.default
    const range = (lo: unknown, hi: unknown): { min?: number; max?: number } => ({
      ...(num(lo) !== undefined ? { min: num(lo)! } : {}),
      ...(num(hi) !== undefined ? { max: num(hi)! } : {}),
    })
    if (p.type === 'string' && (Array.isArray(p.enum) || Array.isArray(p.oneOf))) {
      const names: unknown[] = Array.isArray(p.enumNames) ? p.enumNames : []
      const options = Array.isArray(p.enum)
        ? p.enum.filter((v): v is string => typeof v === 'string').map((v, i) => ({ value: v, label: str(names[i]) ?? v }))
        : (p.oneOf as Array<{ const?: unknown; title?: unknown } | null>)
            .filter((o) => typeof o?.const === 'string')
            .map((o) => ({ value: o!.const as string, label: str(o!.title) ?? (o!.const as string) }))
      fields.push({ ...base, kind: 'enum', options: [...none, ...options], initial: str(dflt) ?? '' })
    } else if (p.type === 'boolean') {
      const options = [...none, { value: 'true', label: 'yes' }, { value: 'false', label: 'no' }]
      fields.push({ ...base, kind: 'boolean', options, initial: typeof dflt === 'boolean' ? String(dflt) : '' })
    } else if (p.type === 'number' || p.type === 'integer') {
      fields.push({ ...base, kind: p.type, initial: num(dflt) !== undefined ? String(dflt) : '', ...range(p.minimum, p.maximum) })
    } else if (p.type === 'string') {
      fields.push({ ...base, kind: 'string', initial: str(dflt) ?? '', ...range(p.minLength, p.maxLength) })
    } else {
      unsupported.push({ key, required: base.required })
    }
  }
  return { fields, unsupported }
}

/** Typed value for one field's text, or why it is invalid. An empty optional field is left out (undefined). */
export function coerceField(field: FormField, raw: string): { ok: true; value: string | number | boolean | undefined } | { ok: false; error: string } {
  const text = field.kind === 'string' ? raw : raw.trim()
  if (text.trim() === '') return field.required ? { ok: false, error: `${field.label} is required` } : { ok: true, value: undefined }
  if (field.options) {
    const hit = field.options.find((o) => o.value !== '' && (o.value === text || o.label.toLowerCase() === text.toLowerCase()))
    if (!hit) return { ok: false, error: `${field.label} must be one of ${field.options.filter((o) => o.value !== '').map((o) => o.label).join(', ')}` }
    return { ok: true, value: field.kind === 'boolean' ? hit.value === 'true' : hit.value }
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    const n = Number(text)
    if (!Number.isFinite(n)) return { ok: false, error: `${field.label} must be a number` }
    if (field.kind === 'integer' && !Number.isInteger(n)) return { ok: false, error: `${field.label} must be a whole number` }
    if (field.min !== undefined && n < field.min) return { ok: false, error: `${field.label} must be at least ${field.min}` }
    if (field.max !== undefined && n > field.max) return { ok: false, error: `${field.label} must be at most ${field.max}` }
    return { ok: true, value: n }
  }
  if (field.min !== undefined && text.length < field.min) return { ok: false, error: `${field.label} needs at least ${field.min} characters` }
  if (field.max !== undefined && text.length > field.max) return { ok: false, error: `${field.label} allows at most ${field.max} characters` }
  return { ok: true, value: text }
}

/** The accepted form's content, or the first field error. */
export function formContent(
  fields: FormField[],
  values: Record<string, string>,
): { ok: true; content: Record<string, string | number | boolean> } | { ok: false; error: string } {
  const content: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const r = coerceField(field, values[field.key] ?? '')
    if (!r.ok) return r
    if (r.value !== undefined) content[field.key] = r.value
  }
  return { ok: true, content }
}
