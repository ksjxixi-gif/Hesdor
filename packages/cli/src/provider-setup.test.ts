import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveSelection } from './provider-setup.js'

// Keep auth.json reads inside a throwaway profile.
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

const flags = { yes: false, debug: false, force: false, version: false, help: false, provider: 'gemini' }
const names = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']

describe('resolveSelection envKeys', () => {
  beforeEach(() => {
    for (const n of names) delete process.env[n]
  })

  it('falls back to an alternate key variable', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'alt'
    const sel = await resolveSelection(flags, {})
    expect(sel).toMatchObject({ apiKey: 'alt', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', keySource: 'environment' })
  })

  it('prefers the primary variable and names it when nothing is set', async () => {
    process.env.GOOGLE_API_KEY = 'alt'
    process.env.GEMINI_API_KEY = 'main'
    expect((await resolveSelection(flags, {})).apiKey).toBe('main')
    for (const n of names) delete process.env[n]
    expect((await resolveSelection(flags, {})).envKey).toBe('GEMINI_API_KEY')
  })
})
