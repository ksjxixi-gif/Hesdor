import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideCommand } from '@hesdor/agent-core'
import type { CliFlags } from './args.js'
import { loadConfig, saveConfig } from './config.js'
import { listRows, loadEffectiveConfig, loadManagedSettings, mergeLayers, projectConfigTrusted, providerBlocked, runConfigCommand } from './config-layers.js'
import { runHeadless } from './headless.js'
import { loadPermissions } from './policy-cmd.js'
import type { ProviderSelection } from './provider-setup.js'
import { roleSelection } from './roles.js'
import { createSession } from './session.js'
import { fingerprint, projectCodeFiles, rememberTrust } from './trust.js'

const home = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))
process.env.APPDATA = process.env.XDG_CONFIG_HOME = home
const managedFile = path.join(home, 'managed-settings.json')
process.env.HESDOR_MANAGED_SETTINGS = managedFile
const userFile = path.join(home, 'hesdor', 'config.json')

const flags = (extra: Partial<CliFlags> = {}): CliFlags => ({ yes: false, debug: false, force: false, version: false, help: false, ...extra })
const writeManaged = (obj: object): void => writeFileSync(managedFile, JSON.stringify(obj))

afterEach(() => {
  rmSync(managedFile, { force: true })
  rmSync(userFile, { force: true })
  vi.restoreAllMocks()
})

function workspace(projectConfig?: object): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-ws-'))
  if (projectConfig) {
    mkdirSync(path.join(root, '.hesdor'))
    writeFileSync(path.join(root, '.hesdor', 'config.json'), JSON.stringify(projectConfig))
  }
  return root
}

describe('mergeLayers', () => {
  it('applies managed > flags > env > project > user, and records each source', () => {
    const eff = mergeLayers({
      user: { provider: 'openai', maxTokens: 1000, mode: 'plan', effort: 'low', models: { openai: 'user-model' } },
      project: { maxTokens: 2000, effort: 'medium', model: 'project-model', mode: 'build' },
      env: { HESDOR_MAX_TOKENS: '3000' },
      flags: flags({ mode: 'ask' }),
      managed: { effort: 'high' },
    })
    expect(eff.config).toMatchObject({ provider: 'openai', maxTokens: 3000, mode: 'ask', effort: 'high', models: { openai: 'project-model' } })
    expect(eff.sources).toMatchObject({ provider: 'user', maxTokens: 'env', mode: 'flag', effort: 'managed', 'models.openai': 'project' })
    // Config defaults reach the flags that the TUI and resolveSelection read.
    expect(eff.flags).toMatchObject({ mode: 'ask', effort: 'high' })
    expect(eff.warnings).toEqual([])
  })

  it('a project model applies only to the provider the user already uses', () => {
    const eff = mergeLayers({ user: { provider: 'anthropic' }, project: { model: 'claude-x' }, env: { HESDOR_PROVIDER: 'groq' } })
    // The env layer chose groq before the project layer, so the project model belongs to groq, never switches provider.
    expect(eff.config.provider).toBe('groq')
    expect(eff.config.models).toEqual({ groq: 'claude-x' })
    expect(mergeLayers({ user: {}, project: { model: 'm1' } }).config).toEqual({ model: 'm1' })
  })

  it('ignores keys a project may not set, with a warning for each', () => {
    const eff = mergeLayers({
      user: { provider: 'openai' },
      project: {
        $schema: 'x',
        provider: 'evil',
        baseUrls: { openai: 'https://evil.example' },
        customProviders: { x: { kind: 'openai', baseUrl: 'https://evil.example', apiKeyCommand: ['sh'] } },
        roles: { small: 'evil/x' },
        guardian: { enabled: false },
        permissions: { allow: ['rm'] },
        updateCheck: false,
        maxTokens: 'lots',
      },
    })
    expect(eff.config).toEqual({ provider: 'openai' })
    for (const key of ['provider', 'baseUrls', 'customProviders', 'roles', 'guardian', 'permissions', 'updateCheck']) {
      expect(eff.warnings.some((w) => w.includes(`"${key}" cannot be set by a project`))).toBe(true)
    }
    expect(eff.warnings.some((w) => w.includes('maxTokens must be an integer'))).toBe(true)
    expect(eff.warnings.some((w) => w.includes('$schema'))).toBe(false)
  })

  it('managed keys cannot be changed by flags', () => {
    expect(() => mergeLayers({ user: {}, flags: flags({ maxTokens: 100 }), managed: { maxTokens: 50 } })).toThrow(/--max-tokens is locked to 50 by managed settings/)
    expect(() => mergeLayers({ user: {}, flags: flags({ provider: 'openai' }), managed: { provider: 'anthropic' } })).toThrow(/--provider is locked/)
    expect(() => mergeLayers({ user: {}, flags: flags({ guardian: true }), managed: { disableGuardian: true } })).toThrow(/--guardian is disabled/)
    // The same value is not a conflict.
    expect(mergeLayers({ user: {}, flags: flags({ maxTokens: 50 }), managed: { maxTokens: 50 } }).sources.maxTokens).toBe('managed')
    const eff = mergeLayers({ user: { guardian: { enabled: true, model: 'a/b' }, updateCheck: true }, managed: { disableGuardian: true, updateCheck: false } })
    expect(eff.config.guardian).toEqual({ enabled: false, model: 'a/b' })
    expect(eff.config.updateCheck).toBe(false)
    expect(eff.sources['guardian.enabled']).toBe('managed')
  })
})

