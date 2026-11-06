import { describe, expect, it } from 'vitest'
import { getPreset, PROVIDER_PRESETS } from './presets.js'

const keyNames = (p: (typeof PROVIDER_PRESETS)[number]): string[] => [
  ...(p.envKey ? [p.envKey] : []),
  ...(p.envKeys ?? []),
]

describe('PROVIDER_PRESETS', () => {
  it('has unique ids that getPreset finds', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(getPreset(id)?.id).toBe(id)
  })

  it('gives every hosted preset an https endpoint and a key variable', () => {
    for (const p of PROVIDER_PRESETS.filter((p) => p.requiresApiKey)) {
      expect(p.baseUrl?.startsWith('https://') || !!p.baseUrlEnvKey, p.id).toBe(true)
      expect(p.envKey, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('only allows plain http for local endpoints', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.baseUrl?.startsWith('http://')) {
        expect(p.requiresApiKey, p.id).toBe(false)
        expect(new URL(p.baseUrl).hostname, p.id).toMatch(/^(localhost|127\.0\.0\.1)$/)
      }
    }
  })

  it('has a non-empty default model', () => {
    for (const p of PROVIDER_PRESETS) expect(p.defaultModel.trim(), p.id).not.toBe('')
  })

  it('never reuses one preset key variable as another preset alternate', () => {
    const primaries = new Map(PROVIDER_PRESETS.filter((p) => p.envKey).map((p) => [p.envKey, p.id]))
    for (const p of PROVIDER_PRESETS) {
      const names = keyNames(p)
      expect(new Set(names).size, p.id).toBe(names.length)
      for (const alt of p.envKeys ?? []) {
        expect(alt, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(primaries.get(alt), `${p.id} alternate ${alt}`).toBeUndefined()
      }
    }
  })

  it('sends OpenRouter attribution headers', () => {
    expect(getPreset('openrouter')?.headers).toEqual({
      'HTTP-Referer': 'https://github.com/ksjxixi-gif/Hesdor',
      'X-OpenRouter-Title': 'Hesdor',
    })
  })
})
