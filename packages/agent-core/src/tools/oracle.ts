import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { safeResolve, toRel } from '../paths.js'
import { defineTool } from './types.js'
import type { AnyTool } from './types.js'

const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 256 * 1024

const ORACLE_SYSTEM =
  'You are an expert second opinion for a coding agent. Answer its question directly and concretely: point out bugs, ' +
  'risks and better approaches, citing the attached files by path. You have no tools; if the files are not enough, say what is missing.'

/**
 * READ-risk second opinion from another model (`roles.oracle`, a `provider/model` the host
 * resolves with that provider's own key). Attached files go through the same path checks as
 * read_file. Runs as a tool-less subagent, so its usage and cost count toward the turn.
 */
export function createOracleTool(model: string): AnyTool {
  return defineTool({
    name: 'oracle',
    description:
      `Ask a second, independent model (${model}) for an opinion: a hard bug, a design choice, a review of a plan or change. ` +
      'It sees only your question and the files you attach, so include the relevant context. Use sparingly; it costs a model call.',
    risk: 'READ',
    schema: z.object({
      question: z.string().min(3).describe('The question, with the context the oracle needs'),
      paths: z.array(z.string().min(1)).max(20).optional().describe('Repository-relative files to attach'),
    }),
    async execute(input, ctx: ToolContext) {
      if (!ctx.subagent) throw new Error('the oracle is not available here (no nesting)')
      let budget = MAX_TOTAL_BYTES
      const files: string[] = []
      for (const p of input.paths ?? []) {
        const abs = safeResolve(ctx.root, p)
        const rel = toRel(ctx.root, abs)
        if ((await stat(abs)).isDirectory()) throw new Error(`"${p}" is a directory`)
        const buf = await readFile(abs)
        if (buf.subarray(0, 8192).includes(0)) {
          files.push(`<file path="${rel}">(binary file, not attached)</file>`)
          continue
        }
        const take = Math.min(buf.length, MAX_FILE_BYTES, budget)
        budget -= take
        const cut = take < buf.length ? `\n… (${buf.length - take} more bytes not attached)` : ''
        files.push(`<file path="${rel}">\n${buf.subarray(0, take).toString('utf8')}${cut}\n</file>`)
      }
      const prompt = files.length > 0 ? `${input.question}\n\nAttached files:\n${files.join('\n')}` : input.question
      return ctx.subagent(prompt, 1, { name: 'oracle', systemPrompt: ORACLE_SYSTEM, tools: [], model })
    },
  })
}
