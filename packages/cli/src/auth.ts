import path from 'node:path'
import { hesdorGlobalDir } from '@hesdor/agent-core'
import { chatgptStatus, runLogoutCommand } from './chatgpt-login.js'
import { readJsonObject, writeFileAtomic } from './config.js'

/**
 * Credential store for keys the user entered via `hesdor setup`.
 * Lives in the user's global config dir — never inside a repository.
 * Environment variables always win over this file.
 */
export interface AuthStore {
  [providerId: string]: string
}

export function authFile(): string {
  return path.join(hesdorGlobalDir(), 'auth.json')
}

export async function loadAuth(): Promise<AuthStore> {
  return readJsonObject<AuthStore>(authFile())
}

export async function saveCredential(providerId: string, apiKey: string): Promise<void> {
  const store = await loadAuth()
  if (apiKey === '') delete store[providerId]
  else store[providerId] = apiKey
  // Created owner-only (Windows ignores the mode; the profile dir's ACL applies there).
  await writeFileAtomic(authFile(), `${JSON.stringify(store, null, 2)}\n`, 0o600)
}

/** `hesdor auth list` / `hesdor auth logout <provider>`. Never prints key values. */
export async function runAuthCommand(args: string): Promise<number> {
  const [sub = 'list', id] = args.split(/\s+/).filter(Boolean)
  const store = await loadAuth()
  if (sub === 'list') {
    const ids = Object.keys(store).sort()
    const chatgpt = await chatgptStatus()
    if (chatgpt) console.log(chatgpt.signedIn ? `chatgpt: signed in (ChatGPT plan)${chatgpt.email ? ` as ${chatgpt.email}` : ''}` : 'chatgpt: signed out (hesdor login chatgpt)')
    console.log(ids.length > 0 ? ids.map((p) => `${p}  key saved (value hidden)`).join('\n') : 'no saved keys (keys from environment variables are not listed)')
    return 0
  }
  if (sub === 'logout' && id === 'chatgpt') return runLogoutCommand(id)
  if (sub === 'logout' && id) {
    if (!(id in store)) {
      console.error(`✗ no saved key for "${id}"`)
      return 1
    }
    await saveCredential(id, '')
    console.log(`✓ removed the saved key for ${id}`)
    return 0
  }
  console.error('usage: hesdor auth list | hesdor auth logout <provider>')
  return 1
}

/** Resolve a key: environment variable first, then stored credentials. */
export function resolveApiKey(envKey: string | undefined, providerId: string, auth: AuthStore): string | undefined {
  if (envKey && process.env[envKey]) return process.env[envKey]
  return auth[providerId]
}
