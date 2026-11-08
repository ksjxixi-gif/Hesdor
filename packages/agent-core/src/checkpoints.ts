import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunEvent } from '@hesdor/protocol'
import { runGit } from './git.js'
import { realPathOf } from './paths.js'
import { hesdorGlobalDir } from './plugins.js'

/**
 * Turn checkpoints (roadmap C6) in a shadow Git repository that lives OUTSIDE the
 * project, in the user config dir keyed by the workspace's real path. Each snapshot is
 * `git --git-dir=<shadow> --work-tree=<root> add -A`, so it covers files changed by tools
 * and by shell commands, honours .gitignore, and stores exact bytes (binaries included).
 * The project's own .git is never read or written.
 */

export interface Checkpoint {
  /** Commit id in the shadow repository; pass it to rewindFiles. */
  id: string
  sessionId: string
  /**
   * Number of conversation messages (system prompt excluded) before this turn's prompt.
   * To rewind the chat too: `history.slice(0, turnIndex)`, then re-offer `prompt`.
   */
  turnIndex: number
  /** The turn's prompt (first 200 characters). */
  prompt: string
  createdAt: number
}

export interface CheckpointOptions {
  /** Where shadow repositories live (default: Hesdor's config dir). */
  baseDir?: string
  /** Skip snapshots of workspaces above these sizes (default 20,000 files / 500 MB). */
  maxFiles?: number
  maxBytes?: number
}

export type CheckpointResult = { checkpoint: Checkpoint } | { skipped: string }

export interface RewindResult {
  /** Files written back to their checkpoint content. */
  restored: string[]
  /** Files created after the checkpoint, now deleted. */
  deleted: string[]
  /** Of those, files that were changed outside the agent (between turns) since the checkpoint: their edits are gone. */
  drift: string[]
  /** Snapshot taken just before the rewind; rewindFiles(backupId) undoes the rewind. */
  backupId: string
}

const REF = 'refs/hesdor/checkpoints'
const MAX_FILES = 20_000
const MAX_BYTES = 500 * 1024 * 1024
/** Exact bytes: no EOL conversion, clean/smudge filters or $Id$ expansion from the repo's attributes. */
const ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'

type Kind = 'start' | 'end' | 'backup'
interface Meta {
  kind: Kind
  sessionId: string
  turnIndex: number
  prompt: string
  createdAt: number
  /** Ids this commit had before pruning rewrote the chain, so ids a running session holds still rewind. */
  was?: string[]
}

const commitMessage = (meta: Meta): string => `hesdor ${meta.kind}\n\n${JSON.stringify(meta)}\n`

function shadowDir(root: string, baseDir: string): string {
  const real = realPathOf(root)
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? real.toLowerCase() : real)
    .digest('hex')
    .slice(0, 16)
  return path.join(baseDir, 'checkpoints', key)
}

/** The user's GIT_DIR / GIT_INDEX_FILE / ... must not redirect the shadow repository. */
function shadowEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  return {
    ...env,
    GIT_AUTHOR_NAME: 'hesdor',
    GIT_AUTHOR_EMAIL: 'hesdor@localhost',
    GIT_COMMITTER_NAME: 'hesdor',
    GIT_COMMITTER_EMAIL: 'hesdor@localhost',
  }
}

class Shadow {
  readonly env = shadowEnv()
  constructor(
    readonly root: string,
    readonly dir: string,
  ) {}

