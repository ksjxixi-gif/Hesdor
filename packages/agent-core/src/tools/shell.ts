import { z } from 'zod'
import { execStreaming, killChild } from '../exec.js'
import { classifyCommand, PermissionDeniedError } from '../policy.js'
import { safeResolve, toRel } from '../paths.js'
import { defineTool } from './types.js'

function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current !== '') {
        out.push(current)
        current = ''
        started = false
      }
    } else {
      current += ch
    }
  }
  if (started || current !== '') out.push(current)
  return out
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run a development command inside the repository (tests, builds, git read-only inspection...). One command string, parsed with shell-like quoting. Long-running or dangerous commands may require user approval.',
  risk: 'EXECUTE',
  schema: z.object({
    command: z.string().min(1).describe('The command to run, e.g. "pnpm test" or "node scripts/build.js --watch=false"'),
    cwd: z.string().optional().describe('Subdirectory of the repository to run in (default: repository root)'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
  }),
  async execute(input, ctx) {
    const argv = tokenize(input.command)
    if (argv.length === 0) throw new Error('empty command')

    const classification = classifyCommand(argv)
    if (classification.destructive || classification.network) {
      const kind = classification.destructive ? 'DESTRUCTIVE' : 'NETWORK'
      const reason = classification.reason ?? 'risky operation'
      if (!ctx.approvalsEnabled) {
        throw new PermissionDeniedError(
          `blocked (${kind}): "${input.command}" — ${reason}. Explicit approval is required; the user can re-run with approval enabled.`,
        )
      }
      const approved = await ctx.requestApproval({
        title: `Run ${kind.toLowerCase()} command?`,
        detail: `${input.command}\n(${reason})`,
      })
      if (!approved) {
        throw new PermissionDeniedError(`the user denied the command: "${input.command}"`)
      }
    }

    const cwdAbs = safeResolve(ctx.root, input.cwd && input.cwd.trim() !== '' ? input.cwd : '.')
    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    const result = await execStreaming(argv, {
      cwd: cwdAbs,
      signal: ctx.signal,
      timeoutMs,
      onStdoutLine: (line) => ctx.emit({ type: 'command.output', stream: 'stdout', line }),
      onStderrLine: (line) => ctx.emit({ type: 'command.output', stream: 'stderr', line }),
      onSpawn: (child) => {
        ctx.state.activeChild = child
      },
    })
    ctx.state.activeChild = null

    return {
      command: input.command,
      cwd: toRel(ctx.root, cwdAbs) || '.',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdoutTail.join('\n'),
      stderr: result.stderrTail.join('\n'),
    }
  },
})

export const stopCommandTool = defineTool({
  name: 'stop_command',
  description: 'Stop the currently running background command started by run_command.',
  risk: 'EXECUTE',
  schema: z.object({}),
  async execute(_input, ctx) {
    const child = ctx.state.activeChild
    if (!child) return { stopped: false, reason: 'no running command' }
    killChild(child)
    ctx.state.activeChild = null
    return { stopped: true }
  },
})
