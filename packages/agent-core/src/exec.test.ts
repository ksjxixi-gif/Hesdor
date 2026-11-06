import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS } from '@hesdor/providers'
import { childEnv, execStreaming, windowsQuoteJoin } from './exec.js'

describe('windowsQuoteJoin', () => {
  it('refuses cmd.exe metacharacters instead of quoting them', () => {
    for (const arg of ['test & rmdir /s /q C:\\', 'a|b', 'x>y', '%PATH%', '!x!', 'a^b', 'say "hi"', 'a\nb']) {
      expect(() => windowsQuoteJoin(['pnpm', arg])).toThrow(/metacharacter/)
    }
  })

  it('quotes plain arguments with spaces', () => {
    expect(windowsQuoteJoin(['pnpm', 'test', '--', '-t', 'my test'])).toBe('pnpm test -- -t "my test"')
  })
})

describe('childEnv', () => {
  it('strips every provider preset credential but keeps other variables', () => {
    const saved = { ...process.env }
    try {
      const names = PROVIDER_PRESETS.flatMap((p) => [p.envKey, ...(p.envKeys ?? [])]).filter((k): k is string => !!k)
      for (const k of names) process.env[k] = 'secret'
      process.env.HESDOR_FOO_API_KEY = 'secret'
      process.env.STRIPE_API_KEY = 'project-key'
      const env = childEnv({ EXTRA: '1' })
      for (const k of names) expect(env[k], k).toBeUndefined()
      expect(env.HESDOR_FOO_API_KEY).toBeUndefined()
      expect(env.STRIPE_API_KEY).toBe('project-key')
      expect(env.EXTRA).toBe('1')
    } finally {
      process.env = saved
    }
  })

  it('reaches spawned commands', async () => {
    const saved = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test-leak'
    try {
      const res = await execStreaming(['node', '-e', 'console.log(process.env.OPENAI_API_KEY ?? "none")'], { cwd: process.cwd() })
      expect(res.stdoutTail).toEqual(['none'])
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
  })
})

describe('execStreaming', () => {
  it('does not spawn when the signal is already aborted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-exec-'))
    const marker = path.join(dir, 'ran.txt')
    const controller = new AbortController()
    controller.abort()
    await expect(
      execStreaming(['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
        cwd: dir,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/)
    await new Promise((r) => setTimeout(r, 300))
    expect(() => require('node:fs').statSync(marker)).toThrow()
  })

  it('returns when the child exits even if a grandchild still holds the pipes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-exec-'))
    const script = path.join(dir, 'spawn.js')
    writeFileSync(
      script,
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true, windowsHide: true }); c.unref(); console.log('grandchild ' + c.pid)\n",
    )
    const started = Date.now()
    // Before the fix this waited for the grandchild (20 s), even past the timeout.
    const res = await execStreaming(['node', script], { cwd: dir, timeoutMs: 15000 })
    const grandchild = Number(res.stdoutTail.find((l) => l.startsWith('grandchild '))?.split(' ')[1])
    try {
      process.kill(grandchild)
    } catch {
      // already gone
    }
    expect(res.exitCode).toBe(0)
    expect(grandchild).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(10000)
  })
})
