import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadManagedSettings, mergeLayers } from './config-layers.js'

describe('sandbox config layers', () => {
  it('is off unless configured, and the user config is validated (fail closed)', () => {
    expect(mergeLayers({ user: {} }).config.sandbox).toBeUndefined()
    expect(mergeLayers({ user: { sandbox: { mode: 'workspace-write' } } }).config.sandbox).toEqual({ mode: 'workspace-write' })
    expect(() => mergeLayers({ user: { sandbox: { mode: 'strict' } as never } })).toThrow(/config.json: sandbox.mode/)
  })

  it('a project can only make it stricter', () => {
    const user = { sandbox: { mode: 'workspace-write' as const, network: 'on' as const } }
    const loosen = mergeLayers({ user, project: { sandbox: { mode: 'off', network: 'on' } } })
    expect(loosen.config.sandbox).toEqual({ mode: 'workspace-write', network: 'on' })
    const tighten = mergeLayers({ user, project: { sandbox: { mode: 'read-only', network: 'off', failIfUnavailable: true } } })
    expect(tighten.config.sandbox).toEqual({ mode: 'read-only', network: 'off', failIfUnavailable: true })
    expect(tighten.sources.sandbox).toBe('project')
    // A project can also turn it on when the user has none.
    expect(mergeLayers({ user: {}, project: { sandbox: { mode: 'read-only' } } }).config.sandbox).toEqual({ mode: 'read-only' })
    expect(() => mergeLayers({ user: {}, project: { sandbox: { mode: 'x' } } })).toThrow(/\.hesdor\/config\.json: sandbox/)
  })

  it('managed settings set a floor the user cannot go below', async () => {
    const eff = mergeLayers({ user: { sandbox: { mode: 'off' } }, managed: { sandbox: { mode: 'workspace-write', network: 'off', failIfUnavailable: true } } })
    expect(eff.config.sandbox).toEqual({ mode: 'workspace-write', network: 'off', failIfUnavailable: true })
    expect(eff.sources.sandbox).toBe('managed')
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'hesdor-managed-')), 'managed-settings.json')
    writeFileSync(file, JSON.stringify({ sandbox: { mode: 'sometimes' } }))
    await expect(loadManagedSettings(file)).rejects.toThrow(/sandbox.mode/)
  })

  it.runIf(process.platform === 'win32')('warns on Windows that the sandbox is not supported yet', () => {
    const eff = mergeLayers({ user: { sandbox: { mode: 'workspace-write' } } })
    expect(eff.warnings.join('\n')).toMatch(/not supported on Windows yet/)
  })
})
