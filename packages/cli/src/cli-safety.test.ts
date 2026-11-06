import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.js'
import { loadAuth, saveCredential } from './auth.js'
import { configDir, loadConfig, saveConfig } from './config.js'
import { customEnvKey, resolveSelection } from './provider-setup.js'
import { createSession } from './session.js'
import { fingerprint, isTrusted, projectCodeFiles, rememberTrust } from './trust.js'

// Every config read/write in this file lands in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

describe('parseArgs', () => {
  it('only treats a keyword in first position as a subcommand', () => {
    expect(parseArgs(['fix', 'the', 'init', 'script'])).toMatchObject({ command: 'interactive', prompt: 'fix the init script' })
    expect(parseArgs(['switch', 'the', 'model', 'to', 'gpt-5'])).toMatchObject({ command: 'interactive' })
    expect(parseArgs(['ask', 'plan', 'a', 'refactor'])).toMatchObject({ command: 'ask', prompt: 'plan a refactor' })
    expect(parseArgs(['-m', 'x', 'run', 'go'])).toMatchObject({ command: 'run', prompt: 'go' })
  })

  it('stops option parsing at --', () => {
    expect(parseArgs(['run', '--', '--explain', '-v', 'flags'])).toMatchObject({ command: 'run', prompt: '--explain -v flags' })
    expect(parseArgs(['--', 'init', 'the', 'db'])).toMatchObject({ command: 'interactive', prompt: 'init the db' })
  })

  it('accepts --trust-workspace', () => {
    expect(parseArgs(['--trust-workspace']).flags.trustWorkspace).toBe(true)
  })
})

describe('config and credential files', () => {
  it('fails loudly on a malformed file instead of wiping it on the next save', async () => {
    mkdirSync(configDir(), { recursive: true })
    const file = path.join(configDir(), 'config.json')
    writeFileSync(file, '{ "provider": "openai", }')
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/)
    await expect(saveConfig({ model: 'x' })).rejects.toThrow(/not valid JSON/)
    writeFileSync(file, '{ "provider": "openai" }')
    await saveConfig({ model: 'gpt' })
    expect(await loadConfig()).toEqual({ provider: 'openai', models: { openai: 'gpt' } })
    expect(readdirSync(configDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('round-trips credentials', async () => {
    await saveCredential('groq', 'gsk-1')
    await saveCredential('openai', 'sk-2')
    await saveCredential('groq', '')
    expect(await loadAuth()).toEqual({ openai: 'sk-2' })
  })
})

describe('custom provider keys', () => {
  it('gives each custom provider its own env var', () => {
    expect(customEnvKey('my-gateway', false)).toBe('HESDOR_MY_GATEWAY_API_KEY')
  })

  it('never sends the shared one-off key to a saved custom provider', async () => {
    process.env.HESDOR_CUSTOM_API_KEY = 'personal-key'
    try {
      await saveCredential('work', 'work-key')
      const sel = await resolveSelection(
        { yes: false, debug: false, force: false, version: false, help: false, provider: 'work' },
        { customProviders: { work: { kind: 'openai', baseUrl: 'https://gw.example.com/v1' } } },
      )
      expect(sel.apiKey).toBe('work-key')
    } finally {
      delete process.env.HESDOR_CUSTOM_API_KEY
    }
  })
})

describe('workspace trust', () => {
  function hostileRepo(): { root: string; marker: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-trust-'))
    const marker = path.join(root, 'pwned.txt')
    mkdirSync(path.join(root, '.git'))
    mkdirSync(path.join(root, '.hesdor', 'plugins'), { recursive: true })
    // Importing this plugin is enough to run code.
    writeFileSync(
      path.join(root, '.hesdor', 'plugins', 'evil.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\nexport default {}\n`,
    )
    return { root, marker }
  }

  it('does not load project plugins from an untrusted repo', async () => {
    const { root, marker } = hostileRepo()
    const warnings: string[] = []
    const session = await createSession({ root, warn: (m) => warnings.push(m) })
    session.dispose()
    expect(existsSync(marker)).toBe(false)
    expect(warnings.join('\n')).toMatch(/not trusted/)
  })

  it('loads them once trusted, and asks again after they change', async () => {
    const { root, marker } = hostileRepo()
    const files = await projectCodeFiles(root)
    const print = await fingerprint(root, files)
    await rememberTrust(root, print)
    expect(await isTrusted(root, print)).toBe(true)

    const session = await createSession({ root, trust: async (_f, p) => isTrusted(root, p) })
    session.dispose()
    expect(existsSync(marker)).toBe(true)

    writeFileSync(path.join(root, '.hesdor', 'mcp.json'), '{"mcp":{}}')
    const changed = await fingerprint(root, await projectCodeFiles(root))
    expect(changed).not.toBe(print)
    expect(await isTrusted(root, changed)).toBe(false)
  })
})
