import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface ExecOptions {
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Lines kept in the result tails. */
  tailLines?: number
  /** Observe the spawned child (e.g. to keep a stop handle). */
  onSpawn?: (child: ChildProcess) => void
}

export interface ExecResult {
  exitCode: number | null
  timedOut: boolean
  stdoutTail: string[]
  stderrTail: string[]
}

/**
 * Cross-platform child process execution with streaming output.
 *
 * POSIX spawns argv directly (no shell). Windows must route through
 * cmd.exe for .cmd/.bat shims (npm, pnpm...) because Node refuses to spawn
 * them directly; policy checks run on parsed argv before that.
 */
export async function execStreaming(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  if (!argv[0]) throw new Error('empty command')
  if (opts.signal?.aborted) throw Object.assign(new Error('command cancelled before it started'), { name: 'AbortError' })
  const child = spawnArgv(argv, opts.cwd)

  const tailCap = opts.tailLines ?? 200
  const stdoutTail: string[] = []
  const stderrTail: string[] = []

  let timedOut = false
  let settled = false
  let exitGrace: NodeJS.Timeout | undefined

  const killTree = (): void => killChild(child)

  opts.onSpawn?.(child)

  const onAbort = (): void => killTree()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killTree()
        }, opts.timeoutMs)
      : undefined

  pump(child.stdout, (line) => {
    pushTail(stdoutTail, line, tailCap)
    opts.onStdoutLine?.(line)
  })
  pump(child.stderr, (line) => {
    pushTail(stderrTail, line, tailCap)
    opts.onStderrLine?.(line)
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true
        // ENOENT etc: report as exit code 127 like a shell would.
        stderrTail.push(`exec error: ${err.message}`)
        resolve(127)
      }
    })
    child.once('close', (code) => {
      if (!settled) {
        settled = true
        resolve(code)
      }
    })
    // A grandchild that inherited our pipes can keep 'close' from ever firing.
    // Once the direct child has exited, give the pipes a moment, then stop waiting.
    child.once('exit', (code) => {
      exitGrace = setTimeout(() => {
        if (settled) return
        settled = true
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve(code)
      }, EXIT_GRACE_MS)
    })
  })

  if (exitGrace) clearTimeout(exitGrace)
  if (timer) clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)

  return { exitCode, timedOut, stdoutTail, stderrTail }
}

const EXIT_GRACE_MS = 1000
/** Time a process tree gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000

/** Spawn argv without a shell (cmd.exe only for Windows .cmd/.bat shims), stdin closed, provider keys stripped. */
function spawnArgv(argv: string[], cwd: string): ChildProcess {
  const program = argv[0]!
  const useShell = process.platform === 'win32' && needsWindowsShell(program)
  return useShell
    ? spawn('cmd.exe', ['/d', '/s', '/c', windowsQuoteJoin(argv)], {
        cwd,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(program, argv.slice(1), {
        cwd,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Kill a child process and its whole tree: SIGTERM to the process group, then
 * SIGKILL once it exits or after `graceMs` (Windows: `taskkill /T /F`). Runs even
 * after the direct child exited: its process group may still hold live grandchildren.
 */
export async function killTree(child: ChildProcess | null | undefined, graceMs = KILL_GRACE_MS): Promise<void> {
  if (!child || child.pid === undefined) return
  const exited = new Promise<void>((resolve) => {
    if (hasExited(child)) return resolve()
    const timer = setTimeout(resolve, graceMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => resolve())
        .on('close', () => resolve())
    })
    await exited
    return
  }
  signalGroup(child, 'SIGTERM')
  await exited
  signalGroup(child, 'SIGKILL') // grandchildren that ignored SIGTERM
}

/** Fire-and-forget killTree. */
export function killChild(child: ChildProcess | null | undefined): void {
  void killTree(child)
}

/** A long-running command started by `run_command` with `background: true`. */
export interface BackgroundJob {
  id: string
  command: string
  pid: number | undefined
  child: ChildProcess
  /** Bounded combined stdout/stderr lines; `dropped` counts lines evicted from the front. */
  lines: string[]
  dropped: number
  /** Absolute line index up to which job_output has returned output. */
  read: number
  running: boolean
  exitCode: number | null
  startedAt: number
}

const JOB_MAX_LINES = 2000
const JOB_MAX_LINE_CHARS = 4000
/** Every job child started by this process, so session teardown or process exit can kill them. */
const liveJobs = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * Start a command in the background with a bounded output buffer. The child is
 * unref'd so it never keeps Hesdor alive; on process exit its tree is killed.
 */
export function startJob(id: string, command: string, argv: string[], cwd: string): BackgroundJob {
  if (!argv[0]) throw new Error('empty command')
  const child = spawnArgv(argv, cwd)
  const job: BackgroundJob = {
    id,
    command,
    pid: child.pid,
    child,
    lines: [],
    dropped: 0,
    read: 0,
    running: true,
    exitCode: null,
    startedAt: Date.now(),
  }
  const push = (line: string): void => {
    job.lines.push(line.length > JOB_MAX_LINE_CHARS ? `${line.slice(0, JOB_MAX_LINE_CHARS)}…` : line)
    if (job.lines.length > JOB_MAX_LINES) {
      job.lines.shift()
      job.dropped++
    }
  }
  pump(child.stdout, push)
  pump(child.stderr, push)
  child.once('error', (err) => {
    push(`exec error: ${err.message}`)
    job.running = false
    job.exitCode ??= 127
  })
  child.once('exit', (code) => {
    job.running = false
    job.exitCode = code
  })
  liveJobs.add(child)
  child.unref()
  for (const stream of [child.stdout, child.stderr]) (stream as unknown as { unref?: () => void } | null)?.unref?.()
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // Last resort when the host never called stopAllJobs: only synchronous work is possible here.
    process.once('exit', () => {
      for (const c of liveJobs) {
        if (process.platform !== 'win32') signalGroup(c, 'SIGKILL')
        else if (!hasExited(c)) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      }
    })
  }
  return job
}

/** Kill a background job's whole process tree (SIGTERM, then SIGKILL after a grace period). */
export async function stopJob(job: BackgroundJob, graceMs = KILL_GRACE_MS): Promise<void> {
  // Windows: a long-exited pid may have been reused by an unrelated process, so leave it alone.
  if (!(process.platform === 'win32' && hasExited(job.child))) await killTree(job.child, graceMs)
  liveJobs.delete(job.child)
}

/** Kill every background job this process started. Hosts call this when a session ends. */
export async function stopAllJobs(graceMs = KILL_GRACE_MS): Promise<void> {
  await Promise.all(
    [...liveJobs].map(async (child) => {
      if (!(process.platform === 'win32' && hasExited(child))) await killTree(child, graceMs)
      liveJobs.delete(child)
    }),
  )
}

function pushTail(arr: string[], line: string, cap: number): void {
  arr.push(line)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}

function pump(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let idx = buffer.search(/\r?\n/)
    while (idx >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx).replace(/^\r?\n/, '')
      onLine(line)
      idx = buffer.search(/\r?\n/)
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) onLine(buffer)
  })
}

