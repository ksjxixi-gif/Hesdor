import { z } from 'zod'
import { defineTool } from './types.js'
import type { ToolContext } from '../context.js'

/**
 * READ-risk tool backed by a host-provided subagent hook (`ctx.subagent`).
 * Lets the main agent delegate whole-repo investigation to a nested read-only
 * agent so broad searches never flood the main context.
 */
export const exploreTool = defineTool({
  name: 'explore',
  description:
    'Delegate a research task to a read-only subagent: search/locate/summarize across the entire repository, trace flows, or collect evidence for a plan. Returns a concise synthesis.',
  risk: 'READ',
  schema: z.object({
    task: z
      .string()
      .min(3)
      .describe('What to investigate, e.g. "trace how auth tokens are validated across packages"'),
    max_steps: z.number().int().min(1).max(10).optional().describe('Tool-call budget for the subagent (default 5)'),
  }),
  async execute(input, ctx: ToolContext) {
    if (!ctx.subagent) throw new Error('subagent loop is not available in this host')
    return ctx.subagent(input.task, input.max_steps ?? 5)
  },
})
