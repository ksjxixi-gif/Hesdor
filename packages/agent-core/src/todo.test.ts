import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelProvider, RunEvent } from '@hesdor/protocol'
import { createDefaultRegistry } from './index.js'
import type { ToolContext } from './context.js'
import { SUMMARY_PREFIX, summarizeHistory, TODO_HEADER } from './compact.js'

const todos = [
  { content: 'read the parser', status: 'done' },
  { content: 'fix the bug', status: 'in_progress' },
  { content: 'run tests', status: 'pending' },
] as const

const call = (args: unknown, id = 't1'): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name: 'todo_write', argumentsJson: JSON.stringify(args) }],
})

const summarizer: ModelProvider = {
  name: 'fake',
  model: 'fake',
  async *stream() {
    yield { type: 'text', text: 'Goal: fix it.' }
    yield { type: 'finish', reason: 'stop' }
  },
}

const summarize = (messages: ChatMessage[]) =>
  summarizeHistory(summarizer, messages, { signal: new AbortController().signal, recentBudget: 1_000_000, maxInputTokens: 100_000 })

describe('todo_write', () => {
  it('returns the list, emits todo.updated and runs in read-only modes', async () => {
    const events: RunEvent[] = []
    const ctx = { mode: 'plan', emit: (e: RunEvent) => events.push(e) } as unknown as ToolContext
    const tool = createDefaultRegistry().get('todo_write')!
    expect(tool.risk).toBe('READ')
    const out = await tool.execute({ todos }, ctx)
    expect(out).toBe('Todo list (1/3 done):\n[x] read the parser\n[>] fix the bug\n[ ] run tests')
    expect(events).toEqual([{ type: 'todo.updated', todos }])
    expect(createDefaultRegistry().readOnly().get('todo_write')).toBeUndefined()
  })

  it('re-injects the latest list after a summary, and keeps it across a second summary', async () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      call({ todos: [{ content: 'old', status: 'pending' }] }, 'a'),
      { role: 'tool_result', toolCallId: 'a', content: 'ok' },
      call({ todos }, 'b'),
      { role: 'tool_result', toolCallId: 'b', content: 'ok' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'third' },
    ]
    const once = (await summarize(history))!.messages
    expect(once[1]!.content.startsWith(SUMMARY_PREFIX)).toBe(true)
    expect(once[1]!.content).toContain(`${TODO_HEADER}\nTodo list (1/3 done):\n[x] read the parser\n[>] fix the bug\n[ ] run tests`)
    expect(once[1]!.content).not.toContain('old')

    const twice = (await summarize([...once, { role: 'assistant', content: 'more' }, { role: 'user', content: 'fourth' }]))!.messages
    expect(twice[1]!.content).toContain('[>] fix the bug')
  })

  it('adds nothing when the kept part already has a todo_write call', async () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      call({ todos }, 'a'),
      { role: 'tool_result', toolCallId: 'a', content: 'ok' },
      { role: 'user', content: 'second' },
      call({ todos }, 'b'),
      { role: 'tool_result', toolCallId: 'b', content: 'ok' },
      { role: 'user', content: 'third' },
    ]
    expect((await summarize(history))!.messages[1]!.content).not.toContain(TODO_HEADER)
  })
})
