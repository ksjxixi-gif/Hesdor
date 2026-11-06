import { describe, expect, it } from 'vitest'
import { formatStatus, formatUsd } from './status.js'

describe('formatStatus', () => {
  const info = { id: 'm', contextWindow: 200_000, toolCall: true, reasoning: false, imageInput: false }

  it('shows context share, cost and cache hit rate', () => {
    const usage = { inputTokens: 10_000, cacheReadTokens: 8_100, outputTokens: 500, ready: true }
    expect(formatStatus({ usage, costUsd: 0.1234, contextTokens: 68_000, info })).toBe('ctx 34% · $0.12 · cache 81%')
  })

  it('leaves out parts without data', () => {
    expect(formatStatus({ costUsd: 0.004 })).toBe('$0.004')
    expect(formatStatus({ contextTokens: 5, usage: { inputTokens: 0 } })).toBe('')
  })

  it('formats small and large amounts', () => {
    expect(formatUsd(0)).toBe('$0.000')
    expect(formatUsd(12.345)).toBe('$12.35')
  })
})
