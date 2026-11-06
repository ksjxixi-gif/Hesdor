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
import { findFilesTool, searchFilesTool } from './tools/search.js'
import { jobListTool, jobOutputTool, jobStopTool, runCommandTool } from './tools/shell.js'
import { gitDiffTool, gitLogTool, gitStatusTool } from './tools/git-tools.js'
import { exploreTool } from './tools/explore.js'
import { webFetchTool } from './tools/web.js'

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

  /** Copy only read tools for nested investigation runs. */
  readOnly(): ToolRegistry {
    const registry = new ToolRegistry()
    for (const tool of this.list()) {
      if (tool.risk === 'READ') registry.register(tool)
    }
    return registry
  }

  /**
   * Wire-format descriptions for the model provider: every tool, sorted by name and never
   * filtered by mode, so the list is byte-stable for prompt caching. The runtime gate refuses
   * calls the mode does not allow, and the mode rules in the system prompt say which those are.
   */
  specs(): ToolSpec[] {
    return [...this.list()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((t) => ({
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
    .register(findFilesTool)
    .register(writeFileTool)
    .register(applyPatchTool)
    .register(deleteFileTool)
    .register(runCommandTool)
    .register(jobOutputTool)
    .register(jobStopTool)
    .register(jobListTool)
    .register(exploreTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(gitLogTool)
    .register(webFetchTool)
}
