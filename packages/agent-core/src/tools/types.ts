import type { z } from 'zod'
import type { ToolRisk } from '@hesdor/protocol'
import type { ToolContext } from '../context.js'

/**
 * A strongly typed built-in tool. Input is validated by the Zod schema
 * before execute() ever runs.
 */
export interface Tool<I> {
  name: string
  description: string
  risk: ToolRisk
  schema: z.ZodType<I>
  execute(input: I, ctx: ToolContext): Promise<unknown>
}

/** Externally supplied tool (e.g. from MCP). Schema arrives as JSON Schema. */
export interface ExternalTool {
  name: string
  description: string
  risk: ToolRisk
  parametersJsonSchema: Record<string, unknown>
  execute(input: unknown, ctx: ToolContext): Promise<unknown>
}

export type AnyTool = Tool<unknown> | ExternalTool

/** Contained cast so built-ins stay internally typed but store as AnyTool. */
export function defineTool<I>(tool: Tool<I>): AnyTool {
  return tool as unknown as AnyTool
}
