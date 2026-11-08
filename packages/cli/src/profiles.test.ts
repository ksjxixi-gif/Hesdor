import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getModelInfo, getPreset, PROVIDER_PRESETS } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import { saveCredential } from './auth.js'
import type { HesdorConfig } from './config.js'
import { mergeLayers, providerBlocked } from './config-layers.js'
import type { Layer } from './config-layers.js'
import { applyProfile, PROFILES } from './profiles.js'
import type { ProfileContext } from './profiles.js'
import { presetEnvKeys } from './provider-setup.js'

// Saved keys and the ChatGPT sign-in live under the config dir: start from an empty one.
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-profiles-'))
const KEY_VARS = PROVIDER_PRESETS.flatMap(presetEnvKeys)
const savedEnv = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]))
beforeEach(() => {
  for (const k of KEY_VARS) delete process.env[k]
})
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v
})

const NO_FLAGS: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }
const open: ProfileContext = { explicitMain: false, blocked: () => undefined }

async function resolve(config: HesdorConfig, ctx: ProfileContext = open) {
  const eff = { config: structuredClone(config), flags: NO_FLAGS, sources: {} as Record<string, Layer> }
  const res = await applyProfile(eff, ctx)
  return { ...res, config: eff.config, sources: eff.sources }
}

describe('profile candidates', () => {
  it('are catalog models with tool calling and prices, on known presets', () => {
    const specs = new Set(Object.values(PROFILES).flatMap((p) => [...p.main, ...p.small, ...p.oracle, ...p.escalate.flatMap((e) => e.specs)]))
    for (const spec of specs) {
      const provider = spec.slice(0, spec.indexOf('/'))
      const model = spec.slice(spec.indexOf('/') + 1)
      expect(getPreset(provider), spec).toBeDefined()
      // ChatGPT plan models are the OpenAI API models (billed to the plan, so no price applies there).
      const info = getModelInfo(provider === 'chatgpt' ? 'openai' : provider, model)
      expect(info?.id, spec).toBe(model)
      expect(info?.toolCall, spec).toBe(true)
      expect(info?.cost, spec).toBeDefined()
    }
  })
})

