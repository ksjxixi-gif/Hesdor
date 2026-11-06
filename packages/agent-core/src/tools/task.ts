import { z } from 'zod'
import type { ToolRisk } from '@hesdor/protocol'
import type { AgentDef } from '../agents.js'
import { agentToolNames } from '../agents.js'
import type { ToolContext } from '../context.js'
import { assertRiskAllowed } from '../policy.js'
import type { ToolRegistry } from '../registry.js'
import { defineTool } from './types.js'
import type { AnyTool } from './types.js'

const RISK_ORDER: ToolRisk[] = ['READ', 'NETWORK', 'WRITE', 'EXECUTE', 'DESTRUCTIVE']

/**
 * Runs a markdown subagent with its own context. The tool is READ, but each
 * call is checked against the most powerful tool the agent grants, so plan
 * and ask modes cannot escalate through a write-capable agent.
 */
export function createTaskTool(agents: AgentDef[], registry: ToolRegistry): AnyTool {
  const names = agents.map((a) => a.name) as [string, ...string[]]
  return defineTool({
    name: 'task',
    description:
      'Delegate a self-contained task to a named subagent. It runs with its own context and tools and returns its final answer. ' +
      `Give it everything it needs in the prompt.\nAgents:\n${agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')}`,
    risk: 'READ',
    schema: z.object({
      agent: z.enum(names).describe('Name of the agent to run'),
      prompt: z.string().min(1).describe('The task for the agent, with all context it needs'),
      max_steps: z.number().int().min(1).max(50).optional().describe('Model-call budget for the agent (default 20)'),
    }),
    async execute(input, ctx: ToolContext) {
      const agent = agents.find((a) => a.name === input.agent)!
      const tools = agentToolNames(agent, registry.list().map((t) => t.name))
      const risk = tools.reduce<ToolRisk>((max, name) => {
        const r = registry.get(name)!.risk
        return RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(max) ? r : max
      }, 'READ')
      assertRiskAllowed(ctx.mode, `task (agent "${agent.name}")`, risk)
      if (!ctx.subagent) throw new Error('subagents are not available here (no nesting)')
      return ctx.subagent(input.prompt, input.max_steps ?? 20, {
        name: agent.name,
        systemPrompt: agent.prompt,
        tools,
        ...(agent.model ? { model: agent.model } : {}),
      })
    },
  })
}
