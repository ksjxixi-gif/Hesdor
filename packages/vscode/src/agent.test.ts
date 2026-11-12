import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NPX_FALLBACK, cmdQuote, resolveCommand, spawnSpec } from './agent.js'

describe('resolveCommand', () => {
  it('finds a PATHEXT name on Windows and skips the extensionless npm shell script', () => {
    const dir = path.join('C:', 'npm')
    const files = new Set([path.join(dir, 'hesdor'), path.join(dir, 'hesdor.cmd')])
    const cmd = resolveCommand('hesdor', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32', (f) => files.has(f))
    expect(cmd).toEqual({ command: path.join(dir, 'hesdor.cmd'), args: [] })
  })

  it('uses a configured path as is, and falls back to npx when nothing is found', () => {
    expect(resolveCommand('/opt/hesdor/bin/hesdor', {}, 'linux', () => false)).toEqual({ command: '/opt/hesdor/bin/hesdor', args: [] })
    expect(resolveCommand('hesdor', { PATH: '/usr/bin' }, 'linux', () => false)).toBe(NPX_FALLBACK)
  })
})

describe('spawnSpec', () => {
  it('runs .cmd shims and npx through the shell on Windows, quoting what needs it', () => {
    const spec = spawnSpec({ command: 'C:\\Program Files\\nodejs\\hesdor.cmd', args: [] }, ['-p', 'my provider', 'acp'], 'win32')
    expect(spec).toEqual({ file: '"C:\\Program Files\\nodejs\\hesdor.cmd" -p "my provider" acp', args: [], shell: true })
    expect(spawnSpec(NPX_FALLBACK, ['acp'], 'win32')).toEqual({ file: 'npx -y @dean_overlord/hesdor acp', args: [], shell: true })
  })

  it('spawns directly elsewhere', () => {
    expect(spawnSpec({ command: '/usr/bin/hesdor', args: [] }, ['acp'], 'linux')).toEqual({ file: '/usr/bin/hesdor', args: ['acp'], shell: false })
  })

  it('quotes cmd.exe metacharacters', () => {
    expect(cmdQuote('a&b')).toBe('"a&b"')
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""')
  })
})
