import { describe, expect, it } from 'vitest'
import { escapeHtml, renderExport } from './export.js'
import { redactSecrets } from './redact.js'
import type { StoredSession } from './sessions.js'

const session: StoredSession = {
  id: 'abc-123',
  repo: '/work/demo',
  createdAt: Date.UTC(2026, 10, 1),
  updatedAt: Date.UTC(2026, 10, 2),
  title: 'Fix <b>bold</b> & "quotes"',
  messages: [
    { role: 'user', content: 'run it with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123' },
    { role: 'assistant', content: 'Running.', toolCalls: [{ id: 'c1', name: 'run_command', argumentsJson: '{"command":"echo <script>alert(1)</script>"}' }] },
    { role: 'tool_result', toolCallId: 'c1', content: `x${'y'.repeat(5000)}`, isError: true },
    { role: 'assistant', content: 'Here is ```code``` inside' },
  ],
}

describe('export', () => {
  it('renders a markdown transcript with compact tool blocks and truncated results', () => {
    const md = renderExport(session, 'md')
    expect(md).toContain('# Fix <b>bold</b>')
    expect(md).toContain('## User')
    expect(md).toContain('**Tool call** `run_command`')
    expect(md).toContain('**Result** `run_command` (error)')
    expect(md).toContain('more characters')
    expect(md.length).toBeLessThan(4000)
    // the fence is longer than any backtick run in the content
    expect(md).not.toContain('\n```\nHere')
  })

  it('renders self-contained, escaped HTML', () => {
    const html = renderExport(session, 'html')
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>bold')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&amp; &quot;quotes&quot;')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/(src|href)=["']?https?:/)
    expect(escapeHtml(`<a href='x'>&</a>`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;')
  })

  it('json is the stored session; --redact keeps it valid JSON', () => {
    expect(JSON.parse(renderExport(session, 'json'))).toEqual(session)
    const redacted = JSON.parse(renderExport(session, 'json', true)) as StoredSession
    expect(redacted.messages[0]!.content).toBe('run it with OPENAI_API_KEY=[REDACTED]')
    expect(redacted.id).toBe('abc-123')
    expect(renderExport(session, 'html', true)).not.toContain('sk-proj-')
  })
})

describe('redactSecrets', () => {
  const secrets: Array<[string, string]> = [
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv-_12345', 'anthropic'],
    ['sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123', 'openai'],
    ['sk-or-v1-0123456789abcdef0123456789abcdef', 'openrouter'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google'],
    ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'github'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstu', 'github pat'],
    ['xoxb-1234567890-abcdefghijkl', 'slack'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws access key'],
  ]
  for (const [secret, label] of secrets) {
    it(`redacts ${label}`, () => {
      expect(redactSecrets(`key is ${secret}.`)).toBe('key is [REDACTED].')
    })
  }

  it('redacts bearer tokens, PEM blocks and secret-named variables', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOi.payload.signature123')).toBe('Authorization: Bearer [REDACTED]')
    expect(redactSecrets('a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----\nb')).toBe('a\n[REDACTED]\nb')
    expect(redactSecrets('export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')).toBe('export AWS_SECRET_ACCESS_KEY="[REDACTED]"')
    expect(redactSecrets('{"GITHUB_TOKEN": "abcdef123456"}')).toBe('{"GITHUB_TOKEN": "[REDACTED]"}')
    expect(redactSecrets('DB_PASSWORD: hunter2hunter2')).toBe('DB_PASSWORD: [REDACTED]')
  })

  it('leaves ordinary code alone', () => {
    const code = [
      'const API_KEY = process.env.OPENAI_API_KEY',
      'const key = env.ANTHROPIC_API_KEY ?? $GEMINI_API_KEY',
      'MAX_TOKEN=4096',
      'const PRIMARY_KEY = "id"',
      'task-runner-for-the-risk-assessment-module',
      'git checkout -b fix/desk-layout-alignment-issue',
      'function getSecret() { return vault.read(name) }',
      'Bearer token required',
      'const token = await getToken()',
    ].join('\n')
    expect(redactSecrets(code)).toBe(code)
  })
})