describe('managed settings', () => {
  it('validates the file and fails closed', async () => {
    expect(await loadManagedSettings()).toEqual({})
    writeManaged({ allowedProviders: 'openai' })
    await expect(loadManagedSettings()).rejects.toThrow(/allowedProviders/)
    writeManaged({ permissions: { allow: ['rm'] } })
    await expect(loadManagedSettings()).rejects.toThrow(/only contain ask and deny/)
    writeManaged({ disableMcp: 'yes' })
    await expect(loadManagedSettings()).rejects.toThrow(/disableMcp/)
    writeFileSync(managedFile, '{ nope')
    await expect(loadEffectiveConfig()).rejects.toThrow(/not valid JSON/)
  })

  it('enforces the provider allowlist for the main model and roles with a clear error', async () => {
    writeManaged({ allowedProviders: ['anthropic'] })
    const managed = await loadManagedSettings()
    expect(providerBlocked(managed, 'anthropic')).toBeUndefined()
    expect(providerBlocked(managed, 'openai')).toMatch(/provider "openai" is not allowed by managed settings .*allowed: anthropic/)

    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)))
    const code = await runHeadless('ask', 'hi', flags({ provider: 'openai' }), { cwd: workspace() })
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/provider "openai" is not allowed/)

    const current: ProviderSelection = { providerId: 'anthropic', kind: 'anthropic', model: 'm', keySource: 'none' }
    await expect(roleSelection('groq/llama', flags(), {}, current)).rejects.toThrow(/provider "groq" is not allowed/)
  })

  it('forces deny rules and can turn off web tools and MCP', async () => {
    const root = workspace()
    expect(decideCommand(['git', 'status'], await loadPermissions(root)).action).not.toBe('deny')
    writeManaged({ permissions: { deny: ['git status'] }, disableWebTools: true, disableMcp: true })
    await saveConfig({ permissions: { allow: ['git status'] } })
    expect(decideCommand(['git', 'status'], await loadPermissions(root)).action).toBe('deny')

    const session = await createSession({ root })
    try {
      expect(session.registry.get('web_fetch')).toBeUndefined()
      expect(session.registry.get('read_file')).toBeDefined()
    } finally {
      session.dispose()
    }
  })
})

describe('project config and trust', () => {
  it('is part of the trust fingerprint and applies only when the workspace is trusted', async () => {
    await saveConfig({ provider: 'openai', maxTokens: 1000 })
    const root = workspace({ maxTokens: 2000, provider: 'evil' })
    expect(await projectCodeFiles(root)).toEqual([path.join(root, '.hesdor', 'config.json')])

    expect(await projectConfigTrusted(root)).toBe(false)
    const untrusted = await loadEffectiveConfig(flags(), { root, trusted: await projectConfigTrusted(root) })
    expect(untrusted.config.maxTokens).toBe(1000)
    expect(untrusted.warnings.join('\n')).toMatch(/ignored \.hesdor\/config\.json: this repository is not trusted/)

    expect(await projectConfigTrusted(root, true)).toBe(true)
    await rememberTrust(root, await fingerprint(root, await projectCodeFiles(root)))
    expect(await projectConfigTrusted(root)).toBe(true)
    const trusted = await loadEffectiveConfig(flags(), { root, trusted: true })
    expect(trusted.config).toMatchObject({ provider: 'openai', maxTokens: 2000 })
    expect(trusted.sources.maxTokens).toBe('project')
    expect(trusted.warnings.join('\n')).toMatch(/"provider" cannot be set by a project/)

    // Editing the file invalidates the pinned approval.
    writeFileSync(path.join(root, '.hesdor', 'config.json'), JSON.stringify({ maxTokens: 9 }))
    expect(await projectConfigTrusted(root)).toBe(false)
  })
})

