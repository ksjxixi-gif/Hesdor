import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isSea } from 'node:sea'
import { VERSION } from './args.js'
import { configDir, writeFileAtomic } from './config.js'
import type { HesdorConfig } from './config.js'

export const PACKAGE_NAME = '@dean_overlord/hesdor'
const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 2000

interface UpdateCache {
  checkedAt: number
  latest?: string
}

const cacheFile = (): string => path.join(configDir(), 'update-check.json')

/** Why the update check is off, or null when it is on. */
export function updateCheckDisabled(cfg: HesdorConfig, env: NodeJS.ProcessEnv = process.env, version = VERSION): string | null {
  const set = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  if (set(env.HESDOR_NO_UPDATE_CHECK)) return 'off (HESDOR_NO_UPDATE_CHECK)'
  if (cfg.updateCheck === false) return 'off (updateCheck: false in config.json)'
  if (set(env.CI)) return 'off (CI)'
  if (version.endsWith('-dev')) return 'off (development build)'
  return null
}

/** True when `a` is a newer release than `b` (major.minor.patch; prerelease tags are ignored). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export async function readUpdateCache(): Promise<UpdateCache | null> {
  try {
    const c = JSON.parse(await readFile(cacheFile(), 'utf8')) as UpdateCache
    return typeof c.checkedAt === 'number' ? c : null
  } catch {
    return null
  }
}

/** Plain GET of the npm dist-tag, 2 s timeout; no headers or data that identify the user. Never throws. */
export async function refreshUpdateCache(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  let latest: string | undefined
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) {
      const v = ((await res.json()) as { version?: unknown }).version
      if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) latest = v
    }
  } catch {
    // offline, timeout, proxy: record the attempt anyway so we try again tomorrow, not every start
  }
  try {
    await writeFileAtomic(cacheFile(), JSON.stringify({ checkedAt: now, ...(latest ? { latest } : {}) }))
  } catch {
    // read-only config dir: skip
  }
}

/**
 * Interactive startup: returns the notice from the cached result of an earlier check (never waits on the
 * network) and, at most once per 24 h, starts a background check whose result shows on the next start.
 */
export async function updateNotice(cfg: HesdorConfig, opts: { env?: NodeJS.ProcessEnv; version?: string; fetch?: typeof fetch; now?: number } = {}): Promise<string | null> {
  const version = opts.version ?? VERSION
  if (updateCheckDisabled(cfg, opts.env, version)) return null
  const now = opts.now ?? Date.now()
  const cache = await readUpdateCache()
  if (!cache || now - cache.checkedAt >= DAY_MS) void refreshUpdateCache(opts.fetch, now)
  return cache?.latest && isNewer(cache.latest, version)
    ? `Hesdor ${cache.latest} is available (you have ${version}). Run \`hesdor upgrade\` for the command.`
    : null
}

/** Doctor row text for the update check. */
export async function updateCheckStatus(cfg: HesdorConfig): Promise<string> {
  const off = updateCheckDisabled(cfg)
  if (off) return off
  const cache = await readUpdateCache()
  const last = cache ? `last checked ${new Date(cache.checkedAt).toISOString().slice(0, 16).replace('T', ' ')}${cache.latest ? `, latest ${cache.latest}` : ''}` : 'not checked yet'
  return `on — once a day, interactive only, plain GET of registry.npmjs.org/${PACKAGE_NAME}/latest (${last})`
}

export type InstallMethod = 'npx' | 'pnpm' | 'npm' | 'source' | 'binary'

/** Guess how this copy was installed: a standalone binary, else from the path of the running script. */
export function detectInstall(script = process.argv[1] ?? '', binary = isSea()): InstallMethod {
  if (binary) return 'binary'
  const p = script.replace(/\\/g, '/')
  if (/\/_npx\//.test(p)) return 'npx'
  if (!p.includes('/node_modules/')) return 'source'
  if (/\/(\.?pnpm)\//i.test(p)) return 'pnpm'
  return 'npm'
}

export function upgradeCommand(method: InstallMethod): string {
  switch (method) {
    case 'npx':
      return `npx ${PACKAGE_NAME}@latest   (npx caches packages; @latest fetches the newest)`
    case 'pnpm':
      return `pnpm add -g ${PACKAGE_NAME}@latest`
    case 'npm':
      return `npm install -g ${PACKAGE_NAME}@latest`
    case 'source':
      return 'git pull && pnpm install && pnpm build   (running from a source checkout)'
    case 'binary':
      return 'winget upgrade hesdor | scoop update hesdor | brew upgrade hesdor, or re-run the install script (packaging/install.ps1 or install.sh)'
  }
}

/** `hesdor upgrade`: print the command for this install; never runs it. */
export async function runUpgrade(): Promise<number> {
  const method = detectInstall()
  console.log(`hesdor ${VERSION} (installed via ${method})`)
  const cache = await readUpdateCache()
  if (cache?.latest) console.log(isNewer(cache.latest, VERSION) ? `newest release: ${cache.latest}` : `up to date as of the last check (${cache.latest})`)
  console.log(`\nTo upgrade, run:\n  ${upgradeCommand(method)}`)
  return 0
}