describe('applyProfile', () => {
  it('economy picks the first candidate with a key', async () => {
    process.env.ZAI_API_KEY = 'z'
    let r = await resolve({ profile: 'economy' })
    expect(r.config.provider).toBe('zai')
    expect(r.config.models?.zai).toBe('glm-5.3-flash')
    expect(r.sources.provider).toBe('profile')
    expect(r.lines).toContain('main: zai/glm-5.3-flash (ZAI_API_KEY set)')
    process.env.DEEPSEEK_API_KEY = 'd'
    r = await resolve({ profile: 'economy' })
    expect(r.config.provider).toBe('deepseek')
    // Fallback: the next keyed candidate from another vendor.
    expect(r.config.roles?.fallback).toEqual(['zai/glm-5.3-flash'])
  })

  it('counts a key saved by hesdor setup', async () => {
    await saveCredential('minimax', 'm')
    try {
      const r = await resolve({ profile: 'economy' })
      expect(r.config.provider).toBe('minimax')
      expect(r.lines).toContain('main: minimax/MiniMax-M3.1-Flash (key saved by hesdor setup)')
    } finally {
      await saveCredential('minimax', '')
    }
  })

  it('fills small, oracle and the escalation ladder from the keys you have', async () => {
    process.env.DEEPSEEK_API_KEY = 'd'
    process.env.ANTHROPIC_API_KEY = 'a'
    const r = await resolve({ profile: 'economy' })
    expect(r.config.models?.deepseek).toBe('deepseek-flash')
    expect(r.config.roles).toEqual({
      small: 'deepseek/deepseek-flash',
      oracle: 'anthropic/claude-opus-5-5',
      fallback: ['anthropic/claude-haiku-5-5'],
      escalation: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'],
    })
    expect(r.warnings).toEqual([])
    // balanced escalates once, frontier never.
    expect((await resolve({ profile: 'balanced' })).config.roles?.escalation).toEqual(['anthropic/claude-opus-5-5'])
    expect((await resolve({ profile: 'frontier' })).config.roles?.escalation).toBeUndefined()
    expect((await resolve({ profile: 'economy', escalate: false })).config.roles?.escalation).toBeUndefined()
  })

  it('says which keys would enable a tier that has none', async () => {
    process.env.DEEPSEEK_API_KEY = 'd'
    const r = await resolve({ profile: 'economy' })
    // No frontier key: no oracle and only the balanced step on the ladder (deepseek's own stronger model).
    expect(r.config.roles?.oracle).toBeUndefined()
    expect(r.config.roles?.escalation).toEqual(['deepseek/deepseek-v4-pro'])
    expect(r.lines.find((l) => l.startsWith('oracle:'))).toMatch(/no candidate has a key; set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY/)
    expect(r.lines.find((l) => l.startsWith('escalation to frontier:'))).toMatch(/ANTHROPIC_API_KEY/)

    delete process.env.DEEPSEEK_API_KEY
    const none = await resolve({ profile: 'economy', provider: 'openai' })
    expect(none.config.provider).toBe('openai')
    expect(none.warnings[0]).toMatch(/^profile economy: no candidate has a key; set DEEPSEEK_API_KEY, ZAI_API_KEY/)
  })

  it('leaves an explicit -p/-m and explicit roles alone', async () => {
    process.env.DEEPSEEK_API_KEY = 'd'
    const r = await resolve({ profile: 'economy', provider: 'openai', roles: { small: 'openai/gpt-5-nano' } }, { ...open, explicitMain: true })
    expect(r.config.provider).toBe('openai')
    expect(r.config.models).toBeUndefined()
    expect(r.config.roles?.small).toBe('openai/gpt-5-nano')
    expect(r.lines).toContain('small: roles.small from config.json')
    expect(r.lines.some((l) => l.startsWith('main: set by -p/-m'))).toBe(true)
  })

  it('respects the managed provider allowlist and provider lock', async () => {
    process.env.DEEPSEEK_API_KEY = 'd'
    process.env.ZAI_API_KEY = 'z'
    process.env.ANTHROPIC_API_KEY = 'a'
    const managed = { allowedProviders: ['zai'] }
    const r = await resolve({ profile: 'economy' }, { ...open, blocked: (id) => providerBlocked(managed, id) })
    expect(r.config.provider).toBe('zai')
    expect(r.config.roles?.oracle).toBeUndefined()
    expect(r.config.roles?.escalation).toEqual(['zai/glm-5.3'])
    const locked = await resolve({ profile: 'economy' }, { ...open, lockedProvider: 'zai' })
    expect(locked.config.provider).toBe('zai')
    expect(locked.config.roles?.escalation).toEqual(['zai/glm-5.3'])
  })
})

describe('profile layers', () => {
  it('comes from flag, env or user config, never from a project; managed settings lock it', () => {
    expect(mergeLayers({ user: { profile: 'frontier' }, env: { HESDOR_PROFILE: 'balanced' }, flags: { ...NO_FLAGS, profile: 'economy' } }).config.profile).toBe('economy')
    expect(mergeLayers({ user: { profile: 'frontier' }, env: { HESDOR_PROFILE: 'balanced' } }).sources.profile).toBe('env')
    const project = mergeLayers({ user: {}, project: { profile: 'frontier' } })
    expect(project.config.profile).toBeUndefined()
    expect(project.warnings[0]).toMatch(/"profile" cannot be set by a project/)
    expect(mergeLayers({ user: { profile: 'cheap' as never } }).config.profile).toBeUndefined()
    expect(() => mergeLayers({ user: {}, flags: { ...NO_FLAGS, profile: 'frontier' }, managed: { profile: 'economy' } })).toThrow(/--profile is locked/)
    expect(mergeLayers({ user: { profile: 'frontier' }, managed: { profile: 'economy' } }).config.profile).toBe('economy')
  })
})
