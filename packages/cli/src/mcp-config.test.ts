import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSession } from './session.js'
import { fingerprint, projectCodeFiles } from './trust.js'

// Config reads land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

describe('project .mcp.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-mcpjson-'))
  mkdirSync(path.join(root, '.hesdor'))
  writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { cc: { command: 'definitely-not-a-real-command-xyz' }, off: { command: 'x', disabled: true } } }),
  )

  it('is part of the trust fingerprint', async () => {
    const files = await projectCodeFiles(root)
    expect(files).toEqual([path.join(root, '.mcp.json')])
    const before = await fingerprint(root, files)
    writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { cc: { command: 'other' } } }))
    expect(await fingerprint(root, files)).not.toBe(before)
    writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { cc: { command: 'definitely-not-a-real-command-xyz' }, off: { command: 'x', disabled: true } } }),
    )
  })

  it('loads only in a trusted workspace, without disabled servers', async () => {
    const untrusted = await createSession({ root })
    expect(untrusted.mcpServerNames).toEqual([])
    untrusted.dispose()

    const warnings: string[] = []
    const trusted = await createSession({ root, warn: (m) => warnings.push(m), trust: async () => true })
    expect(trusted.mcpServerNames).toEqual(['cc'])
    expect(warnings.join('\n')).toMatch(/mcp server "cc" failed to start/)
    trusted.dispose()
  })
})
