import { lstat, readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configDir, writeFileAtomic } from './config.js'
import type { ChatMessage } from '@hesdor/protocol'

export interface StoredSession {
  id: string
  repo: string
  createdAt: number
  updatedAt: number
  /** First user prompt, used as display title. */
  title: string
  /** Session this one continues from (/clear, /compact); absent for a fresh start. */
  parentId?: string
  /** Conversation without system messages. */
  messages: ChatMessage[]
}

export interface SessionMeta {
  file: string
  id: string
  createdAt: number
  updatedAt: number
  title: string
  messageCount: number
  parentId?: string
}

type IndexEntry = Omit<SessionMeta, 'file'>

const INDEX_FILE = 'index.json'
const ID_RE = /^[a-z0-9-]+$/i

/** Per-project directory under the global Hesdor dir: sessions/<repo-hash>/. */
function sessionsDirFor(repoRoot: string): string {
  const hash = createHash('sha1').update(path.resolve(repoRoot).toLowerCase()).digest('hex').slice(0, 12)
  return path.join(configDir(), 'sessions', hash)
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The index, or one rebuilt from the transcripts when it is missing or unreadable (sessions saved before it existed). */
async function readIndex(dir: string): Promise<IndexEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, INDEX_FILE), 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed as IndexEntry[]
  } catch {
    // missing or corrupt: rebuild below
  }
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== INDEX_FILE)
  } catch {
    return []
  }
  const entries: IndexEntry[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as StoredSession
      if (typeof raw.id !== 'string') continue
      entries.push({
        id: raw.id,
        createdAt: raw.createdAt ?? 0,
        updatedAt: raw.updatedAt ?? 0,
        title: raw.title ?? '(untitled)',
        messageCount: raw.messages?.length ?? 0,
        ...(raw.parentId ? { parentId: raw.parentId } : {}),
      })
    } catch {
      // skip corrupt entries
    }
  }
  return entries
}

// Saves in this process run one at a time so index updates never interleave.
// shortcut: two hesdor processes saving at the same instant can drop one index entry; it returns on that session's next save.
let saveChain: Promise<unknown> = Promise.resolve()

export function saveSession(
  repoRoot: string,
  session: Pick<StoredSession, 'id' | 'messages' | 'title'> & { createdAt?: number; parentId?: string },
): Promise<void> {
  const run = saveChain.then(() => saveNow(repoRoot, session))
  saveChain = run.catch(() => {})
  return run
}

async function saveNow(
  repoRoot: string,
  session: Pick<StoredSession, 'id' | 'messages' | 'title'> & { createdAt?: number; parentId?: string },
): Promise<void> {
  if (session.messages.length === 0) return
  if (!ID_RE.test(session.id)) throw new Error(`invalid session id "${session.id}"`)
  const dir = sessionsDirFor(repoRoot)
  const index = await readIndex(dir)
  const existing = index.find((e) => e.id === session.id)
  const parentId = session.parentId ?? existing?.parentId

  const stored: StoredSession = {
    id: session.id,
    repo: path.resolve(repoRoot),
    createdAt: existing?.createdAt ?? session.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    title: session.title || '(untitled)',
    ...(parentId ? { parentId } : {}),
    messages: capSessionImages(session.messages),
  }
  // Owner-only: transcripts can contain anything the agent read, .env files included.
  await writeFileAtomic(path.join(dir, `${session.id}.json`), JSON.stringify(stored), 0o600)

  const entry: IndexEntry = {
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    title: stored.title,
    messageCount: stored.messages.length,
    ...(parentId ? { parentId } : {}),
  }
  await writeFileAtomic(
    path.join(dir, INDEX_FILE),
    JSON.stringify([...index.filter((e) => e.id !== session.id), entry]),
    0o600,
  )
}

