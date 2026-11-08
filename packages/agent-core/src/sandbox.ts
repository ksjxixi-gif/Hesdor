import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Optional OS sandbox for run_command and background jobs: bubblewrap on Linux,
 * Seatbelt (sandbox-exec) on macOS. Reads stay unrestricted; writes are limited to
 * the workspace (none in read-only) plus a temp dir, and the network is cut unless allowed.
 */
export interface SandboxConfig {
  mode: 'off' | 'workspace-write' | 'read-only'
  /** 'allowlist' is accepted but not enforced yet: the network stays off (see sandboxNotes). */
  network?: 'off' | 'allowlist' | 'on'
  allowDomains?: string[]
  /** Refuse to run commands when the sandbox cannot be set up (default: run them unsandboxed). */
  failIfUnavailable?: boolean
}

const MODES = ['off', 'workspace-write', 'read-only'] as const
const NETWORKS = ['on', 'allowlist', 'off'] as const

/** Throws on anything but a valid sandbox object, so a typo never silently turns the sandbox off. */
export function validateSandbox(value: unknown, where: string): SandboxConfig | undefined {
  if (value === undefined) return undefined
  const fail = (why: string): never => {
    throw new Error(`${where}: sandbox${why}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(' must be an object')
  const v = value as Record<string, unknown>
  for (const k of Object.keys(v)) if (!['mode', 'network', 'allowDomains', 'failIfUnavailable'].includes(k)) fail(` has unknown key "${k}"`)
  if (!MODES.includes(v.mode as never)) fail(`.mode must be one of ${MODES.join(' | ')}`)
  if (v.network !== undefined && !NETWORKS.includes(v.network as never)) fail(`.network must be one of ${NETWORKS.join(' | ')}`)
  if (v.allowDomains !== undefined && !(Array.isArray(v.allowDomains) && v.allowDomains.every((d) => typeof d === 'string' && /^[a-z0-9*.-]+$/i.test(d)))) {
    fail('.allowDomains must be a list of host names')
  }
  if (v.failIfUnavailable !== undefined && typeof v.failIfUnavailable !== 'boolean') fail('.failIfUnavailable must be true or false')
  return v as unknown as SandboxConfig
}

/**
 * Combine two layers so the result is never looser than `base` (a project or managed layer
 * can only tighten): the stricter mode and network, intersected domains, either failIfUnavailable.
 */
export function stricterSandbox(base: SandboxConfig | undefined, other: SandboxConfig | undefined): SandboxConfig | undefined {
  if (!base || !other) return base ?? other
  const mode = MODES[Math.max(MODES.indexOf(base.mode), MODES.indexOf(other.mode))]!
  const network = NETWORKS[Math.max(NETWORKS.indexOf(base.network ?? 'off'), NETWORKS.indexOf(other.network ?? 'off'))]!
  const out: SandboxConfig = { mode, network }
  if (network === 'allowlist') {
    const a = base.network === 'allowlist' ? base.allowDomains : undefined
    const b = other.network === 'allowlist' ? other.allowDomains : undefined
    out.allowDomains = a && b ? a.filter((d) => b.includes(d)) : (a ?? b ?? [])
  }
  if (base.failIfUnavailable || other.failIfUnavailable) out.failIfUnavailable = true
  return out
}

export const sandboxOn = (cfg: SandboxConfig | undefined): cfg is SandboxConfig => cfg !== undefined && cfg.mode !== 'off'

export interface SandboxStatus {
  available: boolean
  backend?: 'bwrap' | 'seatbelt'
  /** Why it is unavailable. */
  reason?: string
}

let cached: SandboxStatus | undefined

/** Probe once per process whether the platform sandbox actually works here (bwrap can be blocked by AppArmor). */
export function sandboxStatus(platform: NodeJS.Platform = process.platform): SandboxStatus {
  if (platform === process.platform && cached) return cached
  let status: SandboxStatus
  if (platform === 'linux') {
    const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--unshare-pid', '--proc', '/proc', 'true'], { timeout: 5000, encoding: 'utf8' })
    status = r.status === 0
      ? { available: true, backend: 'bwrap' }
      : { available: false, reason: r.error ? 'bubblewrap (bwrap) is not installed' : `bwrap failed: ${(r.stderr ?? '').trim().split('\n')[0]} (on Ubuntu 24.04+ AppArmor may block unprivileged user namespaces)` }
  } else if (platform === 'darwin') {
    // Compile a full profile, so a Seatbelt syntax change shows up here instead of failing every command.
    const profile = seatbeltProfile({ mode: 'workspace-write', network: 'off' }, '/private/tmp', ['/private/tmp'])
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { timeout: 5000, encoding: 'utf8' })
    status = r.status === 0
      ? { available: true, backend: 'seatbelt' }
      : { available: false, reason: r.error ? 'sandbox-exec is not available' : `sandbox-exec failed: ${(r.stderr ?? '').trim().split('\n')[0]}` }
  } else {
    status = { available: false, reason: `not supported on ${platform === 'win32' ? 'Windows' : platform} yet` }
  }
  if (platform === process.platform) cached = status
  return status
}

/** Paths inside the workspace that stay read-only: git runs hooks and config-defined programs from them outside the sandbox. */
const PROTECTED = ['.git/hooks', '.git/config']

const networkOn = (cfg: SandboxConfig): boolean => cfg.network === 'on'

/** bwrap argv: / read-only, private /tmp, new /dev and /proc, the workspace writable, network namespace unless allowed. */
export function bwrapArgv(argv: string[], cfg: SandboxConfig, root: string, cwd: string): string[] {
  const out = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--tmpfs', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--die-with-parent']
  if (!networkOn(cfg)) out.push('--unshare-net')
  if (cfg.mode === 'workspace-write') {
    out.push('--bind', root, root)
    for (const p of PROTECTED) out.push('--ro-bind-try', path.posix.join(root, p), path.posix.join(root, p))
  }
  return [...out, '--chdir', cwd, '--', ...argv]
}

const sbString = (s: string): string => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`

/** Seatbelt profile: everything allowed except writes outside the workspace and temp dirs, and IP networking unless allowed. */
export function seatbeltProfile(cfg: SandboxConfig, root: string, tmpDirs: string[]): string {
  const writable = cfg.mode === 'workspace-write' ? [root, ...tmpDirs] : tmpDirs
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((d) => `(subpath ${sbString(d)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
  ]
  if (cfg.mode === 'workspace-write') lines.push(`(deny file-write* ${PROTECTED.map((p) => `(subpath ${sbString(path.posix.join(root, p))})`).join(' ')})`)
  if (!networkOn(cfg)) lines.push('(deny network-outbound (remote ip "*:*"))', '(deny network-inbound (local ip "*:*"))', '(deny network-bind (local ip "*:*"))')
  return lines.join('\n')
}

/** argv wrapped for `backend`. Pure: callers resolve real paths first (see wrapCommand). */
export function sandboxArgv(argv: string[], cfg: SandboxConfig, backend: 'bwrap' | 'seatbelt', root: string, cwd: string, tmpDirs: string[] = []): string[] {
  return backend === 'bwrap' ? bwrapArgv(argv, cfg, root, cwd) : ['/usr/bin/sandbox-exec', '-p', seatbeltProfile(cfg, root, tmpDirs), '--', ...argv]
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Wrap argv for the configured sandbox. Returns the argv unchanged when the sandbox is off, or
 * unavailable and failIfUnavailable is not set; throws when it is unavailable and required.
 */
export function wrapCommand(argv: string[], cfg: SandboxConfig | undefined, root: string, cwd: string): { argv: string[]; sandboxed: boolean } {
  if (!sandboxOn(cfg)) return { argv, sandboxed: false }
  const status = sandboxStatus()
  if (!status.available) {
    if (cfg.failIfUnavailable) throw new Error(`refusing to run: the sandbox is required (sandbox.failIfUnavailable) but unavailable: ${status.reason}`)
    return { argv, sandboxed: false }
  }
  const rootReal = real(root)
  // A missing hooks dir could be created inside the sandbox and then run outside it; git init makes it anyway.
  const gitDir = path.join(rootReal, '.git')
  if (cfg.mode === 'workspace-write' && existsSync(gitDir) && statSync(gitDir).isDirectory()) mkdirSync(path.join(gitDir, 'hooks'), { recursive: true })
  const tmpDirs = [...new Set([real(os.tmpdir()), '/private/tmp'])]
  return { argv: sandboxArgv(argv, cfg, status.backend!, rootReal, real(cwd), tmpDirs), sandboxed: true }
}

/** What the sandbox blocks, for the approval-free note and error hints. */
export function sandboxNotes(cfg: SandboxConfig): { fs: string; net: string } {
  return {
    fs: cfg.mode === 'read-only'
      ? 'the sandbox (sandbox.mode "read-only") allows writes only to the temp dir'
      : 'the sandbox (sandbox.mode "workspace-write") allows writes only inside the workspace and the temp dir; .git/hooks and .git/config are read-only',
    net: cfg.network === 'on'
      ? ''
      : `the sandbox blocks network access (sandbox.network "${cfg.network ?? 'off'}"${cfg.network === 'allowlist' ? ': domain allowlists are not enforced yet, so all network is off' : ''})`,
  }
}

const FS_ERRORS = /\b(EPERM|EACCES|EROFS)\b|Operation not permitted|Permission denied|Read-only file system/i
const NET_ERRORS = /\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|EHOSTUNREACH)\b|getaddrinfo|Could not resolve host|Temporary failure in name resolution|Network is unreachable|network is unreachable|Name or service not known/i

/** A hint naming the sandbox constraint behind a failed command's output, or undefined. */
export function sandboxHint(cfg: SandboxConfig, output: string): string | undefined {
  const notes = sandboxNotes(cfg)
  const hits = [FS_ERRORS.test(output) ? notes.fs : '', NET_ERRORS.test(output) && notes.net ? notes.net : ''].filter(Boolean)
  return hits.length ? `This command ran in the OS sandbox: ${hits.join('; ')}. Do not retry the same way; tell the user if it needs more access.` : undefined
}
