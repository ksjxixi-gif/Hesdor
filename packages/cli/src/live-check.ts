import readline from 'node:readline/promises'
import { getModelInfo, getPreset, joinUrl, PROVIDER_PRESETS, ProviderError, requestCostUsd } from '@hesdor/providers'
import type { ModelInfo, ModelProvider } from '@hesdor/providers'
import type { ChatMessage, ProviderErrorKind, ToolCallRequest, ToolSpec, Usage } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import { loadEffectiveConfig, providerBlocked } from './config-layers.js'
import { createSelectedProvider, resolveSelection } from './provider-setup.js'
import type { ProviderSelection } from './provider-setup.js'

/** `hesdor doctor --live` and `pnpm test:live`: a few tiny real requests per configured provider. */

export const REQUEST_TIMEOUT_MS = 60_000
/** Requests per provider in liveCheck: one plain stream, then a tool call and its follow-up. */
const REQUESTS = 3
/** Generous per-request input bound for the estimate (system prompt + tool spec + wire overhead). */
const EST_INPUT_TOKENS = 1000
/** Plans whose terms forbid automated use: tested only when named with --provider. */
const SWEEP_SKIP = new Set(['qwen-coding-plan'])

export const GET_TIME: ToolSpec = {
  name: 'get_time',
  description: 'Returns the current UTC time. Takes no arguments.',
  parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
}
const SYSTEM = 'You are a connection check for a coding agent. Be extremely brief.'

export interface LiveTarget {
  selection: ProviderSelection
  info?: ModelInfo
  maxTokens: number
}

export interface LiveResult {
  provider: string
  model: string
  ok: boolean
  /** Which step failed: stream, tool_call, tool_result, or setup. */
  failedStep?: string
  errorKind?: ProviderErrorKind
  error?: string
  hint?: string
  /** First chunk of the plain stream request. */
  firstTokenMs?: number
  totalMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  usageReported: boolean
  cacheFieldsReported: boolean
  /** Reasoning text or adapter state came back on the tool-call turn and was sent back with the tool result. */
  reasoningReplayed: boolean
  /** undefined when no price is known; 0 for local servers and the ChatGPT plan. */
  costUsd?: number
  reply?: string
}

/** Output cap per request: tiny for plain models, room for a little thinking otherwise. */
export const maxTokensFor = (info: ModelInfo | undefined): number => (info && !info.reasoning ? 256 : 1024)

const free = (sel: ProviderSelection): boolean => sel.providerId === 'chatgpt' || (sel.keySource === 'not-required' && !sel.apiKey)

/** Worst-case USD for liveCheck on one target; 0 when free, undefined when the price is unknown. */
export function estimateUsd(t: LiveTarget, requests = REQUESTS): number | undefined {
  if (free(t.selection)) return 0
  const c = t.info?.cost
  return c ? (requests * (EST_INPUT_TOKENS * c.input + t.maxTokens * c.output)) / 1e6 : undefined
}

/**
 * Providers with a usable credential: env or saved key, apiKeyCommand, or ChatGPT sign-in. Keyless
 * (local or custom) endpoints count only when something answers at their base URL.
 */
export async function liveTargets(flags: CliFlags, cfg: HesdorConfig, managed: { allowedProviders?: string[] } = {}): Promise<LiveTarget[]> {
  const ids = flags.provider
    ? [flags.provider]
    : [...PROVIDER_PRESETS.map((p) => p.id), ...Object.keys(cfg.customProviders ?? {})].filter((id) => !SWEEP_SKIP.has(id))
  const targets: LiveTarget[] = []
  for (const id of ids) {
    if (!flags.provider && providerBlocked(managed, id)) continue
    // --model only makes sense for the one provider named with --provider.
    const { model: _model, ...rest } = flags
    let selection: ProviderSelection
    try {
      selection = await resolveSelection({ ...(flags.provider ? flags : rest), provider: id }, cfg)
    } catch {
      continue
    }
    if (selection.keySource === 'none') continue
    if (selection.keySource === 'not-required') {
      const base = selection.baseUrl ?? getPreset(id)?.baseUrl
      if (!base || !(await reachable(base))) continue
    }
    const info = getModelInfo(id, selection.model)
    targets.push({ selection, ...(info ? { info } : {}), maxTokens: maxTokensFor(info) })
  }
  return targets
}