  git(args: string[], timeoutMs = 120_000): Promise<string> {
    const base = [`--git-dir=${this.dir}`, `--work-tree=${this.root}`, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true']
    return runGit([...base, ...args], this.root, timeoutMs, this.env)
  }

  async init(): Promise<void> {
    try {
      await stat(path.join(this.dir, 'HEAD'))
      return
    } catch {
      // first checkpoint for this workspace
    }
    await mkdir(this.dir, { recursive: true })
    await this.git(['init', '--quiet'])
    await mkdir(path.join(this.dir, 'info'), { recursive: true })
    await writeFile(path.join(this.dir, 'info', 'attributes'), ATTRIBUTES)
  }

  /** Commit the whole worktree (non-ignored files) on REF and return the commit id. */
  async snapshot(meta: Meta): Promise<string> {
    await this.git(['add', '-A', '--', '.'])
    const tree = (await this.git(['write-tree'])).trim()
    const parent = await this.head()
    const commit = (await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', commitMessage(meta)])).trim()
    await this.git(['update-ref', REF, commit])
    return commit
  }

  async head(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', REF])).trim() || null
    } catch {
      return null
    }
  }

  /** Commits on REF, newest first, with their metadata. */
  async log(limit = 2000): Promise<Array<{ id: string; tree: string; meta: Meta }>> {
    if (!(await this.head())) return []
    const out = await this.git(['log', `-${limit}`, '--format=%H%x1f%T%x1f%b%x1e', REF])
    const entries: Array<{ id: string; tree: string; meta: Meta }> = []
    for (const record of out.split('\x1e')) {
      const [id, tree, body] = record.trim().split('\x1f')
      if (!id || !tree || !body) continue
      try {
        entries.push({ id, tree, meta: JSON.parse(body) as Meta })
      } catch {
        // not one of ours
      }
    }
    return entries
  }

  async changedPaths(from: string, to: string): Promise<Array<{ status: string; path: string }>> {
    const out = await this.git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', from, to])
    const parts = out.split('\0')
    const changes: Array<{ status: string; path: string }> = []
    for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i]!, path: parts[i + 1]! })
    return changes
  }

  /** Non-ignored files the next snapshot would contain, with their total size. */
  async measure(maxFiles: number): Promise<{ files: number; bytes: number }> {
    const out = await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    const files = [...new Set(out.split('\0').filter((f) => f !== ''))]
    if (files.length > maxFiles) return { files: files.length, bytes: 0 }
    let bytes = 0
    for (const f of files) bytes += await stat(path.join(this.root, f)).then((s) => s.size, () => 0)
    return { files: files.length, bytes }
  }
}

const shadowFor = (root: string, opts: CheckpointOptions = {}): Shadow =>
  new Shadow(path.resolve(root), shadowDir(root, opts.baseDir ?? hesdorGlobalDir()))

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const warnedRoots = new Set<string>()

/** Snapshots, rewinds and prunes of one shadow repo run one at a time in this process: gc --prune=now must not drop objects a snapshot is still writing. */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(dir) ?? Promise.resolve()).then(fn)
  queues.set(dir, run.catch(() => {}))
  return run
}

/**
 * Snapshot the workspace before a user turn runs, so the turn can be rewound. Call it at
 * the start of every turn (run.ts does). Never throws: a workspace that is too large or a
 * git failure returns `{ skipped }`, and `emit` (once per workspace) tells the user why.
 */
export async function checkpointTurn(
  root: string,
  sessionId: string,
  turnIndex: number,
  opts: CheckpointOptions & { prompt?: string; emit?: (event: RunEvent) => void } = {},
): Promise<CheckpointResult> {
  const meta: Meta = { kind: 'start', sessionId, turnIndex, prompt: (opts.prompt ?? '').slice(0, 200), createdAt: Date.now() }
  const result = await snapshotWorkspace(root, meta, opts)
  if (!('skipped' in result)) return { checkpoint: { id: result.id, sessionId, turnIndex, prompt: meta.prompt, createdAt: meta.createdAt } }
  if (!warnedRoots.has(path.resolve(root))) {
    warnedRoots.add(path.resolve(root))
    opts.emit?.({ type: 'checkpoint.skipped', reason: result.skipped })
  }
  return result
}

/**
 * Snapshot the workspace after a turn finished. Optional but recommended (run.ts does it):
 * changes made between this snapshot and the next turn's are "outside the agent", which is
 * how rewindFiles reports drift. Never throws.
 */
export async function endTurnCheckpoint(root: string, sessionId: string, turnIndex: number, opts: CheckpointOptions = {}): Promise<void> {
  await snapshotWorkspace(root, { kind: 'end', sessionId, turnIndex, prompt: '', createdAt: Date.now() }, opts)
}

function snapshotWorkspace(root: string, meta: Meta, opts: CheckpointOptions): Promise<{ id: string } | { skipped: string }> {
  const shadow = shadowFor(root, opts)
  return serialized(shadow.dir, () => snapshotNow(shadow, meta, opts))
}

