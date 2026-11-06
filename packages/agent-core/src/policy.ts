import type { AgentMode, ToolRisk } from '@hesdor/protocol'
import type { ApprovalRequest, ToolContext } from './context.js'
import { globToRegex } from './ignore.js'

const MODE_ALLOWED: Record<AgentMode, readonly ToolRisk[]> = {
  build: ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'DESTRUCTIVE'],
  plan: ['READ'],
  ask: ['READ'],
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

/**
 * Hard permission gate. In plan/ask modes anything above READ is refused by
 * the runtime itself — the model is never merely "asked not to" edit.
 */
export function riskAllowedInMode(mode: AgentMode, risk: ToolRisk): boolean {
  return MODE_ALLOWED[mode].includes(risk)
}

export function assertRiskAllowed(mode: AgentMode, toolName: string, risk: ToolRisk): void {
  if (!riskAllowedInMode(mode, risk)) {
    throw new PermissionDeniedError(
      `permission denied: tool "${toolName}" requires risk level ${risk}, which is not allowed in ${mode} mode. ` +
        `The current mode is read-only; ask the user to switch to build mode for write or execute actions.`,
    )
  }
}

export interface CommandClassification {
  program: string
  destructive: boolean
  network: boolean
  reason?: string
}

const DESTRUCTIVE_PROGRAMS = new Set([
  'rm',
  'rmdir',
  'del',
  'rd',
  'shred',
  'mkfs',
  'mkfs.ext4',
  'dd',
  'diskpart',
  'format',
  'remove-item',
])

const PRIVILEGE_PROGRAMS = new Set(['sudo', 'su', 'doas', 'runas'])

const NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'telnet',
  'ssh',
  'scp',
  'ftp',
  'iwr',
  'invoke-webrequest',
])

const SHELL_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'busybox', 'wsl', 'cmd', 'powershell', 'pwsh',
])

/** Interpreter flags that execute code given on the command line. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
}

const WRAPPER_PROGRAMS = new Set(['npx', 'pnpx', 'bunx', 'xargs', 'env', 'nohup', 'nice', 'timeout', 'watch', 'exec', 'command'])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Git global options that can make git run arbitrary programs or act on another repository. */
const GIT_RISKY_GLOBALS = /^(-c|--config-env|--exec-path|--git-dir|--work-tree)(=|$)/
/** Git global options followed by a separate value argument. */
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])

