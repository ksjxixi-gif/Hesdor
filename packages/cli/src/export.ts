import { writeFile } from 'node:fs/promises'
import type { ChatMessage } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import { redactDeep } from './redact.js'
import { resolveWorkspaceRoot } from './run.js'
import { findSession } from './sessions.js'
import type { StoredSession } from './sessions.js'

const MAX_ARGS = 500
const MAX_RESULT = 2000

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}

/** One transcript entry, shared by the md and html renderers. */
type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'call'; name: string; args: string }
  | { kind: 'result'; name: string; text: string; isError: boolean }

function entries(messages: ChatMessage[]): Entry[] {
  const names = new Map<string, string>()
  const out: Entry[] = []
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.content.trim() !== '') out.push({ kind: m.role, text: m.content })
      for (const c of m.toolCalls ?? []) {
        names.set(c.id, c.name)
        out.push({ kind: 'call', name: c.name, args: clip(c.argumentsJson, MAX_ARGS) })
      }
    } else if (m.role === 'tool_result') {
      out.push({ kind: 'result', name: names.get(m.toolCallId ?? '') ?? 'tool', text: clip(m.content, MAX_RESULT), isError: !!m.isError })
    }
  }
  return out
}

function header(s: StoredSession): string[] {
  return [`Session ${s.id}`, `Workspace ${s.repo}`, `Created ${new Date(s.createdAt).toISOString()}`, `Updated ${new Date(s.updatedAt).toISOString()}`]
}

/** A code fence longer than any backtick run inside the text, so content can never close it. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const f = '`'.repeat(longest + 1)
  return `${f}\n${text}\n${f}`
}

export function toMarkdown(s: StoredSession): string {
  const lines = [`# ${s.title}`, '', ...header(s).map((h) => `- ${h}`), '']
  for (const e of entries(s.messages)) {
    if (e.kind === 'user') lines.push('## User', '', e.text, '')
    else if (e.kind === 'assistant') lines.push('## Assistant', '', e.text, '')
    else if (e.kind === 'call') lines.push(`**Tool call** \`${e.name}\``, '', fence(e.args), '')
    else lines.push(`**Result** \`${e.name}\`${e.isError ? ' (error)' : ''}`, '', fence(e.text), '')
  }
  return lines.join('\n')
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

const CSS = `:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--card:#f5f5f7;--user:#e8f0fe;--err:#b3261e;--border:#d9d9de}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--muted:#9a9aa0;--card:#1e1e22;--user:#1c2a40;--err:#f2b8b5;--border:#33333a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px;margin-bottom:24px}
.msg{margin:12px 0;padding:10px 14px;border-radius:8px;background:var(--card);white-space:pre-wrap;overflow-wrap:anywhere}
.user{background:var(--user)}.role{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;white-space:normal}
pre{margin:6px 0;padding:8px 12px;border:1px solid var(--border);border-radius:6px;overflow-x:auto;font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.error .role{color:var(--err)}`

/** A single self-contained page: inline CSS, every value escaped, and a CSP that blocks any external load. */
export function toHtml(s: StoredSession): string {
  const body = entries(s.messages).map((e) => {
    if (e.kind === 'user' || e.kind === 'assistant') {
      return `<div class="msg ${e.kind}"><div class="role">${e.kind === 'user' ? 'User' : 'Assistant'}</div>${escapeHtml(e.text)}</div>`
    }
    const label = e.kind === 'call' ? `Tool call · ${e.name}` : `Result · ${e.name}${e.isError ? ' (error)' : ''}`
    const text = e.kind === 'call' ? e.args : e.text
    return `<div class="tool${e.kind === 'result' && e.isError ? ' error' : ''}"><div class="role">${escapeHtml(label)}</div><pre>${escapeHtml(text)}</pre></div>`
  })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(s.title)}</title><style>${CSS}</style></head>
<body><main><h1>${escapeHtml(s.title)}</h1><div class="meta">${header(s).map(escapeHtml).join(' · ')}</div>
${body.join('\n')}
</main></body></html>
`
}

export function renderExport(s: StoredSession, format: 'md' | 'html' | 'json', redact = false): string {
  const session = redact ? redactDeep(s) : s
  if (format === 'json') return `${JSON.stringify(session, null, 2)}\n`
  return format === 'html' ? toHtml(session) : toMarkdown(session)
}

/** `hesdor export [<id>|--latest] [--format md|html|json] [-o file] [--redact]`. */
export async function runExport(id: string, flags: CliFlags): Promise<number> {
  const ws = resolveWorkspaceRoot(process.cwd(), flags.allowHome)
  if ('error' in ws) {
    console.error(`✗ ${ws.error}`)
    return 1
  }
  try {
    const session = await findSession(ws.root, id === '' || flags.latest ? undefined : id)
    const out = renderExport(session, flags.format ?? 'md', flags.redact)
    if (flags.outputFile) {
      // 0600: an unredacted transcript can hold anything the agent read.
      await writeFile(flags.outputFile, out, { encoding: 'utf8', mode: 0o600 })
      console.error(`✓ exported session ${session.id} to ${flags.outputFile}`)
    } else {
      process.stdout.write(out)
    }
    return 0
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
