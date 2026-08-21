import { z } from 'zod'
import type { ToolSpec } from '@hesdor/protocol'
import type { AnyTool } from './tools/types.js'
import {
  applyPatchTool,
  deleteFileTool,
  listFilesTool,
  readFileTool,
  readFilesTool,
  writeFileTool,
} from './tools/fs.js'
import { searchFilesTool } from './tools/search.js'
import { runCommandTool, stopCommandTool } from './tools/shell.js'
import { gitDiffTool, gitLogTool, gitStatusTool } from './tools/git-tools.js'

/** Typed tool registry. Duplicate names are a programming error. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>()

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  list(): AnyTool[] {
    return [...this.tools.values()]
  }

  /** Wire-format descriptions for the model provider. */
  specs(): ToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema:
        'parametersJsonSchema' in t ? t.parametersJsonSchema : (z.toJSONSchema(t.schema) as Record<string, unknown>),
    }))
  }
}

/** All built-in tools with sensible descriptions and risk levels. */
export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(listFilesTool)
    .register(readFileTool)
    .register(readFilesTool)
    .register(searchFilesTool)
    .register(writeFileTool)
    .register(applyPatchTool)
    .register(deleteFileTool)
    .register(runCommandTool)
    .register(stopCommandTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(gitLogTool)
}