/** Most recent sessions for this repo, newest first. Reads only the index. */
export async function listSessions(repoRoot: string, limit = 10): Promise<SessionMeta[]> {
  const dir = sessionsDirFor(repoRoot)
  return (await readIndex(dir))
    .filter((e) => e.messageCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((e) => ({ ...e, file: path.join(dir, `${e.id}.json`) }))
}

export async function loadSession(file: string): Promise<StoredSession | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoredSession
  } catch {
    return null
  }
}

/**
 * The session to resume: `id` (exact or a unique prefix), or the newest one when omitted.
 * Throws with a readable message when there is none.
 */
export async function findSession(repoRoot: string, id?: string): Promise<StoredSession> {
  const metas = await listSessions(repoRoot, Infinity)
  if (id === undefined) {
    const latest = metas[0] && (await loadSession(metas[0].file))
    if (!latest) throw new Error('no saved session for this workspace yet')
    return latest
  }
  if (!ID_RE.test(id)) throw new Error(`invalid session id "${id}"`)
  const exact = metas.find((m) => m.id === id)
  const matches = exact ? [exact] : metas.filter((m) => m.id.startsWith(id))
  if (matches.length === 0) throw new Error(`no session "${id}" for this workspace (see /sessions)`)
  if (matches.length > 1) throw new Error(`session id "${id}" is ambiguous: ${matches.map((m) => m.id).join(', ')}`)
  const stored = await loadSession(matches[0]!.file)
  if (!stored) throw new Error(`could not read session "${matches[0]!.id}"`)
  return stored
}

/** Base64 image characters kept per saved transcript (about 7.5 MB of image files). */
export const MAX_SESSION_IMAGE_CHARS = 10_000_000

/**
 * The newest images up to `max` base64 characters stay in the saved transcript; older ones become a
 * note in their message's text. Only the saved copy changes, never the live conversation.
 */
export function capSessionImages(messages: ChatMessage[], max = MAX_SESSION_IMAGE_CHARS): ChatMessage[] {
  let kept = 0
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!
    if (!m.images?.length) continue
    const size = m.images.reduce((n, img) => n + img.data.length, 0)
    if (kept + size <= max) {
      kept += size
      continue
    }
    const { images, ...rest } = m
    const note = `[${images.length} image${images.length === 1 ? '' : 's'} not kept in the saved session]`
    out[i] = { ...rest, content: m.content ? `${m.content}\n${note}` : note }
  }
  return out
}

export function titleFrom(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')
  const text = firstUser?.content.replace(/\s+/g, ' ').trim() ?? ''
  if (text === '') return '(untitled)'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * Delete transcripts of every workspace not updated for `retainDays` (config `sessions.retainDays`), with
 * their index entries. Runs in this process's save queue; returns how many were deleted.
 */
export function pruneSessions(retainDays: number, now = Date.now()): Promise<number> {
  const run = saveChain.then(() => pruneNow(now - retainDays * 86_400_000))
  saveChain = run.catch(() => {})
  return run
}

async function pruneNow(cutoff: number): Promise<number> {
  const base = path.join(configDir(), 'sessions')
  let removed = 0
  for (const repo of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!repo.isDirectory()) continue // a symlink is not followed
    const dir = path.join(base, repo.name)
    const index = await readIndex(dir)
    const indexed = new Map(index.map((e) => [`${e.id}.json`, e]))
    const gone = new Set<string>()
    for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name === INDEX_FILE) continue
      // Indexed transcripts age by their last update; files missing from the index by mtime.
      const updated = indexed.get(file.name)?.updatedAt ?? (await lstat(path.join(dir, file.name)).then((s) => s.mtimeMs, () => Infinity))
      if (updated >= cutoff) continue
      try {
        await unlink(path.join(dir, file.name))
        gone.add(file.name.slice(0, -'.json'.length))
        removed++
      } catch {
        // in use or already gone: try again next start
      }
    }
    const keep = index.filter((e) => !gone.has(e.id) && e.updatedAt >= cutoff)
    if (keep.length < index.length) await writeFileAtomic(path.join(dir, INDEX_FILE), JSON.stringify(keep), 0o600)
  }
  return removed
}
