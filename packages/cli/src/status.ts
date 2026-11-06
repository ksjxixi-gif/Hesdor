import type { ModelInfo } from '@hesdor/providers'
import type { Usage } from '@hesdor/protocol'

export interface StatusInput {
  /** Session usage (sum of runs); its cache share is shown. */
  usage?: Usage
  /** Session cost in USD (sum of TurnResult.costUsd). */
  costUsd?: number
  /** TurnResult.contextTokens of the latest turn. */
  contextTokens?: number
  /** getModelInfo(providerId, model) for the current model. */
  info?: ModelInfo
}

/** Footer summary like "ctx 34% · $0.12 · cache 81%"; parts without data are left out ('' when none). */
export function formatStatus({ usage, costUsd, contextTokens, info }: StatusInput): string {
  const parts: string[] = []
  if (contextTokens !== undefined && info?.contextWindow) {
    parts.push(`ctx ${Math.min(100, Math.round((contextTokens / info.contextWindow) * 100))}%`)
  }
  if (costUsd !== undefined) parts.push(formatUsd(costUsd))
  if (usage?.cacheReadTokens !== undefined && usage.inputTokens) {
    parts.push(`cache ${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}%`)
  }
  return parts.join(' · ')
}

/** $0.12, or three decimals below ten cents so small runs do not read as $0.00. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}
