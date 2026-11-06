import { describe, expect, it } from 'vitest'
import { contextWindowFor, getModelInfo, requestCostUsd } from './catalog.js'
import type { ModelInfo } from './catalog.js'

describe('getModelInfo', () => {
  it('finds an exact id with limits, prices and capabilities', () => {
    const info = getModelInfo('anthropic', 'claude-sonnet-5-5')
    expect(info?.id).toBe('claude-sonnet-5-5')
    expect(info?.contextWindow).toBeGreaterThan(0)
    expect(info?.maxOutput).toBeGreaterThan(0)
    expect(info?.cost?.input).toBeGreaterThan(0)
    expect(info?.cost?.cacheRead).toBeLessThan(info!.cost!.input)
    expect(info).toMatchObject({ toolCall: true, imageInput: true })
    expect(contextWindowFor('anthropic', 'claude-sonnet-5-5')).toBe(info?.contextWindow)
  })

  it('matches case-insensitively and without a vendor prefix on either side', () => {
    expect(getModelInfo('nebius', 'zai-org/glm-5.3')?.id).toBe('zai-org/GLM-5.3')
    expect(getModelInfo('openrouter', 'claude-sonnet-5.5')?.id).toBe('anthropic/claude-sonnet-5.5')
    expect(getModelInfo('anthropic', 'anthropic/claude-sonnet-5-5')?.id).toBe('claude-sonnet-5-5')
  })

  it('returns undefined for unknown models and providers without a catalog', () => {
    expect(getModelInfo('anthropic', 'no-such-model')).toBeUndefined()
    expect(getModelInfo('ollama', 'qwen2.5-coder:7b')).toBeUndefined()
    expect(contextWindowFor('custom-gateway', 'x')).toBeUndefined()
  })
})

describe('requestCostUsd', () => {
  const info: ModelInfo = {
    id: 'm',
    toolCall: true,
    reasoning: false,
    imageInput: false,
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, longContext: { above: 2_000_000, input: 4, output: 15, cacheRead: 0.2 } },
  }

  it('prices fresh input, cache reads, cache writes and output separately', () => {
    // 300k fresh * $2 + 600k read * $0.1 + 100k write * $2.5 + 100k out * $10 = 0.6 + 0.06 + 0.25 + 1.0
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000, outputTokens: 100_000, ready: true }
    expect(requestCostUsd(usage, info)).toBeCloseTo(1.91, 10)
  })

  it('uses long-context rates above the tier threshold', () => {
    expect(requestCostUsd({ inputTokens: 3_000_000, outputTokens: 0 }, info)).toBeCloseTo(12, 10)
  })

  it('prefers the cost the provider reported', () => {
    expect(requestCostUsd({ inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.42 }, info)).toBe(0.42)
    expect(requestCostUsd({ costUsd: 0.42 }, undefined)).toBe(0.42)
  })

  it('is undefined without prices', () => {
    expect(requestCostUsd({ inputTokens: 10, outputTokens: 1 }, { ...info, cost: undefined })).toBeUndefined()
    expect(requestCostUsd(undefined, info)).toBeUndefined()
  })
})
