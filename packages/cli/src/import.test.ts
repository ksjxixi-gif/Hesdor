import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { claudeSessions, codexSessions, convertClaude, convertCodex, normalize, runImport, textifyForeign } from './import.js'
import { resolveWorkspaceRoot } from './run.js'
import { findSession } from './sessions.js'

process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))
const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))

describe('convertClaude', () => {
  it('turns foreign tool calls into text, merges split assistant lines, skips noise', () => {
    const msgs = convertClaude(readFileSync(fixture('claude-code-session.jsonl'), 'utf8'))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(msgs.some((m) => m.toolCalls)).toBe(false)
    expect(msgs[0]!.content).toBe('Fix the failing test in src/math.ts')
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: 'Let me read the file.\n\n[Claude Code tool Read] {"file_path":"/work/demo/src/math.ts"}',
    })
    expect(msgs[2]!.content).toBe('[result of Read] 1\texport const add = (a, b) => a - b')
    expect(msgs[3]!.content).toBe('[Claude Code tool mcp__fs__edit] {"path":"src/math.ts"}\n\n[Claude Code tool Bash] {"command":"npm test"}')
    // the unanswered Bash call gets a placeholder result
    expect(msgs[4]!.content).toBe('[result of mcp__fs__edit] edited\n\n[result of Bash, error] (no result recorded)')
    expect(msgs[5]!.content).toBe('Fixed: add now uses +.')
    expect(JSON.stringify(msgs)).not.toMatch(/secret reasoning|subagent chatter|command-name|Caveat/)
  })

  it('never throws on garbage', () => {
    expect(convertClaude('{\n[]\nnull\n{"type":"user"}\n{"type":"user","message":{"content":42}}')).toEqual([])
  })
})

describe('convertCodex', () => {
  it('maps messages, function and custom tool calls, drops reasoning and scaffolding', () => {
    const msgs = convertCodex(readFileSync(fixture('codex-rollout.jsonl'), 'utf8'))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(msgs[0]!.content).toBe('List the files and add a README')
    expect(msgs[1]).toEqual({ role: 'assistant', content: '[Codex tool shell] {"command":["bash","-lc","ls"]}' })
    expect(msgs[2]!.content).toBe('[result of shell] src\npackage.json')
    // Codex's apply_patch takes {input}, not Hesdor's {path, edits}: it fails the schema, so it becomes text too
    expect(msgs[3]!.toolCalls).toBeUndefined()
    expect(msgs[3]!.content).toContain('Adding the README now.')
    expect(msgs[3]!.content).toContain('[Codex tool apply_patch]')
    expect(msgs[4]!.content).toContain('[result of apply_patch] Success. Updated: A README.md')
    expect(msgs[5]).toEqual({ role: 'assistant', content: 'Done: README.md added.\n\n[Codex tool shell] {}' })
    expect(msgs[6]!.content).toBe('[result of shell, error] (no result recorded)')
    expect(JSON.stringify(msgs)).not.toMatch(/environment_context|permissions instructions|gAAAA/)
  })
})

describe('normalize', () => {
  it('drops orphan results and empty turns, merges adjacent user texts', () => {
    expect(
      normalize([
        { role: 'tool_result', toolCallId: 'x', content: 'orphan' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'b' },
      ]),
    ).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })
})

describe('textifyForeign', () => {
  it('textifies a whole turn with any foreign or unparseable call, folds results into the next user message, truncates', () => {
    const out = textifyForeign(
      [
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', argumentsJson: '{"path":"x"}' }, { id: 'b', name: 'Grep', argumentsJson: '{}' }] },
        { role: 'tool_result', toolCallId: 'a', content: 'x'.repeat(3000) },
        { role: 'tool_result', toolCallId: 'b', content: 'hit' },
        { role: 'user', content: 'thanks' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'run_command', argumentsJson: 'not json' }] },
        { role: 'tool_result', toolCallId: 'c', content: 'ok' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'd', name: 'read_file', argumentsJson: '{"path":"y"}' }] },
        { role: 'tool_result', toolCallId: 'd', content: 'y' },
      ],
      'Codex',
    )
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant', 'tool_result'])
    expect(out[0]!.content).toBe('[Codex tool read_file] {"path":"x"}\n\n[Codex tool Grep] {}')
    expect(out[1]!.content).toMatch(/^\[result of read_file\] x{2000}… \(1000 more characters\)\n\n\[result of Grep\] hit\n\nthanks$/)
    expect(out[2]!.content).toBe('[Codex tool run_command] not json')
    expect(out[4]!.toolCalls![0]!.name).toBe('read_file')
  })
})

describe('finding source sessions', () => {
  it('finds Claude Code transcripts by encoded workspace path', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'claude-home-'))
    const ws = path.resolve('/work/my.demo')
    const dir = path.join(home, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    copyFileSync(fixture('claude-code-session.jsonl'), path.join(dir, 'abc.jsonl'))
    expect(await claudeSessions([ws], home)).toEqual([path.join(dir, 'abc.jsonl')])
    expect(await claudeSessions([path.resolve('/elsewhere')], home)).toEqual([])
  })

  it('finds Codex rollouts by session_meta cwd', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex-home-'))
    const day = path.join(home, 'sessions', '2026', '11', '02')
    mkdirSync(day, { recursive: true })
    const file = path.join(day, 'rollout-2026-11-02T09-00-00-5e6f7a8b.jsonl')
    copyFileSync(fixture('codex-rollout.jsonl'), file)
    writeFileSync(path.join(day, 'rollout-2026-11-02T10-00-00-bad.jsonl'), 'not json\n')
    expect(await codexSessions([path.resolve('/work/demo')], home)).toEqual([file])
    expect(await codexSessions([path.resolve('/other')], home)).toEqual([])
  })
})

describe('runImport', () => {
  it('imports a file into a new resumable session without touching the source', async () => {
    const src = fixture('codex-rollout.jsonl')
    const before = readFileSync(src)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runImport(`codex ${src}`, { yes: false, debug: false, force: false, version: false, help: false })).toBe(0)
    const id = /hesdor -r (\S+)/.exec(log.mock.calls.map((c) => c.join(' ')).join('\n'))![1]!
    log.mockRestore()
    const ws = resolveWorkspaceRoot(process.cwd())
    const stored = await findSession('root' in ws ? ws.root : process.cwd(), id)
    expect(stored.title).toBe('Imported from Codex: List the files and add a README')
    expect(stored.messages).toHaveLength(7)
    expect(readFileSync(src).equals(before)).toBe(true)
  })

  it('rejects an unknown source', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runImport('gemini', { yes: false, debug: false, force: false, version: false, help: false })).toBe(1)
    err.mockRestore()
  })
})
