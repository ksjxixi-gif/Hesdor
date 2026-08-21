import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { hesdorGlobalDir } from '@hesdor/agent-core'

/**
 * Credential store for keys the user entered via `hesdor setup`.
 * Lives in the user's global config dir — never inside a repository.
 * Environment variables always win over this file.
 */
export interface AuthStore {
  [providerId: string]: string
}

function authFile(): string {
  return path.join(hesdorGlobalDir(), 'auth.json')
}

export async function loadAuth(): Promise<AuthStore> {
  try {
    const raw = await readFile(authFile(), 'utf8')
    const parsed = JSON.parse(raw) as AuthStore
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export async function saveCredential(providerId: string, apiKey: string): Promise<void> {
  const store = await loadAuth()
  if (apiKey === '') delete store[providerId]
  else store[providerId] = apiKey
  const dir = hesdorGlobalDir()
  await mkdir(dir, { recursive: true })
  const file = authFile()
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  // Best-effort hardening; Windows ACLs are handled by the profile dir.
  try {
    await chmod(file, 0o600)
  } catch {
    // not critical
  }
}

/** Resolve a key: environment variable first, then stored credentials. */
export function resolveApiKey(envKey: string | undefined, providerId: string, auth: AuthStore): string | undefined {
  if (envKey && process.env[envKey]) return process.env[envKey]
  return auth[providerId]
}
