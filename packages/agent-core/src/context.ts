import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentMode, RunEvent } from '@hesdor/protocol'
import type { ChildProcess } from 'node:child_process'
import { findGitRoot, getStatus } from './git.js'

export interface ApprovalRequest {
  title: string
  detail?: string
  /** run_command approvals: the parsed argv, so the host can persist "always allow" (addUserAllowRule). */
  argv?: string[]
  /**
   * What made this ask: 'built-in' (risky command) or 'default' (no rule allows it). Absent or a
   * rule source ('user'/'project') means a rule or hook demands the human, so auto-reviewers must not answer it.
   */
  source?: import('./policy.js').PermissionSource
}

/** One undoable prior state of a file (raw bytes, so binaries survive). content=null means the file did not exist. */
export interface FileSnapshot {
  path: string
  content: Buffer | null
}

/** A named subagent run by the task tool: its own system prompt and tool allowlist. */
export interface SubagentSpec {
  name: string
  systemPrompt: string
  /** Registry tool names the subagent may use. */
  tools: string[]
  /** `provider/model` or a model id for the current provider; the host resolves it. */
  model?: string
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
  /** allow/ask/deny rules. When set, unknown commands ask by default (if approvalsEnabled); see decideCommand. */
  permissions?: import('./policy.js').PermissionPolicy
  /** Optional nested agent hook powering the explore tool, and the task tool when `agent` is given. */
  subagent?: (task: string, maxSteps?: number, agent?: SubagentSpec) => Promise<string>
  /**
   * Optional pre-apply review gate for file mutations. Receives the path plus
   * before/after content (null = absent). Resolve false to reject the change.
   */
  reviewChange?: (req: { path: string; before: string | null; after: string | null }) => Promise<boolean>
  /** The model accepts images (catalog): read_file then returns png/jpeg/gif/webp files as images. */
  imageInput?: boolean
  state: {
    activeChild: ChildProcess | null
    snapshots: FileSnapshot[]
    /** States pushed when undoing, so /redo can restore them. */
    redo: FileSnapshot[]
    /** Background jobs from `run_command` with `background: true`, by job id (created on first use). */
    jobs?: Map<string, import('./exec.js').BackgroundJob>
    /** `mtime:size` of files as the agent last read or wrote them, by absolute path (stale-edit guard). */
    fileStamps?: Map<string, string>
    /** Set once web or MCP output (any NETWORK tool) entered the conversation; approvals then say so. */
    tainted?: boolean
  }
}

export interface RepoContextInfo {
  root: string
  name: string
  branch: string | null
  statusLines: string[]
  manifests: string[]
  instructions: string | null
  /** Which root file supplied `instructions` (e.g. "AGENTS.md"); optional so hand-built infos stay valid. */
  instructionsFile?: string | null
  /** False when the root is a plain directory (no Git repository); optional for hand-built infos. */
  git?: boolean
}

/** Root instruction files, first existing one wins. */
const INSTRUCTION_FILES = ['HESDOR.md', 'AGENTS.md', 'CLAUDE.md']
const MAX_INSTRUCTIONS = 32 * 1024

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
  const gitRoot = findGitRoot(startDir)
  const root = gitRoot ?? path.resolve(startDir)
  // Outside a repository: no git calls; the note reaches the prompt through the status block.
  const status = gitRoot ? await getStatus(root) : { branch: null, entries: [NO_GIT_NOTE] }

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
  let instructionsFile: string | null = null
  for (const file of INSTRUCTION_FILES) {
    try {
      const raw = await readFile(path.join(root, file), 'utf8')
      instructions = raw.length > MAX_INSTRUCTIONS ? `${raw.slice(0, MAX_INSTRUCTIONS)}\n... (truncated)` : raw
      instructionsFile = file
      break
    } catch {
      // missing: try the next file
    }
  }

  return {
    root,
    name: path.basename(root),
    branch: status.branch,
    statusLines: status.entries.slice(0, 30),
    manifests,
    instructions,
    instructionsFile,
    git: gitRoot !== null,
  }
}

const NO_GIT_NOTE = '(not a Git repository: git_status, git_diff and git_log are unavailable)'
