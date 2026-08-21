import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { diffHead, getStatus, logOneline } from '../git.js'
import { defineTool } from './types.js'

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show the current branch and working tree status (porcelain).',
  risk: 'READ',
  schema: z.object({}),
  async execute(_input, ctx: ToolContext) {
    const status = await getStatus(ctx.root)
    return { branch: status.branch, entries: status.entries, truncated: status.truncated }
  },
})

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description: 'Show the unified diff of tracked changes against HEAD (staged and unstaged). Use after edits to review what changed.',
  risk: 'READ',
  schema: z.object({}),
  async execute(_input, ctx) {
    const diff = await diffHead(ctx.root)
    return { diff: diff || '(no changes)' }
  },
})

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent commit history, one line per commit.',
  risk: 'READ',
  schema: z.object({
    limit: z.number().int().positive().max(50).optional().describe('Number of commits (default 20)'),
  }),
  async execute(input, ctx) {
    const log = await logOneline(ctx.root, input.limit ?? 20)
    return { log }
  },
})
