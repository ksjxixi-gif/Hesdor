import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentMode, RunEvent } from '@hesdor/protocol'
import type { ChildProcess } from 'node:child_process'
import { findGitRoot, getStatus } from './git.js'

export interface ApprovalRequest {
  title: string
  detail?: string
}

/** One undoable prior state of a file. content=null means the file did not exist. */
export interface FileSnapshot {
  path: string
  content: string | null
}

/** Execution context handed to every tool. The host (CLI) provides it. */
export interface ToolContext {
  root: string
  mode: AgentMode
  model: string
  signal: AbortSignal
  emit(event: RunEvent): void
  /** Ask the human to authorize a risky action; resolve false to deny. */
  requestApproval(req: ApprovalRequest): Promise<boolean>
  /** Host-level switch: when false, requestApproval is never consulted and risky actions are denied. */
  approvalsEnabled: boolean
  /** Optional nested agent hook powering the explore tool. */
  subagent?: (task: string, maxSteps?: number) => Promise<string>
  /**
   * Optional pre-apply review gate for file mutations. Receives the path plus
   * before/after content (null = absent). Resolve false to reject the change.
   */
  reviewChange?: (req: { path: string; before: string | null; after: string | null }) => Promise<boolean>
  state: {
    activeChild: ChildProcess | null
    snapshots: FileSnapshot[]
    /** States pushed when undoing, so /redo can restore them. */
    redo: FileSnapshot[]
  }
}

export interface RepoContextInfo {
  root: string
  name: string
  branch: string | null
  statusLines: string[]
  manifests: string[]
  instructions: string | null
}

const MANIFEST_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
]

const MANIFEST_GLOBS = [/\.sln$/, /\.csproj$/]

/**
 * Lightweight repository discovery. Never loads the whole repo into memory:
 * git metadata + a manifest presence check + project instructions.
 */
export async function discoverRepo(startDir: string): Promise<RepoContextInfo> {
  const root = findGitRoot(startDir) ?? path.resolve(startDir)
  const status = await getStatus(root)

  const manifests: string[] = []
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // unreadable root: no manifests
  }
  const names = entries.map((e) => e.name)
  for (const m of MANIFEST_FILES) {
    if (names.includes(m)) manifests.push(m)
  }
  for (const e of entries) {
    if (e.isFile() && MANIFEST_GLOBS.some((re) => re.test(e.name))) manifests.push(e.name)
  }

  let instructions: string | null = null
  try {
    const raw = await readFile(path.join(root, 'HESDOR.md'), 'utf8')
    instructions = raw.length > 8192 ? `${raw.slice(0, 8192)}\n... (truncated)` : raw
  } catch {
    // no HESDOR.md
  }

  return {
    root,
    name: path.basename(root),
    branch: status.branch,
    statusLines: status.entries.slice(0, 30),
    manifests,
    instructions,
  }
}