/** .cmd/.bat shims require cmd.exe; everything else spawns directly. */
export function needsWindowsShell(program: string): boolean {
  if (/\.(exe|com)$/i.test(program)) return false
  if (/\.(cmd|bat)$/i.test(program)) return true
  if (/[\\/]/.test(program)) return false
  const dirs = (process.env.PATH ?? '').split(';').filter((d) => d.trim() !== '')
  const exts = /\.(cmd|bat)$/i.test(path.extname(program)) ? [''] : ['.CMD', '.BAT']
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(path.join(dir.trim(), program + ext))) return true
    }
  }
  return false
}

/** Characters cmd.exe interprets even inside quotes; there is no reliable escape for them. */
const CMD_METACHARS = /[&|<>^%!"\r\n]/

/**
 * Join argv for `cmd.exe /d /s /c`. An argument containing a cmd
 * metacharacter is refused rather than quoted, so `pnpm test & rmdir /s /q C:\`
 * can never reach cmd as two commands.
 */
export function windowsQuoteJoin(argv: string[]): string {
  const bad = argv.find((a) => CMD_METACHARS.test(a))
  if (bad !== undefined) {
    throw new Error(
      `refusing to run through cmd.exe: argument ${JSON.stringify(bad)} contains a shell metacharacter (& | < > ^ % ! " or a line break). Run one command at a time without shell operators.`,
    )
  }
  return argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

/**
 * Hesdor's own model-provider credentials (every preset envKey; a test keeps
 * this in sync). Other secrets are left alone: the user's dev commands may need them.
 */
const PROVIDER_KEY_ENV = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'XAI_API_KEY', 'OPENCODE_API_KEY',
  'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY', 'PERPLEXITY_API_KEY', 'NVIDIA_API_KEY',
  'HF_TOKEN', 'COHERE_API_KEY', 'DEEPINFRA_TOKEN', 'OPENAI_COMPATIBLE_API_KEY', 'ANTHROPIC_COMPATIBLE_API_KEY',
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEEPINFRA_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ZAI_API_KEY', 'DASHSCOPE_API_KEY', 'ALIBABA_CODING_PLAN_API_KEY', 'MINIMAX_API_KEY', 'STEP_API_KEY',
  'AI_GATEWAY_API_KEY', 'REQUESTY_API_KEY', 'NEBIUS_API_KEY', 'NOVITA_API_KEY', 'BASETEN_API_KEY', 'CHUTES_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY', 'LITELLM_API_KEY',
  // web_search backends
  'BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY',
])
const isProviderKey = (name: string): boolean => PROVIDER_KEY_ENV.has(name.toUpperCase()) || /^HESDOR_/i.test(name)

/**
 * Environment for commands and MCP servers the agent starts: the user's
 * environment minus model-provider credentials, so a prompt-injected
 * `node -e "console.log(process.env)"` cannot read them.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!isProviderKey(k)) env[k] = v
  return { ...env, ...extra }
}
