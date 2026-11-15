import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@hesdor/protocol'
import { claudeCodeArgs, createTranslator, toolSummary } from './claude-code.js'

const root = path.resolve('/repo')

describe('claude-code', () => {
  it('maps Hesdor modes and models to claude -p flags', () => {
    expect(claudeCodeArgs('build', 'default')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits'])
    expect(claudeCodeArgs('ask', 'sonnet', 'abc').slice(-5)).toEqual(['plan', '--model', 'sonnet', '--resume', 'abc'])
  })

  it('summarizes a tool call by its main input, relative to the workspace', () => {
    expect(toolSummary('Read', { file_path: path.join(root, 'src', 'a.ts') }, root)).toBe(`Read ${path.join('src', 'a.ts')}`)
    expect(toolSummary('Bash', { command: 'npm test\nmore' }, root)).toBe('Bash npm test')
    expect(toolSummary('Glob', {}, root)).toBe('Glob')
  })

  it("translates Claude Code's stream-json into run events", () => {
    const events: RunEvent[] = []
    const sub: RunEvent[] = []
    const t = createTranslator(root, (e) => events.push(e), (e) => sub.push(e))
    const file = path.join(root, 'a.ts')
    for (const m of [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: file } },
            { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'in_progress' }] } },
          ],
        },
      },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } },
      { type: 'assistant', parent_tool_use_id: 'task1', message: { content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'foo' } }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    ]) {
      t.handle(m, 'build')
    }
    expect(events).toEqual([
      { type: 'run.started', mode: 'build', model: 'claude-code/claude-opus-5-5' },
      { type: 'assistant.delta', text: 'hi' },
      { type: 'tool.started', callId: 't1', name: 'Write', summary: 'Write a.ts' },
      { type: 'tool.started', callId: 't2', name: 'TodoWrite', summary: 'TodoWrite' },
      { type: 'todo.updated', todos: [{ content: 'x', status: 'done' }, { content: 'y', status: 'in_progress' }] },
      { type: 'tool.completed', callId: 't1', name: 'Write', summary: 'Write a.ts' },
      { type: 'file.changed', path: file, op: 'write' },
      { type: 'tool.failed', callId: 't2', name: 'TodoWrite', error: 'denied' },
    ])
    // A subagent's tool calls go to the subagent channel, not the main one.
    expect(sub).toEqual([{ type: 'tool.started', callId: 't3', name: 'Grep', summary: 'Grep foo' }])
    expect(t.state).toMatchObject({ sessionId: 's1', onPlan: true, result: { result: 'done' } })
  })
})