describe('hesdor config', () => {
  async function cmd(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)))
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void err.push(String(m)))
    const code = await runConfigCommand(args, workspace())
    vi.restoreAllMocks()
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('set validates and writes the user file only', async () => {
    expect((await cmd('set', 'maxTokens', '4096')).code).toBe(0)
    expect((await cmd('set', 'maxTokens', 'abc')).err).toMatch(/invalid value for maxTokens/)
    expect((await cmd('set', 'provider', 'nope')).err).toMatch(/unknown provider "nope"/)
    expect((await cmd('set', 'provider', 'anthropic')).code).toBe(0)
    expect((await cmd('set', 'model', 'claude bad')).code).toBe(1)
    expect((await cmd('set', 'model', 'claude-x')).code).toBe(0)
    expect((await cmd('set', 'updateCheck', 'maybe')).code).toBe(1)
    expect((await cmd('set', 'guardian.enabled', 'true')).code).toBe(0)
    expect((await cmd('set', 'roles.small', 'groq/llama-small')).code).toBe(0)
    expect((await cmd('set', 'baseUrls.openai', 'https://x')).err).toMatch(/cannot be set here/)
    expect((await cmd('set', 'mode', 'yolo')).code).toBe(1)
    expect(await loadConfig()).toEqual({
      maxTokens: 4096,
      provider: 'anthropic',
      models: { anthropic: 'claude-x' },
      guardian: { enabled: true },
      roles: { small: 'groq/llama-small' },
    })

    writeManaged({ allowedProviders: ['anthropic'], maxTokens: 512 })
    expect((await cmd('set', 'provider', 'openai')).err).toMatch(/not allowed by managed settings/)
    expect((await cmd('set', 'maxTokens', '100')).out).toMatch(/managed value applies/)
  })

  it('set profile none removes the profile', async () => {
    expect((await cmd('set', 'profile', 'balanced')).code).toBe(0)
    expect((await loadConfig()).profile).toBe('balanced')
    expect((await cmd('set', 'profile', 'none')).out).toMatch(/^removed profile from /)
    expect(await loadConfig()).not.toHaveProperty('profile')
  })

  it('get and list show effective values with their layer', async () => {
    await saveConfig({ provider: 'openai', maxTokens: 4096, roles: { small: 'groq/x' } })
    writeManaged({ updateCheck: false, disableMcp: true })
    expect((await cmd('get', 'maxTokens')).out).toBe('4096')
    expect((await cmd('get', 'roles')).out).toBe('roles.small = groq/x  (user)')
    expect((await cmd('get', 'nothing')).code).toBe(1)
    const list = (await cmd('list')).out
    expect(list).toContain('provider = openai  (user)')
    expect(list).toContain('updateCheck = false  (managed)')
    expect(list).toContain('mode = build  (default)')
    expect(list).toContain('managed.disableMcp = true  (managed)')
    expect((await cmd('bogus')).code).toBe(1)
  })

  it('listRows falls back to defaults', () => {
    const rows = listRows(mergeLayers({ user: {} }))
    expect(rows).toEqual(expect.arrayContaining([{ key: 'maxTokens', value: 8192, source: 'default' }]))
  })
})

describe('checks layer', () => {
  it('a trusted project overrides checks per kind; malformed checks are ignored with a warning', () => {
    const eff = mergeLayers({ user: { checks: { lint: ['eslint', '{file}'], test: ['npm', 'test'] } }, project: { checks: { test: ['pytest'] } } })
    expect(eff.config.checks).toEqual({ lint: ['eslint', '{file}'], test: ['pytest'] })
    expect(eff.sources.checks).toBe('project')
    const bad = mergeLayers({ user: {}, project: { checks: { lint: 'eslint .' } } })
    expect(bad.config.checks).toBeUndefined()
    expect(bad.warnings[0]).toContain('checks lint must be a list')
  })
})
