import { spawn, type ChildProcess } from 'node:child_process'
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
  const program = argv[0]
  if (!program) throw new Error('empty command')

  const useShell = process.platform === 'win32' && needsWindowsShell(program)
  const child = useShell
    ? spawn('cmd.exe', ['/d', '/s', '/c', windowsQuoteJoin(argv)], {
        cwd: opts.cwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(program, argv.slice(1), {
        cwd: opts.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
      })

  const tailCap = opts.tailLines ?? 200
  const stdoutTail: string[] = []
  const stderrTail: string[] = []

  let timedOut = false
  let settled = false

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
  })

  if (timer) clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)

  return { exitCode, timedOut, stdoutTail, stderrTail }
}

/** Kill a child process and (best effort) its whole tree. */
export function killChild(child: ChildProcess | null | undefined): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
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

// ponytail: naive Windows quoting; fine for dev commands after policy checks
export function windowsQuoteJoin(argv: string[]): string {
  return argv
    .map((a) =>
      /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a,
    )
    .join(' ')
}