/** Anything answering HTTP at the base URL (a 404 too) counts; costs nothing. */
async function reachable(base: string): Promise<boolean> {
  try {
    await fetch(joinUrl(base, '/models'), { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

export interface Turn {
  text: string
  reasoning: string
  providerState: unknown
  toolCalls: ToolCallRequest[]
  finishReason?: string
  usage?: Usage
  firstChunkMs?: number
}

/** One streamed request, collected the way the agent loop collects it. */
export async function streamTurn(provider: ModelProvider, messages: ChatMessage[], tools: ToolSpec[], timeoutMs = REQUEST_TIMEOUT_MS, cacheKey?: string): Promise<Turn> {
  const start = performance.now()
  const turn: Turn = { text: '', reasoning: '', providerState: undefined, toolCalls: [] }
  const calls = new Map<number, ToolCallRequest>()
  for await (const chunk of provider.stream(messages, tools, AbortSignal.timeout(timeoutMs), cacheKey ? { cacheKey } : undefined)) {
    turn.firstChunkMs ??= Math.round(performance.now() - start)
    if (chunk.type === 'text') turn.text += chunk.text
    else if (chunk.type === 'reasoning') turn.reasoning += chunk.text
    else if (chunk.type === 'provider_state') turn.providerState = chunk.state
    else if (chunk.type === 'tool_call') {
      const call = calls.get(chunk.index) ?? { id: '', name: '', argumentsJson: '' }
      if (chunk.id) call.id = chunk.id
      if (chunk.name) call.name = chunk.name
      call.argumentsJson += chunk.argumentsDelta
      calls.set(chunk.index, call)
    } else if (chunk.type === 'finish') {
      turn.finishReason = chunk.reason
      if (chunk.usage) turn.usage = chunk.usage
    }
  }
  turn.toolCalls = [...calls.values()]
  return turn
}

class StepError extends Error {}

/** The three liveCheck requests. Never throws: failures are classified into the result. */
export async function liveCheck(provider: ModelProvider, target: LiveTarget, timeoutMs = REQUEST_TIMEOUT_MS): Promise<LiveResult> {
  const { selection, info } = target
  const start = performance.now()
  const r: LiveResult = {
    provider: selection.providerId,
    model: provider.model,
    ok: false,
    totalMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageReported: false,
    cacheFieldsReported: false,
    reasoningReplayed: false,
    ...(free(selection) ? { costUsd: 0 } : {}),
  }
  let step = 'stream'
  const run = async (messages: ChatMessage[], tools: ToolSpec[]): Promise<Turn> => {
    const turn = await streamTurn(provider, messages, tools, timeoutMs)
    const u = turn.usage
    if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) r.usageReported = true
    r.inputTokens += u?.inputTokens ?? 0
    r.outputTokens += u?.outputTokens ?? 0
    if (u?.cacheReadTokens !== undefined || u?.cacheWriteTokens !== undefined) {
      r.cacheFieldsReported = true
      r.cacheReadTokens = (r.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0)
      r.cacheWriteTokens = (r.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
    }
    if (!free(selection)) {
      const cost = requestCostUsd(u, info)
      if (cost !== undefined) r.costUsd = (r.costUsd ?? 0) + cost
    }
    if (turn.finishReason === 'length') throw new StepError(`stopped at the ${target.maxTokens}-token output cap before finishing`)
    return turn
  }
  try {
    const first = await run([{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Reply with the word ok and nothing else.' }], [])
    if (first.firstChunkMs !== undefined) r.firstTokenMs = first.firstChunkMs
    if (!first.text.trim()) throw new StepError('the reply had no text')

    step = 'tool_call'
    const ask: ChatMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Call the get_time tool, then tell me the time it returns.' }]
    const call = await run(ask, [GET_TIME])
    const tc = call.toolCalls[0]
    if (!tc || tc.name !== GET_TIME.name) throw new StepError(`expected a get_time tool call, got ${tc ? `"${tc.name}"` : `text: ${JSON.stringify(call.text.slice(0, 80))}`}`)
    r.reasoningReplayed = call.reasoning !== '' || call.providerState !== undefined

    step = 'tool_result'
    const assistant: ChatMessage = {
      role: 'assistant',
      content: call.text,
      toolCalls: call.toolCalls,
      ...(call.reasoning ? { reasoning: call.reasoning } : {}),
      ...(call.providerState !== undefined ? { providerState: call.providerState } : {}),
    }
    const results: ChatMessage[] = call.toolCalls.map((c) => ({ role: 'tool_result', toolCallId: c.id, content: '12:34 UTC' }))
    const final = await run([...ask, assistant, ...results], [GET_TIME])
    if (!final.text.trim()) throw new StepError('no answer after the tool result')
    r.reply = final.text.trim().slice(0, 120)
    r.ok = true
  } catch (err) {
    r.failedStep = step
    if (err instanceof ProviderError) {
      const [message, hint] = err.message.split('\nhint: ')
      r.errorKind = err.kind
      r.error = message!.slice(0, 300)
      if (hint) r.hint = hint
    } else if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      r.errorKind = 'network'
      r.error = `no complete answer within ${timeoutMs / 1000} s`
    } else {
      if (!(err instanceof StepError)) r.errorKind = 'unknown'
      r.error = err instanceof Error ? err.message : String(err)
    }
  }
  r.totalMs = Math.round(performance.now() - start)
  return r
}

const usd = (n: number | undefined): string => (n === undefined ? 'unknown' : n === 0 ? '$0' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`)

/** Markdown table shared by doctor --live (text output) and the test:live report. */
export function liveTable(results: LiveResult[]): string {
  const rows = results.map((r) => {
    const status = r.ok ? 'ok' : `failed at ${r.failedStep}${r.errorKind ? `: ${r.errorKind}` : ''}`
    const cache = r.cacheFieldsReported ? `read ${r.cacheReadTokens ?? 0} / write ${r.cacheWriteTokens ?? 0}` : 'not reported'
    const latency = `${r.firstTokenMs !== undefined ? `${r.firstTokenMs} ms first / ` : ''}${r.totalMs} ms all`
    const tokens = r.usageReported ? `${r.inputTokens} in / ${r.outputTokens} out` : 'not reported'
    return `| ${r.provider} | ${r.model} | ${status} | ${latency} | ${tokens} | ${cache} | ${r.reasoningReplayed ? 'yes' : 'no'} | ${usd(r.costUsd)} |`
  })
  const notes = results.filter((r) => !r.ok).map((r) => `- ${r.provider}: ${r.error}${r.hint ? `\n  hint: ${r.hint}` : ''}`)
  return [
    '| Provider | Model | Result | Latency | Tokens | Cache | Reasoning replayed | Cost |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n')
}

/** `hesdor doctor --live [--provider <id>] [--yes] [--output-format json]`. */
export async function runDoctorLive(flags: CliFlags): Promise<number> {
  const json = flags.outputFormat === 'json'
  // In JSON mode stdout holds only the result object.
  const say = json ? console.error : console.log
  const { config, managed } = await loadEffectiveConfig(flags, {})
  const targets = await liveTargets(flags, config, managed)
  if (targets.length === 0) {
    say(flags.provider ? `✗ ${flags.provider}: no usable credential or reachable server — run \`hesdor doctor\`` : '✗ no provider has a usable credential — run `hesdor setup`')
    return 1
  }
  const estimates = targets.map((t) => estimateUsd(t))
  say(`Live check: ${REQUESTS} small requests per provider (output capped at 256-1024 tokens, ${REQUEST_TIMEOUT_MS / 1000} s timeout each), one provider at a time.`)
  targets.forEach((t, i) => {
    const e = estimates[i]
    const label = t.selection.providerId === 'chatgpt' ? 'ChatGPT plan usage, no API billing' : estimates[i] === 0 ? 'local or keyless, free' : `at most ${usd(e)}`
    say(`  ${t.selection.providerId.padEnd(18)} ${t.selection.model.padEnd(28)} ${label}`)
  })
  const known = estimates.reduce<number>((a, e) => a + (e ?? 0), 0)
  say(`Estimated total: at most ${usd(known)}${estimates.includes(undefined) ? ' plus providers with unknown prices' : ''}.`)

  if (!flags.yes) {
    if (!process.stdin.isTTY || json) {
      say('Re-run with --yes to send these requests.')
      return 1
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('Proceed? [y/N] ')
    rl.close()
    if (!/^y(es)?$/i.test(answer.trim())) return 1
  }

  const results: LiveResult[] = []
  for (const t of targets) {
    if (!json) process.stdout.write(`… ${t.selection.providerId} `)
    let result: LiveResult
    try {
      result = await liveCheck(createSelectedProvider({ ...t.selection, maxTokens: t.maxTokens }), t)
    } catch (err) {
      // createProvider refused (missing base URL, policy): nothing was sent.
      result = { provider: t.selection.providerId, model: t.selection.model, ok: false, failedStep: 'setup', errorKind: 'bad_request', error: err instanceof Error ? err.message : String(err), totalMs: 0, inputTokens: 0, outputTokens: 0, usageReported: false, cacheFieldsReported: false, reasoningReplayed: false }
    }
    results.push(result)
    if (!json) console.log(result.ok ? '✓' : '✗')
  }
  const totalCost = results.reduce<number>((a, r) => a + (r.costUsd ?? 0), 0)
  if (json) console.log(JSON.stringify({ ok: results.every((r) => r.ok), estimatedMaxUsd: known, costUsd: totalCost, results }, null, 2))
  else console.log(`\n${liveTable(results)}\n\nActual cost: ${usd(totalCost)} (catalog prices).`)
  return results.every((r) => r.ok) ? 0 : 1
}
