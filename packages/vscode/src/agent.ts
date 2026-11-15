import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

export interface Command {
  command: string
  args: string[]
}

export const NPX_FALLBACK: Command = { command: 'npx', args: ['-y', '@dean_overlord/hesdor'] }

/**
 * The CLI to start: `configured` when it is a path or found on PATH (trying PATHEXT on Windows),
 * else the npx fallback.
 */
export function resolveCommand(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): Command {
  const name = configured.trim() || 'hesdor'
  if (name.includes('/') || name.includes('\\')) return { command: name, args: [] }
  // On Windows npm puts a shell script `hesdor` next to `hesdor.cmd`; only PATHEXT names are runnable.
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase())
      if (exists(file)) return { command: file, args: [] }
    }
  }
  return NPX_FALLBACK
}

/** Quote for cmd.exe when a .cmd/.bat shim must run through the shell (Node refuses them without it). */
export function cmdQuote(arg: string): string {
  return /^[\w\-./:\\=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

/** How to spawn `cmd` with `args` on this platform: Windows .cmd shims and npx go through the shell, quoted. */
export function spawnSpec(cmd: Command, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; shell: boolean } {
  const all = [...cmd.args, ...args]
  const viaShell = platform === 'win32' && (cmd.command === 'npx' || /\.(cmd|bat)$/i.test(cmd.command))
  return viaShell ? { file: [cmd.command, ...all].map(cmdQuote).join(' '), args: [], shell: true } : { file: cmd.command, args: all, shell: false }
}

/** Client-side ACP handlers, provided by the extension. */
export interface ClientHandlers {
  update(params: acp.SessionNotification): void
  permission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>
  readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>
  writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>
  log(line: string): void
}

export interface AgentProcess {
  child: ChildProcess
  connection: acp.ClientConnection
  init: acp.InitializeResponse
}

/** Starts `hesdor acp` in `cwd`, connects ACP over its stdio and runs `initialize`. */
export async function startAgent(cmd: Command, extraArgs: string[], cwd: string, h: ClientHandlers): Promise<AgentProcess> {
  const spec = spawnSpec(cmd, [...extraArgs, 'acp'])
  h.log(`starting: ${spec.shell ? spec.file : [spec.file, ...spec.args].join(' ')}`)
  const child = spawn(spec.file, spec.args, { cwd, shell: spec.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr?.setEncoding('utf8').on('data', (d: string) => h.log(d.trimEnd()))
  const spawned = new Promise<never>((_, reject) => child.once('error', reject))
  const connection = acp
    .client({ name: 'hesdor-vscode' })
    .onNotification('session/update', ({ params }) => h.update(params))
    .onRequest('session/request_permission', ({ params, signal }) => h.permission(params, signal))
    .onRequest('fs/read_text_file', ({ params }) => h.readTextFile(params))
    .onRequest('fs/write_text_file', ({ params }) => h.writeTextFile(params))
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
  child.once('exit', (code) => connection.close(new Error(`hesdor exited${code === null ? '' : ` with code ${code}`}`)))
  try {
    const init = await Promise.race([
      connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, auth: { terminal: true } },
        clientInfo: { name: 'hesdor-vscode', title: 'Hesdor for VS Code', version: '0.1.0' },
      }),
      spawned,
    ])
    return { child, connection, init }
  } catch (err) {
    child.kill()
    throw err
  }
}
