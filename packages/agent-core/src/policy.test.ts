import { describe, expect, it } from 'vitest'
import { classifyCommand, riskAllowedInMode } from './policy.js'

describe('riskAllowedInMode', () => {
  it('READ is allowed everywhere', () => {
    expect(riskAllowedInMode('build', 'READ')).toBe(true)
    expect(riskAllowedInMode('plan', 'READ')).toBe(true)
    expect(riskAllowedInMode('ask', 'READ')).toBe(true)
  })

  it('everything else is build-only', () => {
    for (const risk of ['WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'] as const) {
      expect(riskAllowedInMode('build', risk)).toBe(true)
      expect(riskAllowedInMode('plan', risk)).toBe(false)
      expect(riskAllowedInMode('ask', risk)).toBe(false)
    }
  })
})

describe('classifyCommand', () => {
  it('marks the obvious destructive commands', () => {
    expect(classifyCommand(['rm', '-rf', '/']).destructive).toBe(true)
    expect(classifyCommand(['rm', '-r', 'build']).destructive).toBe(true)
    expect(classifyCommand(['sudo', 'apt', 'update']).destructive).toBe(true)
    expect(classifyCommand(['del', 'foo.txt']).destructive).toBe(true)
  })

  it('marks destructive git subcommands structurally', () => {
    expect(classifyCommand(['git', 'reset', '--hard']).destructive).toBe(true)
    expect(classifyCommand(['git', 'clean', '-fd']).destructive).toBe(true)
    expect(classifyCommand(['git', 'push', '--force']).destructive).toBe(true)
    expect(classifyCommand(['git', 'push', '-f', 'origin']).destructive).toBe(true)
  })

  it('leaves safe git subcommands alone', () => {
    expect(classifyCommand(['git', 'reset', '--soft', 'HEAD~1']).destructive).toBe(false)
    expect(classifyCommand(['git', 'clean', '-n']).destructive).toBe(false)
    expect(classifyCommand(['git', 'status']).destructive).toBe(false)
  })

  it('flags network operations', () => {
    const cls = classifyCommand(['curl', 'https://example.com'])
    expect(cls.network).toBe(true)
    expect(cls.destructive).toBe(false)
    expect(classifyCommand(['npm', 'publish']).network).toBe(true)
    expect(classifyCommand(['git', 'push', 'origin', 'main']).network).toBe(true)
  })

  it('allows ordinary development commands', () => {
    expect(classifyCommand(['pnpm', 'test']).destructive).toBe(false)
    expect(classifyCommand(['pnpm', 'test']).network).toBe(false)
    expect(classifyCommand(['node', 'scripts/build.js', '--watch=false']).destructive).toBe(false)
    expect(classifyCommand(['pytest', '-q']).destructive).toBe(false)
  })

  it('sees through powershell/cmd wrappers defensively', () => {
    expect(classifyCommand(['powershell', '-c', 'Remove-Item -Recurse foo']).destructive).toBe(true)
  })

  it('ignores extension shims like npm.cmd', () => {
    expect(classifyCommand(['npm.cmd', 'test']).destructive).toBe(false)
  })
})