async function snapshotNow(shadow: Shadow, meta: Meta, opts: CheckpointOptions): Promise<{ id: string } | { skipped: string }> {
  try {
    await shadow.init()
    const maxFiles = opts.maxFiles ?? MAX_FILES
    const maxBytes = opts.maxBytes ?? MAX_BYTES
    const size = await shadow.measure(maxFiles)
    if (size.files > maxFiles || size.bytes > maxBytes) {
      return {
        skipped: `checkpoints are off for this workspace: ${size.files > maxFiles ? `more than ${maxFiles} files` : `${Math.round(size.bytes / 1024 / 1024)} MB of files`} outside .gitignore (limit ${maxFiles} files / ${Math.round(maxBytes / 1024 / 1024)} MB). Add build output and data to .gitignore to enable them.`,
      }
    }
    return { id: await shadow.snapshot(meta) }
  } catch (err) {
    return { skipped: `checkpoint failed: ${message(err)}` }
  }
}

/** Turn checkpoints for a workspace, newest first; only `sessionId`'s when given. */
export async function listCheckpoints(root: string, opts: CheckpointOptions & { sessionId?: string } = {}): Promise<Checkpoint[]> {
  const shadow = shadowFor(root, opts)
  let entries: Awaited<ReturnType<Shadow['log']>>
  try {
    entries = await shadow.log()
  } catch {
    return []
  }
  return entries
    .filter((e) => e.meta.kind === 'start' && (opts.sessionId === undefined || e.meta.sessionId === opts.sessionId))
    .map((e) => ({ id: e.id, sessionId: e.meta.sessionId, turnIndex: e.meta.turnIndex, prompt: e.meta.prompt, createdAt: e.meta.createdAt }))
}

/**
 * Restore every non-ignored file to its state at `checkpointId`: changed and deleted files
 * are written back, files created since are removed. Takes a backup snapshot first
 * (`backupId`), and reports `drift`: files someone changed outside the agent since the
 * checkpoint, whose edits the rewind discards. Ignored files (node_modules, build output)
 * are never touched. The conversation is the host's job: `history.slice(0, turnIndex)`.
 */
export async function rewindFiles(root: string, checkpointId: string, opts: CheckpointOptions = {}): Promise<RewindResult> {
  if (!/^[0-9a-f]{7,64}$/i.test(checkpointId)) throw new Error(`invalid checkpoint id "${checkpointId}"`)
  const shadow = shadowFor(root, opts)
  return serialized(shadow.dir, () => rewindNow(shadow, checkpointId))
}

async function rewindNow(shadow: Shadow, checkpointId: string): Promise<RewindResult> {
  const history = await shadow.log()
  const isId = (id: string): boolean => id === checkpointId || id.startsWith(checkpointId.toLowerCase())
  const targetAt = history.findIndex((e) => isId(e.id) || e.meta.was?.some(isId))
  if (targetAt < 0) throw new Error(`no checkpoint ${checkpointId} for this workspace`)
  const target = history[targetAt]!.id

  const backupId = await shadow.snapshot({ kind: 'backup', sessionId: '', turnIndex: -1, prompt: '', createdAt: Date.now() })
  const changes = await shadow.changedPaths(target, backupId)

  // Outside the agent = between the end of one turn and the next snapshot after it.
  const chronological = [{ id: backupId, kind: 'backup' as Kind }, ...history.slice(0, targetAt + 1).map((e) => ({ id: e.id, kind: e.meta.kind }))].reverse()
  const outside = new Set<string>()
  for (let i = 0; i + 1 < chronological.length; i++) {
    if (chronological[i]!.kind !== 'end') continue
    for (const c of await shadow.changedPaths(chronological[i]!.id, chronological[i + 1]!.id)) outside.add(c.path)
  }

  // The index holds the backup snapshot, so this rewrites changed files and removes added ones.
  await shadow.git(['read-tree', '-u', '--reset', target])
  return {
    restored: changes.filter((c) => c.status !== 'A').map((c) => c.path),
    deleted: changes.filter((c) => c.status === 'A').map((c) => c.path),
    drift: changes.filter((c) => outside.has(c.path)).map((c) => c.path),
    backupId,
  }
}