/** Structural git classification on the original-case args (so -d and -D differ). */
function classifyGit(args: string[]): CommandClassification | undefined {
  let i = 0
  let riskyGlobal: string | undefined
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!
    if (GIT_RISKY_GLOBALS.test(a)) riskyGlobal ??= a.split('=')[0]
    i += GIT_VALUE_GLOBALS.has(a) ? 2 : 1
  }
  if (riskyGlobal) {
    return { program: 'git', destructive: true, network: false, reason: `git ${riskyGlobal} can run programs or act on another repository` }
  }
  const sub = (args[i] ?? '').replace(/^["']|["']$/g, '')
  const flags = args.slice(i + 1)
  const has = (...names: string[]) => flags.some((f) => names.some((n) => f === n || f.startsWith(`${n}=`)))
  const hasShort = (ch: string) => flags.some((f) => /^-[a-zA-Z]+$/.test(f) && f.includes(ch))
  const destroys = (reason: string, network = false): CommandClassification => ({ program: 'git', destructive: true, network, reason })

  switch (sub) {
    case 'reset':
      return has('--hard', '--keep', '--merge') ? destroys('git reset discards changes') : undefined
    case 'clean':
      return has('--force') || hasShort('f') ? destroys('git clean deletes untracked files') : undefined
    case 'checkout':
      return flags.includes('--') || flags.includes('.') || has('--force') || hasShort('f')
        ? destroys('git checkout overwrites local changes')
        : undefined
    case 'restore':
      return !flags.includes('--staged') || flags.includes('--worktree') ? destroys('git restore discards local changes') : undefined
    case 'stash':
      return flags[0] === 'drop' || flags[0] === 'clear' ? destroys('deletes stashed changes') : undefined
    case 'branch':
      return hasShort('D') || ((has('--delete') || hasShort('d')) && (has('--force') || hasShort('f')))
        ? destroys('force-deletes a branch')
        : undefined
    case 'push':
      return has('--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete') ||
        hasShort('f') ||
        hasShort('d') ||
        flags.some((f) => /^[+:]/.test(f))
        ? destroys('forced push or remote deletion rewrites remote history', true)
        : { program: 'git', destructive: false, network: true, reason: 'pushes to a remote' }
    case 'reflog':
      return flags[0] === 'expire' || flags[0] === 'delete' ? destroys('deletes reflog entries') : undefined
    case 'filter-branch':
    case 'filter-repo':
      return destroys('rewrites history')
    case 'update-ref':
      return has('-d', '--stdin') ? destroys('deletes or rewrites refs') : undefined
    case 'config':
      return !has('--get', '--get-all', '--get-regexp', '--list', '-l') && flags.filter((f) => !f.startsWith('-')).length >= 2
        ? destroys('changes git configuration, which can make git run programs')
        : undefined
    default:
      return undefined
  }
}

function baseName(program: string): string {
  return program.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/**
 * Structural command classification on parsed argv plus defensive pattern
 * checks over the raw line as a second layer.
 */
export function classifyCommand(argv: string[]): CommandClassification {
  const program = argv[0] ?? ''
  const base = baseName(program)
  const rest = argv.slice(1).map((a) => a.toLowerCase())

  if (PRIVILEGE_PROGRAMS.has(base)) {
    return { program: base, destructive: true, network: false, reason: 'privilege escalation' }
  }
  if (DESTRUCTIVE_PROGRAMS.has(base)) {
    return { program: base, destructive: true, network: false, reason: 'destructive filesystem operation' }
  }

  if (base === 'git') {
    const git = classifyGit(argv.slice(1))
    if (git) return git
  }

  // Anything that runs code we cannot see asks first: a shell, inline code,
  // a freshly downloaded package, or a wrapper around another command.
  // shortcut: a denylist stopgap; replace with allow/ask/deny rules (roadmap C5).
  if (SHELL_PROGRAMS.has(base)) {
    return { program: base, destructive: true, network: false, reason: 'runs a shell, which can execute anything' }
  }
  const evalFlags = INLINE_CODE_FLAGS[base]
  if (evalFlags && rest.some((a) => evalFlags.includes(a) || evalFlags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))) {
    return { program: base, destructive: true, network: false, reason: 'runs inline code' }
  }
  if (WRAPPER_PROGRAMS.has(base)) {
    return { program: base, destructive: true, network: false, reason: 'runs another command' }
  }
  if (PACKAGE_MANAGERS.has(base) && ['dlx', 'exec', 'x'].includes(rest[0] ?? '') && !(base === 'pnpm' && rest[0] === 'exec')) {
    return { program: base, destructive: true, network: true, reason: 'downloads and runs a package' }
  }
  if (base === 'find' && rest.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(a))) {
    return { program: base, destructive: true, network: false, reason: 'find can delete files or run commands' }
  }

  // Package managers publishing or installing touch the network / system.
  if (PACKAGE_MANAGERS.has(base) && rest.includes('publish')) {
    return { program: base, destructive: true, network: true, reason: 'publishes packages publicly' }
  }

  if (NETWORK_PROGRAMS.has(base)) {
    return { program: base, destructive: false, network: true, reason: 'network access' }
  }

  // Defensive second layer over the raw argument line.
  const raw = argv.join(' ')
  if (/\brm\s+(-{1,2}[^\s]+\s+)*-{1,2}[a-z]*r/i.test(raw) && /\b(rm|del)\b/i.test(raw)) {
    return { program: base, destructive: true, network: false, reason: 'recursive deletion detected' }
  }
  if (/>\s*\/dev\/(sd|nvme|disk)/i.test(raw)) {
    return { program: base, destructive: true, network: false, reason: 'writes directly to a block device' }
  }

  return { program: base, destructive: false, network: false }
}

// ── Permission rules (roadmap C5) ─────────────────────────────────────────

/**
 * A command rule is an argv prefix: `["pnpm", "test"]`, or the same as one string
 * (`"pnpm test"`, split with run_command's quoting rules). `{ write: glob }` matches
 * repository-relative paths the file tools write or delete (`secrets/**`, `*.pem`;
 * a glob without `/` matches the file name at any depth). `{ fetch: glob }` matches the host
 * name web_fetch requests (`docs.python.org`, `*.mozilla.org`).
 */
export type PermissionRule = string | string[] | { write: string } | { fetch: string }

export interface PermissionRules {
  allow?: PermissionRule[]
  ask?: PermissionRule[]
  deny?: PermissionRule[]
}

/**
 * Rules in effect for a session. Only user scope can loosen (allow); the project's
 * `.hesdor/permissions.json` can only add ask/deny rules, so a cloned repository
 * can never grant itself permissions.
 */
export interface PermissionPolicy {
  user: PermissionRules
  project: Pick<PermissionRules, 'ask' | 'deny'>
}

export type PermissionSource = 'user' | 'project' | 'built-in' | 'default'

export interface PermissionDecision {
  action: 'allow' | 'ask' | 'deny'
  source: PermissionSource
  reason: string
  /** The matching rule, as written in the config. */
  rule?: PermissionRule
}

