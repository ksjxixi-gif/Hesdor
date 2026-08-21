import type { AgentMode, ToolRisk } from '@hesdor/protocol'

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
    const sub = (rest[0] ?? '').replace(/^["']|["']$/g, '')
    const flags = rest.slice(1)
    const hasFlag = (...names: string[]) => flags.some((f) => names.some((n) => f === n || f.startsWith(n)))
    if (sub === 'reset' && hasFlag('--hard')) {
      return { program: 'git', destructive: true, network: false, reason: 'git reset --hard discards changes' }
    }
    if (sub === 'clean' && hasFlag('-f')) {
      return { program: 'git', destructive: true, network: false, reason: 'git clean -f deletes untracked files' }
    }
    if (sub === 'push' && hasFlag('--force', '-f', '--force-with-lease')) {
      return { program: 'git', destructive: true, network: true, reason: 'forced push rewrites remote history' }
    }
    if (sub === 'push') {
      return { program: 'git', destructive: false, network: true, reason: 'pushes to a remote' }
    }
    if (sub === 'filter-branch' || sub === 'reflog') {
      return { program: 'git', destructive: true, network: false, reason: 'rewrites history' }
    }
  }

  // Package managers publishing or installing touch the network / system.
  if ((base === 'npm' || base === 'pnpm' || base === 'yarn' || base === 'bun') && rest.includes('publish')) {
    return { program: base, destructive: true, network: true, reason: 'publishes packages publicly' }
  }

  if (NETWORK_PROGRAMS.has(base)) {
    return { program: base, destructive: false, network: true, reason: 'network access' }
  }

  // PowerShell / cmd wrappers: inspect the inner command defensively.
  if (base === 'powershell' || base === 'pwsh' || base === 'cmd') {
    const inner = argv.slice(1).join(' ').toLowerCase()
    if (/(^|\s|-)(rm|rmdir|del|rd|remove-item|format|diskpart)\b/.test(inner)) {
      return { program: base, destructive: true, network: false, reason: 'destructive operation inside shell wrapper' }
    }
    if (/invoke-webrequest|iwr|curl|wget/.test(inner)) {
      return { program: base, destructive: false, network: true, reason: 'network access inside shell wrapper' }
    }
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
