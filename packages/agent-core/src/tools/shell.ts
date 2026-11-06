import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { execStreaming, startJob, stopJob, type BackgroundJob } from '../exec.js'
import { decideCommand, PermissionDeniedError, tokenize } from '../policy.js'
import { safeResolve, toRel } from '../paths.js'
import { defineTool } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** How long run_command waits for a background job's first output. */
const JOB_STARTUP_WAIT_MS = 3000
const MAX_RUNNING_JOBS = 8
/** Lines returned per job_output call; older unread lines are reported as skipped. */
const JOB_OUTPUT_LINES = 300

/**
 * Same policy for foreground and background commands (see decideCommand). A `default` ask
 * (no rule, not built-in safe) only applies when the host passed permissions and can ask:
 * headless runs without --yes keep running unclassified commands, as before rules existed.
 */
async function authorize(argv: string[], command: string, ctx: ToolContext): Promise<void> {
  const decision = decideCommand(argv, ctx.permissions)
  if (decision.action === 'allow') return
  if (decision.action === 'deny') throw new PermissionDeniedError(`denied: "${command}" (${decision.reason})`)
  if (decision.source === 'default' && (!ctx.permissions || !ctx.approvalsEnabled)) return
  const kind = decision.source === 'built-in' ? decision.reason.split(':')[0]! : 'EXECUTE'
  if (!ctx.approvalsEnabled) {
    throw new PermissionDeniedError(
      `blocked (${kind}): "${command}" — ${decision.reason}. Explicit approval is required; the user can re-run with approval enabled.`,
    )
  }
  const approved = await ctx.requestApproval({
    title: `Run ${kind.toLowerCase()} command?`,
    detail: `${command}\n(${decision.reason})`,
    argv,
    source: decision.source,
  })
  if (!approved) {
    throw new PermissionDeniedError(`the user denied the command: "${command}"`)
  }
}

/** Poll until `done()` or `ms` elapsed (or the turn is cancelled). */
async function waitUntil(ms: number, done: () => boolean, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline && !signal.aborted) {
    await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())))
  }
}

/** Output the agent has not seen yet, capped to the newest JOB_OUTPUT_LINES. */
function takeOutput(job: BackgroundJob): { output: string; skippedLines?: number } {
  const total = job.dropped + job.lines.length
  const from = Math.max(job.read, job.dropped, total - JOB_OUTPUT_LINES)
  const skipped = from - job.read
  job.read = total
  return { output: job.lines.slice(from - job.dropped).join('\n'), ...(skipped > 0 ? { skippedLines: skipped } : {}) }
}

const jobStatus = (job: BackgroundJob) => ({
  job_id: job.id,
  command: job.command,
  status: job.running ? ('running' as const) : ('exited' as const),
  exitCode: job.exitCode,
})

function getJob(ctx: ToolContext, id: string): BackgroundJob {
  const job = ctx.state.jobs?.get(id)
  if (!job) throw new Error(`no background job "${id}"; job_list shows the jobs`)
  return job
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run ONE development command inside the repository (tests, builds, git read-only inspection...). The string is split into arguments with shell-like quoting and run directly, NOT through a shell: operators such as &&, ||, ;, |, redirects (> <), globs and $VAR expansion are not supported. Run multiple commands as separate calls. Set background: true for long-running processes (dev servers, watchers): it returns a job id and the first output; then use job_output, job_stop and job_list. Long-running or dangerous commands may require user approval.',
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
      .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); ignored for background jobs`),
    background: z
      .boolean()
      .optional()
      .describe('Keep the process running in the background (dev server, watcher) and return a job id right away'),
  }),
  async execute(input, ctx) {
    const argv = tokenize(input.command)
    if (argv.length === 0) throw new Error('empty command')
    await authorize(argv, input.command, ctx)

    const cwdAbs = safeResolve(ctx.root, input.cwd && input.cwd.trim() !== '' ? input.cwd : '.')
    const cwd = toRel(ctx.root, cwdAbs) || '.'

    if (input.background) {
      const jobs = (ctx.state.jobs ??= new Map())
      const running = [...jobs.values()].filter((j) => j.running).length
      if (running >= MAX_RUNNING_JOBS) throw new Error(`${running} background jobs are running; stop one with job_stop first`)
      const job = startJob(`job${jobs.size + 1}`, input.command, argv, cwdAbs)
      jobs.set(job.id, job)
      await waitUntil(JOB_STARTUP_WAIT_MS, () => !job.running, ctx.signal)
      return { ...jobStatus(job), cwd, ...takeOutput(job) }
    }

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
      cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdoutTail.join('\n'),
      stderr: result.stderrTail.join('\n'),
    }
  },
})

export const jobOutputTool = defineTool({
  name: 'job_output',
  description:
    'Read new output (stdout and stderr) of a background job since the last read, plus its status and exit code. Optionally wait for new output first.',
  risk: 'READ',
  schema: z.object({
    job_id: z.string().min(1).describe('Job id returned by run_command, e.g. "job1"'),
    wait_ms: z.number().int().min(0).max(30_000).optional().describe('Wait up to this long for new output or exit (default 0)'),
  }),
  async execute(input, ctx) {
    const job = getJob(ctx, input.job_id)
    await waitUntil(input.wait_ms ?? 0, () => !job.running || job.dropped + job.lines.length > job.read, ctx.signal)
    return { ...jobStatus(job), ...takeOutput(job) }
  },
})

export const jobStopTool = defineTool({
  name: 'job_stop',
  description: 'Stop a background job and its child processes. Returns its final unread output.',
  risk: 'EXECUTE',
  schema: z.object({ job_id: z.string().min(1).describe('Job id returned by run_command') }),
  async execute(input, ctx) {
    const job = getJob(ctx, input.job_id)
    await stopJob(job)
    return { ...jobStatus(job), stopped: true, ...takeOutput(job) }
  },
})

export const jobListTool = defineTool({
  name: 'job_list',
  description: 'List background jobs started in this session with their status.',
  risk: 'READ',
  schema: z.object({}),
  async execute(_input, ctx) {
    return { jobs: [...(ctx.state.jobs?.values() ?? [])].map((job) => ({ ...jobStatus(job), pid: job.pid })) }
  },
})
