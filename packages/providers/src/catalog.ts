import type { ChatImage, ChatMessage, Usage } from '@hesdor/protocol'
import snapshot from './catalog.json' with { type: 'json' }

/** Model metadata from the bundled models.dev snapshot (regenerate with `node scripts/update-catalog.mjs`). */
export interface ModelInfo {
  /** The catalog id that matched. */
  id: string
  contextWindow?: number
  maxOutput?: number
  /** USD per million tokens; absent when models.dev lists no price. */
  cost?: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    /** Higher rates for a request whose input exceeds `above` tokens. */
    longContext?: { above: number; input: number; output: number; cacheRead?: number }
  }
  toolCall: boolean
  reasoning: boolean
  imageInput: boolean
  releaseDate?: string
  status?: 'deprecated' | 'beta'
}

type Price = number | null
type Row = [Price, Price, Price, Price, Price, Price, string, string | null, [number, Price, Price, Price]?]
const providers = (snapshot as unknown as { providers: Record<string, Record<string, Row>> }).providers

const bare = (id: string): string => id.slice(id.lastIndexOf('/') + 1).toLowerCase()

/**
 * Looks up a model for a Hesdor provider id: exact id, then case-insensitive, then the id without its
 * vendor prefix on either side (`anthropic/claude-sonnet-5.5` ~ `claude-sonnet-5.5`).
 */
export function getModelInfo(providerId: string, modelId: string): ModelInfo | undefined {
  const models = providers[providerId]
  if (!models) return undefined
  let key: string | undefined = modelId in models ? modelId : undefined
  const keys = Object.keys(models)
  key ??= keys.find((k) => k.toLowerCase() === modelId.toLowerCase())
  key ??= keys.find((k) => bare(k) === bare(modelId))
  return key ? toInfo(key, models[key] as Row) : undefined
}

/**
 * A message's text and images as an adapter should send them. For a model the catalog marks as
 * text-only (`imageInput === false`) the images are dropped and the text says so, instead of the
 * request failing; unknown models get the images.
 */
export function imagesFor(m: ChatMessage, imageInput: boolean | undefined): { text: string; images: ChatImage[] } {
  const images = m.images ?? []
  if (images.length === 0 || imageInput !== false) return { text: m.content, images }
  const note = `[${images.length} image${images.length === 1 ? '' : 's'} omitted: the current model does not accept image input]`
  return { text: m.content ? `${m.content}\n${note}` : note, images: [] }
}

/** Context window in tokens for the model, when the catalog knows it. */
export function contextWindowFor(providerId: string, modelId: string): number | undefined {
  return getModelInfo(providerId, modelId)?.contextWindow
}

function toInfo(id: string, [context, output, input, out, cacheRead, cacheWrite, flags, release, tier]: Row): ModelInfo {
  const info: ModelInfo = { id, toolCall: flags.includes('t'), reasoning: flags.includes('r'), imageInput: flags.includes('i') }
  if (context) info.contextWindow = context
  if (output) info.maxOutput = output
  if (input !== null && out !== null) {
    info.cost = { input, output: out }
    if (cacheRead !== null) info.cost.cacheRead = cacheRead
    if (cacheWrite !== null) info.cost.cacheWrite = cacheWrite
    if (tier && tier[1] !== null && tier[2] !== null) {
      info.cost.longContext = { above: tier[0], input: tier[1], output: tier[2], ...(tier[3] !== null ? { cacheRead: tier[3] } : {}) }
    }
  }
  if (release) info.releaseDate = release
  if (flags.includes('d')) info.status = 'deprecated'
  else if (flags.includes('b')) info.status = 'beta'
  return info
}

/**
 * USD cost of one model request. A cost the provider reported itself (`usage.costUsd`, e.g. OpenRouter)
 * wins; otherwise catalog prices. Cache reads and writes are priced separately from the rest of the input.
 * Undefined when neither is known.
 */
export function requestCostUsd(usage: Usage | undefined, info: ModelInfo | undefined): number | undefined {
  if (typeof usage?.costUsd === 'number') return usage.costUsd
  if (!usage || !info?.cost) return undefined
  const input = usage.inputTokens ?? 0
  const long = info.cost.longContext && input > info.cost.longContext.above ? info.cost.longContext : undefined
  const p = { ...info.cost, ...long }
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const fresh = Math.max(0, input - cacheRead - cacheWrite)
  return (
    (fresh * p.input + cacheRead * (p.cacheRead ?? p.input) + cacheWrite * (p.cacheWrite ?? p.input) + (usage.outputTokens ?? 0) * p.output) /
    1e6
  )
}