export interface PruneOptions extends CheckpointOptions {
  /** Turn checkpoints kept per workspace, newest first (default 100). */
  keep?: number
  /** Checkpoints older than this many days are dropped (default 30). */
  maxAgeDays?: number
  now?: number
}

export interface PruneResult {
  /** Turn checkpoints removed and kept. */
  removed: number
  kept: number
}

const KEEP = 100
const MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000
const STAMP = 'hesdor-pruned'

/** Apply the retention limits to one workspace's checkpoints now. */
export function pruneCheckpoints(root: string, opts: PruneOptions = {}): Promise<PruneResult> {
  const shadow = shadowFor(root, opts)
  return serialized(shadow.dir, () => pruneNow(shadow, opts))
}

/** Prune every workspace's shadow repo in the store, including those of deleted projects. */
export async function pruneAllCheckpoints(opts: PruneOptions = {}): Promise<PruneResult & { repos: number; failed: string[] }> {
  const base = path.join(opts.baseDir ?? hesdorGlobalDir(), 'checkpoints')
  const total = { removed: 0, kept: 0, repos: 0, failed: [] as string[] }
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue // a symlink is not followed
    const dir = path.join(base, entry.name)
    try {
      // Rewriting history needs no work tree; the shadow dir stands in for it.
      const r = await serialized(dir, () => pruneNow(new Shadow(dir, dir), opts))
      total.removed += r.removed
      total.kept += r.kept
      total.repos++
    } catch (err) {
      total.failed.push(`${entry.name}: ${message(err)}`)
    }
  }
  return total
}

/**
 * Session-start retention, at most once a day per workspace (a stamp file in its shadow repo).
 * Never throws; callers do not await it.
 */
export async function autoPruneCheckpoints(root: string, opts: PruneOptions = {}): Promise<PruneResult | undefined> {
  try {
    const shadow = shadowFor(root, opts)
    const stamp = path.join(shadow.dir, STAMP)
    const last = await stat(stamp).then((s) => s.mtimeMs, () => 0)
    if ((opts.now ?? Date.now()) - last < DAY_MS) return undefined
    await stat(path.join(shadow.dir, 'HEAD')) // no checkpoints yet: nothing to do
    await writeFile(stamp, '') // before pruning, so a failing prune is not retried on every start
    return await pruneCheckpoints(root, opts)
  } catch {
    return undefined
  }
}

/**
 * Keep the newest `keep` turn checkpoints younger than `maxAgeDays`: the chain is rebuilt from the
 * kept commits (same trees and metadata, old ids recorded in `was`) and swapped in only if no other
 * process moved it meanwhile, then `git gc --prune=now` frees the space.
 * shortcut: another hesdor process snapshotting this workspace during the gc can lose that one snapshot; prune runs at most daily.
 */
async function pruneNow(shadow: Shadow, opts: PruneOptions): Promise<PruneResult> {
  const head = await shadow.head()
  if (!head) return { removed: 0, kept: 0 }
  const keep = opts.keep ?? KEEP
  const oldest = (opts.now ?? Date.now()) - (opts.maxAgeDays ?? MAX_AGE_DAYS) * DAY_MS
  const history = await shadow.log(1_000_000_000)
  const starts = (entries: typeof history): number => entries.filter((e) => e.meta.kind === 'start').length
  let seen = 0
  const cut = history.findIndex((e) => e.meta.createdAt < oldest || (e.meta.kind === 'start' && ++seen > keep))
  if (cut < 0) return { removed: 0, kept: starts(history) }
  const kept = history.slice(0, cut)
  let parent: string | null = null
  for (const e of [...kept].reverse()) {
    const meta: Meta = { ...e.meta, was: [...(e.meta.was ?? []), e.id] }
    parent = (await shadow.git(['commit-tree', e.tree, ...(parent ? ['-p', parent] : []), '-m', commitMessage(meta)])).trim()
  }
  // Compare-and-swap on the old head: if another process added a checkpoint, this fails and nothing is lost.
  await shadow.git(parent ? ['update-ref', REF, parent, head] : ['update-ref', '-d', REF, head])
  await shadow.git(['gc', '--prune=now', '--quiet'], 600_000)
  return { removed: starts(history.slice(cut)), kept: starts(kept) }
}
