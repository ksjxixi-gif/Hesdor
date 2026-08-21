import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configDir } from './config.js'
import type { ChatMessage } from '@hesdor/protocol'

export interface StoredSession {
  id: string
  repo: string
  createdAt: number
  updatedAt: number
  /** First user prompt, used as display title. */
  title: string
  /** Conversation without system messages. */
  messages: ChatMessage[]
}

/** Per-project directory under the global Hesdor dir: sessions/<repo-hash>/. */
function sessionsDirFor(repoRoot: string): string {
  const hash = createHash('sha1').update(path.resolve(repoRoot).toLowerCase()).digest('hex').slice(0, 12)
  return path.join(configDir(), 'sessions', hash)
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function saveSession(
  repoRoot: string,
  session: Pick<StoredSession, 'id' | 'messages' | 'title'> & { createdAt?: number },
): Promise<void> {
  if (session.messages.length === 0) return
  const dir = sessionsDirFor(repoRoot)
  await mkdir(dir, { recursive: true })

  let createdAt = session.createdAt ?? Date.now()
  const file = path.join(dir, `${session.id}.json`)
  try {
    const existing = JSON.parse(await readFile(file, 'utf8')) as StoredSession
    createdAt = existing.createdAt ?? createdAt
  } catch {
    // new file
  }

  const stored: StoredSession = {
    id: session.id,
    repo: path.resolve(repoRoot),
    createdAt,
    updatedAt: Date.now(),
    title: session.title || '(untitled)',
    messages: session.messages,
  }
  await writeFile(file, JSON.stringify(stored), 'utf8')
}

export interface SessionMeta {
  file: string
  id: string
  updatedAt: number
  title: string
  messageCount: number
}

/** Most recent sessions for this repo, newest first. */
export async function listSessions(repoRoot: string, limit = 10): Promise<SessionMeta[]> {
  const dir = sessionsDirFor(repoRoot)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const metas: SessionMeta[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as StoredSession
      metas.push({
        file: path.join(dir, file),
        id: raw.id,
        updatedAt: raw.updatedAt ?? 0,
        title: raw.title ?? '(untitled)',
        messageCount: raw.messages?.length ?? 0,
      })
    } catch {
      // skip corrupt entries
    }
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt)
  return metas.slice(0, limit)
}

export async function loadSession(file: string): Promise<StoredSession | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoredSession
  } catch {
    return null
  }
}

export function titleFrom(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')
  const text = firstUser?.content.replace(/\s+/g, ' ').trim() ?? ''
  if (text === '') return '(untitled)'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
