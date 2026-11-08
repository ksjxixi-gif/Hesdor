import { z } from 'zod'
import type { TodoItem } from '@hesdor/protocol'
import { defineTool } from './types.js'

export const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe('One short step'),
        status: z.enum(['pending', 'in_progress', 'done']),
      }),
    )
    .max(30)
    .describe('The whole list; it replaces the previous one'),
})

const MARK = { pending: '[ ]', in_progress: '[>]', done: '[x]' } as const

/** Plain-text list for the model (tool result and re-injection after compaction). */
export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list is empty.'
  const done = todos.filter((t) => t.status === 'done').length
  return [`Todo list (${done}/${todos.length} done):`, ...todos.map((t) => `${MARK[t.status]} ${t.content}`)].join('\n')
}

export const todoWriteTool = defineTool({
  name: 'todo_write',
  description:
    'Keep a short plan for a multi-step task. Send the WHOLE list every call (it replaces the previous one); each item is pending, in_progress (one at a time) or done. Update it when you start or finish a step. Skip it for simple one-step requests.',
  risk: 'READ',
  schema: todoSchema,
  async execute(input, ctx) {
    ctx.emit({ type: 'todo.updated', todos: input.todos })
    return renderTodos(input.todos)
  },
})
