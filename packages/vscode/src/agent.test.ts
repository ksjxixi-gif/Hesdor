import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdQuote, installTerminal, resolveCommand, spawnSpec } from './agent.js'

describe('resolveCommand', () => {
  it('finds a PATHEXT name on Windows and skips the extensionless npm shell script', () => {
    const dir = path.join('C:', 'npm')
    const files = new Set([path.join(dir, 'hesdor'), path.join(dir, 'hesdor.cmd')])
    const cmd = resolveCommand('hesdor', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32', (f) => files.has(f))
    expect(cmd).toEqual({ command: path.join(dir, 'hesdor.cmd'), args: [] })
  })

  it('uses a configured path as is, then the installer default, else null', () => {
    expect(resolveCommand('/opt/hesdor/bin/hesdor', {}, 'linux', () => false)).toEqual({ command: '/opt/hesdor/bin/hesdor', args: [] })
    expect(resolveCommand('hesdor', { PATH: '/usr/bin', HOME: '/home/me' }, 'linux', () => false)).toBeNull()
    // Installed after VS Code started: not on its PATH yet, but in the installer's default folder.
    const exe = path.join('C:', 'Users', 'me', 'AppData', 'Local', 'Programs', 'hesdor', 'hesdor.exe')
    const env = { PATH: path.join('C:', 'npm'), LOCALAPPDATA: path.join('C:', 'Users', 'me', 'AppData', 'Local') }
    expect(resolveCommand('hesdor', env, 'win32', (f) => f === exe)).toEqual({ command: exe, args: [] })
  })

  it('installs with the platform script, then runs setup', () => {
    expect(installTerminal('win32')).toEqual({ shellPath: 'powershell.exe', text: expect.stringMatching(/^irm https:.*install\.ps1 \| iex; .*hesdor\.exe" setup }$/) })
    expect(installTerminal('darwin')).toEqual({ shellPath: '/bin/sh', text: expect.stringMatching(/^curl -fsSL https:.*install\.sh \| sh && "\$HOME\/\.local\/bin\/hesdor" setup$/) })
  })
})

describe('spawnSpec', () => {
  it('runs .cmd shims through the shell on Windows, quoting what needs it', () => {
    const spec = spawnSpec({ command: 'C:\\Program Files\\nodejs\\hesdor.cmd', args: [] }, ['-p', 'my provider', 'acp'], 'win32')
    expect(spec).toEqual({ file: '"C:\\Program Files\\nodejs\\hesdor.cmd" -p "my provider" acp', args: [], shell: true })
  })

  it('spawns directly elsewhere', () => {
    expect(spawnSpec({ command: '/usr/bin/hesdor', args: [] }, ['acp'], 'linux')).toEqual({ file: '/usr/bin/hesdor', args: ['acp'], shell: false })
  })

  it('quotes cmd.exe metacharacters', () => {
    expect(cmdQuote('a&b')).toBe('"a&b"')
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""')
  })
})
