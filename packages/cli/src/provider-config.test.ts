import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from './args.js'
import { loadAuth, runAuthCommand, saveCredential } from './auth.js'
import { loadConfig, modelIdError, saveConfig } from './config.js'
import { resolveSelection } from './provider-setup.js'
import { runModelCommand } from './setup.js'

const base = { yes: false, debug: false, force: false, version: false, help: false }
let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hesdor-cfg-'))
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = home
  process.env.OPENAI_API_KEY = 'x'
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OPENAI_API_KEY
  rmSync(home, { recursive: true, force: true })
})

describe('per-provider model memory (CLI-6)', () => {
  it('migrates the legacy model to its provider and never sends it to another provider', async () => {
    await saveConfig({ provider: 'groq' })
    // Simulate an old config: one global model saved with provider groq.
    await saveConfig({ model: 'openai/gpt-oss-120b' })
    await saveConfig({ provider: 'anthropic' })
    const cfg = await loadConfig()
    expect(cfg.models).toEqual({ groq: 'openai/gpt-oss-120b' })
    expect(cfg.model).toBeUndefined()
    expect((await resolveSelection(base, cfg)).model).toBe('claude-sonnet-5-5')
    expect((await resolveSelection({ ...base, provider: 'groq' }, cfg)).model).toBe('openai/gpt-oss-120b')
  })

  it('applies a legacy model only to the provider it was saved with', async () => {
    const legacy = { provider: 'groq', model: 'openai/gpt-oss-120b' }
    expect((await resolveSelection({ ...base, provider: 'openai' }, legacy)).model).toBe('gpt-6.1-sol')
    expect((await resolveSelection(base, legacy)).model).toBe('openai/gpt-oss-120b')
  })

  it('hesdor model saves for the current provider and rejects ids with spaces', async () => {
    await saveConfig({ provider: 'groq' })
    expect(await runModelCommand('my model', base)).toBe(1)
    expect(await runModelCommand('m1', base)).toBe(0)
    expect(await runModelCommand('m2', { ...base, provider: 'openai' })).toBe(0)
    expect((await loadConfig()).models).toEqual({ groq: 'm1', openai: 'm2' })
    expect(modelIdError('ok-id')).toBeUndefined()
  })

  it('passes effort, max tokens and custom provider fields through', async () => {
    const cfg = {
      maxTokens: 4000,
      customProviders: { gw: { kind: 'anthropic' as const, baseUrl: 'https://gw', authHeader: 'bearer' as const, apiKeyCommand: ['get-key'], extraBody: { a: 1 } } },
    }
    const sel = await resolveSelection({ ...base, provider: 'gw', effort: 'high' }, cfg)
    expect(sel).toMatchObject({ effort: 'high', maxTokens: 4000, keySource: 'command', custom: { authHeader: 'bearer', apiKeyCommand: ['get-key'], extraBody: { a: 1 } } })
    expect((await resolveSelection({ ...base, maxTokens: 10 }, cfg)).maxTokens).toBe(10)
    await expect(resolveSelection({ ...base, provider: 'gw' }, { customProviders: { gw: { kind: 'anthropic', baseUrl: 'https://gw', apiKeyCommand: 'get-key' as never } } })).rejects.toThrow(/invalid custom provider/)
  })
})

describe('hesdor auth', () => {
  it('lists provider ids without values and logs out', async () => {
    await saveCredential('groq', 'secret-value')
    const log = vi.mocked(console.log)
    expect(await runAuthCommand('list')).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('groq')
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-value')
    expect(await runAuthCommand('logout groq')).toBe(0)
    expect(await loadAuth()).toEqual({})
    expect(await runAuthCommand('logout groq')).toBe(1)
  })
})

describe('provider flags', () => {
  it('parses --effort, --max-tokens and the auth command', () => {
    expect(parseArgs(['--effort', 'high', '--max-tokens', '16000']).flags).toMatchObject({ effort: 'high', maxTokens: 16000 })
    expect(() => parseArgs(['--effort', 'max'])).toThrow(/--effort/)
    expect(() => parseArgs(['--max-tokens', '0'])).toThrow(/--max-tokens/)
    expect(parseArgs(['auth', 'logout', 'groq'])).toMatchObject({ command: 'auth', prompt: 'logout groq' })
  })
})