/** Split a command line into argv with shell-like quoting (no operators, globs or variables). */
export function tokenize(command: string): string[] {
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

/** Throws on anything that is not a valid rule list, so a typo never silently drops a deny rule. */
export function validateRules(value: unknown, where: string): PermissionRules {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where}: "permissions" must be an object`)
  const out: PermissionRules = {}
  for (const [key, list] of Object.entries(value)) {
    if (key !== 'allow' && key !== 'ask' && key !== 'deny') throw new Error(`${where}: unknown permissions key "${key}" (allow | ask | deny)`)
    if (!Array.isArray(list)) throw new Error(`${where}: permissions.${key} must be an array`)
    for (const rule of list as unknown[]) {
      const ok =
        (typeof rule === 'string' && tokenize(rule).length > 0) ||
        (Array.isArray(rule) && rule.length > 0 && rule.every((t) => typeof t === 'string')) ||
        (typeof rule === 'object' && rule !== null && !Array.isArray(rule) &&
          ['write', 'fetch'].some((k) => typeof (rule as Record<string, unknown>)[k] === 'string' && (rule as Record<string, unknown>)[k] !== ''))
      if (!ok) throw new Error(`${where}: invalid permissions.${key} rule ${JSON.stringify(rule)}`)
    }
    out[key] = list as PermissionRule[]
  }
  return out
}

export function ruleToString(rule: PermissionRule): string {
  if (typeof rule === 'string') return JSON.stringify(rule)
  if (Array.isArray(rule)) return JSON.stringify(rule)
  return 'fetch' in rule ? `{ fetch: ${JSON.stringify(rule.fetch)} }` : `{ write: ${JSON.stringify(rule.write)} }`
}

const isWriteRule = (rule: PermissionRule): rule is { write: string } => typeof rule === 'object' && !Array.isArray(rule) && 'write' in rule
const isFetchRule = (rule: PermissionRule): rule is { fetch: string } => typeof rule === 'object' && !Array.isArray(rule) && 'fetch' in rule
const commandRules = (list?: PermissionRule[]): Array<string | string[]> =>
  (list ?? []).filter((r): r is string | string[] => typeof r === 'string' || Array.isArray(r))
const ruleArgv = (rule: string | string[]): string[] => (typeof rule === 'string' ? tokenize(rule) : rule)

/** Program token without a Windows shim extension; case-insensitive on Windows. */
function programOf(token: string): string {
  const p = token.replace(/\.(exe|cmd|bat)$/i, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** argv with git's global options removed (`git -C x --no-pager push` -> `git push`). */
function withoutGitGlobals(argv: string[]): string[] {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) i += GIT_VALUE_GLOBALS.has(argv[i]!) ? 2 : 1
  return [argv[0]!, ...argv.slice(i)]
}

/**
 * Prefix match. Strict (allow rules): the program token must match exactly, so `./pnpm`
 * is not `pnpm`. Loose (ask/deny rules): any path to the program and git's global
 * options are seen through, so a deny rule is not dodged by `/usr/bin/git -C . push`.
 */
function prefixMatches(rule: string[], argv: string[], loose: boolean, exact = false): boolean {
  const same = (a: string[]): boolean =>
    rule.length > 0 &&
    rule.length <= a.length &&
    (!exact || rule.length === a.length) &&
    (loose ? baseName(a[0]!) === baseName(rule[0]!) : programOf(a[0]!) === programOf(rule[0]!)) &&
    rule.every((t, i) => i === 0 || t === a[i])
  return same(argv) || (loose && baseName(argv[0] ?? '') === 'git' && same(withoutGitGlobals(argv)))
}

/** Commands that never need approval: read-only git, listing, and the usual verify scripts. */
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'shortlog', 'describe', 'branch', 'tag', 'remote', 'stash'])
const SAFE_SCRIPTS = new Set(['test', 'lint', 'build', 'typecheck', 'check', 'tsc', 'vitest', 'jest'])

function builtInSafe(argv: string[]): boolean {
  const base = baseName(argv[0] ?? '')
  const sub = argv[1]
  if (['ls', 'dir', 'pwd'].includes(base)) return true
  if (base === 'git' && sub !== undefined && SAFE_GIT.has(sub)) {
    // These options write files or run a program even on read-only subcommands.
    if (argv.some((a) => /^(--output|-O|--open-files-in-pager|--ext-diff)/.test(a))) return false
    // Arguments to branch/tag/remote/stash can create or delete; only the listing forms are safe.
    if (['branch', 'tag', 'remote'].includes(sub)) return argv.length === 2
    if (sub === 'stash') return argv[2] === 'list'
    return true
  }
  if (PACKAGE_MANAGERS.has(base) && sub !== undefined) {
    const script = sub === 'run' ? argv[2] : sub
    return script !== undefined && SAFE_SCRIPTS.has(script)
  }
  return (base === 'cargo' && ['test', 'build', 'check', 'clippy'].includes(sub ?? '')) || (base === 'go' && ['test', 'build', 'vet'].includes(sub ?? ''))
}

/**
 * Decide whether run_command may run `argv`. Order: deny rules > ask rules > built-in
 * classification (risky commands ask; only a user allow rule naming exactly this command
 * relaxes them) > user allow prefix rules > built-in safe list > default ask. What a
 * `default` ask means is the host's call (see shell.ts): headless without --yes allows it.
 */
export function decideCommand(argv: string[], policy?: PermissionPolicy): PermissionDecision {
  for (const action of ['deny', 'ask'] as const) {
    for (const source of ['user', 'project'] as const) {
      const rule = commandRules(policy?.[source][action]).find((r) => prefixMatches(ruleArgv(r), argv, true))
      if (rule !== undefined) return { action, source, rule, reason: `${source} ${action} rule ${ruleToString(rule)}` }
    }
  }
  const userAllow = commandRules(policy?.user.allow)
  const cls = classifyCommand(argv)
  if (cls.destructive || cls.network) {
    const exact = userAllow.find((r) => prefixMatches(ruleArgv(r), argv, false, true))
    if (exact !== undefined) return { action: 'allow', source: 'user', rule: exact, reason: `user allow rule ${ruleToString(exact)}` }
    return { action: 'ask', source: 'built-in', reason: `${cls.destructive ? 'DESTRUCTIVE' : 'NETWORK'}: ${cls.reason ?? 'risky operation'}` }
  }
  const allow = userAllow.find((r) => prefixMatches(ruleArgv(r), argv, false))
  if (allow !== undefined) return { action: 'allow', source: 'user', rule: allow, reason: `user allow rule ${ruleToString(allow)}` }
  if (builtInSafe(argv)) return { action: 'allow', source: 'built-in', reason: 'built-in safe command' }
  return { action: 'ask', source: 'default', reason: 'no rule allows this command' }
}

function globMatches(glob: string, relPath: string): boolean {
  const ci = process.platform === 'win32'
  const pattern = (ci ? glob.toLowerCase() : glob).replace(/^\.?\//, '')
  const p = ci ? relPath.toLowerCase() : relPath
  const re = globToRegex(pattern, true)
  return pattern.includes('/') ? re.test(p) : re.test(p.slice(p.lastIndexOf('/') + 1))
}

/**
 * Decide a file write/delete at repository-relative `relPath`. Deny refuses, ask needs
 * explicit approval, a user allow rule skips the diff review, and `default` keeps the
 * normal review flow. The `.git` guard in paths.ts applies regardless.
 */
export function decideWrite(relPath: string, policy?: PermissionPolicy): PermissionDecision {
  const matches = (r: PermissionRule): boolean => isWriteRule(r) && globMatches(r.write, relPath)
  return decideByRules(matches, policy, { action: 'allow', source: 'default', reason: 'no rule matches; the change is reviewed as usual' })
}

/**
 * Decide a web_fetch of `host` (case-insensitive glob; `*` also spans dots). Without a rule
 * the user is asked; a host allow rule fetches without asking.
 */
export function decideFetch(host: string, policy?: PermissionPolicy): PermissionDecision {
  const matches = (r: PermissionRule): boolean => isFetchRule(r) && globToRegex(r.fetch.toLowerCase(), true).test(host.toLowerCase())
  return decideByRules(matches, policy, { action: 'ask', source: 'default', reason: `no rule allows fetching from ${host}` })
}

/** deny > ask (user, then project) > user allow > fallback. */
function decideByRules(matches: (r: PermissionRule) => boolean, policy: PermissionPolicy | undefined, fallback: PermissionDecision): PermissionDecision {
  for (const action of ['deny', 'ask'] as const) {
    for (const source of ['user', 'project'] as const) {
      const rule = policy?.[source][action]?.find(matches)
      if (rule !== undefined) return { action, source, rule, reason: `${source} ${action} rule ${ruleToString(rule)}` }
    }
  }
  const allow = policy?.user.allow?.find(matches)
  if (allow !== undefined) return { action: 'allow', source: 'user', rule: allow, reason: `user allow rule ${ruleToString(allow)}` }
  return fallback
}

/**
 * Ask the host to approve, or refuse when approvals are off (headless without --yes).
 * `req.argv` lets the host offer "always allow" and persist it as a user rule.
 */
export async function requireUserApproval(
  ctx: Pick<ToolContext, 'approvalsEnabled' | 'requestApproval'>,
  req: ApprovalRequest,
  what: string,
): Promise<void> {
  if (!ctx.approvalsEnabled) {
    throw new PermissionDeniedError(`blocked: ${what}. Explicit approval is required; the user can re-run with approval enabled.`)
  }
  if (!(await ctx.requestApproval(req))) throw new PermissionDeniedError(`the user denied: ${what}`)
}
