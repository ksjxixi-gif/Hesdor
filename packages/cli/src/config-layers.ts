import { stat } from 'node:fs/promises'
import path from 'node:path'
import { findGitRoot, sandboxOn, stricterSandbox, validateRules, validateSandbox } from '@hesdor/agent-core'
import type { ChecksConfig, PermissionRules, SandboxConfig } from '@hesdor/agent-core'
import { getPreset } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import { configFile, loadConfig, modelIdError, PROVIDER_ID_RE, readJsonObject, saveConfig } from './config.js'
import type { HesdorConfig } from './config.js'
import { applyProfile, PROFILE_NAMES } from './profiles.js'
import type { ProfileResolution } from './profiles.js'
import { fingerprint, isTrusted, projectCodeFiles } from './trust.js'

/**
 * Config layers, highest first: managed settings (cannot be overridden) > CLI flags > env >
 * project `.hesdor/config.json` (trusted workspaces only, safe keys only) > user config.json > defaults.
 * saveConfig still writes only the user file.
 */
export type Layer = 'managed' | 'flag' | 'env' | 'project' | 'user' | 'profile' | 'default'

/** Admin policy file (managed-settings.json). Its values win over every other layer. */
export interface ManagedSettings {
  provider?: string
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high'
  mode?: 'build' | 'plan' | 'ask'
  updateCheck?: boolean
  /** Locks the model profile (economy | balanced | frontier). */
  profile?: 'economy' | 'balanced' | 'frontier'
  /** Only these provider ids may be used (main model, roles and agents). */
  allowedProviders?: string[]
  disableGuardian?: boolean
  /** Removes web_fetch and web_search. */
  disableWebTools?: boolean
  /** No MCP servers from any scope. */
  disableMcp?: boolean
  /** Forced ask/deny rules (an allow list here is refused). */
  permissions?: Pick<PermissionRules, 'ask' | 'deny'>
  /** Sandbox floor: user and project config can only make it stricter. */
  sandbox?: SandboxConfig
}

type Scalar = 'provider' | 'model' | 'maxTokens' | 'effort' | 'mode' | 'updateCheck' | 'profile'

const oneOf =
  (...values: string[]) =>
  (v: unknown): string | undefined =>
    typeof v === 'string' && values.includes(v) ? undefined : `must be one of ${values.join(' | ')}`
const CHECK: Record<Scalar, (v: unknown) => string | undefined> = {
  provider: (v) => (typeof v === 'string' && PROVIDER_ID_RE.test(v) ? undefined : 'must be a provider id'),
  model: (v) => (typeof v === 'string' ? modelIdError(v) : 'must be a string'),
  maxTokens: (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1_000_000 ? undefined : 'must be an integer from 1 to 1000000'),
  effort: oneOf('low', 'medium', 'high'),
  mode: oneOf('build', 'plan', 'ask'),
  updateCheck: (v) => (typeof v === 'boolean' ? undefined : 'must be true or false'),
  profile: oneOf(...PROFILE_NAMES),
}

/** What a repository may set. Never provider, endpoints, keys, roles, guardian, permissions or updateCheck. */
export const PROJECT_KEYS = ['mode', 'maxTokens', 'effort', 'model'] as const
const ENV_KEYS: Record<string, Scalar> = {
  HESDOR_PROVIDER: 'provider',
  HESDOR_MODEL: 'model',
  HESDOR_MAX_TOKENS: 'maxTokens',
  HESDOR_EFFORT: 'effort',
  HESDOR_MODE: 'mode',
  HESDOR_PROFILE: 'profile',
}
const FLAG_NAMES: Partial<Record<Scalar, string>> = { provider: '--provider', maxTokens: '--max-tokens', effort: '--effort', mode: '--mode', profile: '--profile' }
const MANAGED_SCALARS: Array<Exclude<Scalar, 'model'>> =['provider', 'maxTokens', 'effort', 'mode', 'updateCheck', 'profile']
const MANAGED_BOOLS = ['disableGuardian', 'disableWebTools', 'disableMcp'] as const
/** Shown by `config list/get` when nothing sets them. */
const DEFAULTS: Record<string, unknown> = { maxTokens: 8192, mode: 'build', updateCheck: true }

/** HESDOR_MANAGED_SETTINGS, else the platform's machine-wide path. */
export function managedSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HESDOR_MANAGED_SETTINGS) return env.HESDOR_MANAGED_SETTINGS
  if (process.platform === 'win32') return path.join(env.ProgramData ?? 'C:\\ProgramData', 'hesdor', 'managed-settings.json')
  if (process.platform === 'darwin') return '/Library/Application Support/hesdor/managed-settings.json'
  return '/etc/hesdor/managed-settings.json'
}

/** Missing file: no policy. A malformed file throws (fail closed); unknown keys are ignored. */
export async function loadManagedSettings(file = managedSettingsPath()): Promise<ManagedSettings> {
  const raw = await readJsonObject<Record<string, unknown>>(file)
  const bad = (key: string, why: string): never => {
    throw new Error(`${file}: "${key}" ${why}`)
  }
  for (const k of MANAGED_SCALARS) if (raw[k] !== undefined && CHECK[k](raw[k])) bad(k, CHECK[k](raw[k])!)
  for (const k of MANAGED_BOOLS) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') bad(k, 'must be true or false')
  const allowed = raw.allowedProviders
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every((p) => typeof p === 'string' && PROVIDER_ID_RE.test(p)))) {
    bad('allowedProviders', 'must be a list of provider ids')
  }
  if (raw.permissions !== undefined) {
    const rules = validateRules(raw.permissions, file)
    if (rules.allow) bad('permissions', 'may only contain ask and deny rules')
  }
  validateSandbox(raw.sandbox, file)
  return raw as ManagedSettings
}

/** Why `providerId` may not be used, or undefined when managed settings allow it. */
export function providerBlocked(managed: ManagedSettings, providerId: string): string | undefined {
  if (!managed.allowedProviders || managed.allowedProviders.includes(providerId)) return undefined
  const allowed = managed.allowedProviders.length > 0 ? managed.allowedProviders.join(', ') : 'none'
  return `provider "${providerId}" is not allowed by managed settings (${managedSettingsPath()}); allowed: ${allowed}. Pick one with -p <provider>.`
}

export interface LayerInput {
  user: HesdorConfig
  project?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  flags?: CliFlags
  managed?: ManagedSettings
}

export interface EffectiveConfig {
  /** Merged config: pass it wherever a HesdorConfig is read (resolveSelection, resolveRoles, updateNotice). */
  config: HesdorConfig
  /** The flags with config defaults filled in (mode, effort); pass these on instead of the raw flags. */
  flags: CliFlags
  /** Layer that set each key (dot paths, e.g. `models.openai`); unlisted keys come from user config or defaults. */
  sources: Record<string, Layer>
  managed: ManagedSettings
  warnings: string[]
  /** Set when a profile is active (loadEffectiveConfig): what it picked and why. */
  profile?: ProfileResolution
}

const NO_FLAGS: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }

/** Pure merge of the layers. Throws when a flag tries to change a managed key. */
export function mergeLayers(input: LayerInput): EffectiveConfig {
  const warnings: string[] = []
  const sources: Record<string, Layer> = {}
  const config: HesdorConfig = structuredClone(input.user)
  const flags = input.flags ?? NO_FLAGS
  const managed = input.managed ?? {}
  for (const key of Object.keys(config)) sources[key] = 'user'
  for (const k of Object.keys(CHECK) as Scalar[]) {
    const error = config[k] !== undefined ? CHECK[k](config[k]) : undefined
    if (error) {
      warnings.push(`config.json: ${k} ${error}; ignored`)
      delete config[k]
    }
  }
  if (config.sandbox !== undefined) config.sandbox = validateSandbox(config.sandbox, 'config.json')
  if (config.checks !== undefined && checksError(config.checks)) {
    warnings.push(`config.json: checks ${checksError(config.checks)}; ignored`)
    delete config.checks
  }

  // A model from a project, env or managed layer belongs to the provider already chosen, never a new one.
  const set = (k: Scalar, value: unknown, layer: Layer): void => {
    if (k !== 'model') {
      ;(config as Record<string, unknown>)[k] = value
      sources[k] = layer
    } else if (config.provider) {
      config.models = { ...config.models, [config.provider]: value as string }
      sources[`models.${config.provider}`] = layer
    } else {
      config.model = value as string // legacy key: applies to the auto-detected provider only (savedModel)
      sources.model = layer
    }
  }

  const env = input.env ?? {}
  const envValues: Partial<Record<Scalar, unknown>> = {}
  for (const [name, k] of Object.entries(ENV_KEYS)) {
    const raw = env[name]
    if (raw === undefined || raw === '') continue
    const value = k === 'maxTokens' ? Number(raw) : raw
    const error = CHECK[k](value)
    if (error) warnings.push(`${name} ${error}; ignored`)
    else envValues[k] = value
  }
  if (envValues.provider !== undefined) set('provider', envValues.provider, 'env')

  for (const [key, value] of Object.entries(input.project ?? {})) {
    if (key === '$schema') continue
    if (key === 'checks') {
      // Checks run commands, but this file loads only in trusted workspaces and is in the trust fingerprint.
      const error = checksError(value)
      if (error) warnings.push(`.hesdor/config.json: checks ${error}; ignored`)
      else {
        config.checks = { ...config.checks, ...(value as ChecksConfig) }
        sources.checks = 'project'
      }
      continue
    }
    if (key === 'sandbox') {
      // A repository may only tighten the sandbox (stricterSandbox), never loosen it.
      config.sandbox = stricterSandbox(config.sandbox, validateSandbox(value, '.hesdor/config.json'))
      sources.sandbox = 'project'
      continue
    }
    if (!(PROJECT_KEYS as readonly string[]).includes(key)) {
      warnings.push(`.hesdor/config.json: "${key}" cannot be set by a project and was ignored (allowed: ${PROJECT_KEYS.join(', ')})`)
      continue
    }
    const error = CHECK[key as Scalar](value)
    if (error) warnings.push(`.hesdor/config.json: ${key} ${error}; ignored`)
    else set(key as Scalar, value, 'project')
  }
  for (const k of ['model', 'maxTokens', 'effort', 'mode', 'profile'] as const) if (envValues[k] !== undefined) set(k, envValues[k], 'env')

  // Flags stay flags (resolveSelection reads them); config only records that they win.
  if (flags.mode !== undefined) set('mode', flags.mode, 'flag')
  if (flags.effort !== undefined) set('effort', flags.effort, 'flag')
  if (flags.maxTokens !== undefined) set('maxTokens', flags.maxTokens, 'flag')
  if (flags.profile !== undefined) set('profile', flags.profile, 'flag')
  if (flags.provider !== undefined) sources.provider = 'flag'
  if (flags.model !== undefined) sources.model = 'flag'

  const where = managedSettingsPath(input.env)
  for (const k of MANAGED_SCALARS) {
    const value = managed[k]
    if (value === undefined) continue
    const flagValue = (flags as unknown as Record<string, unknown>)[k]
    if (flagValue !== undefined && flagValue !== value) {
      throw new Error(`${FLAG_NAMES[k] ?? k} is locked to ${JSON.stringify(value)} by managed settings (${where})`)
    }
    set(k, value, 'managed')
  }
  if (managed.disableGuardian) {
    if (flags.guardian) throw new Error(`--guardian is disabled by managed settings (${where})`)
    config.guardian = { ...config.guardian, enabled: false }
    sources['guardian.enabled'] = 'managed'
  }
  if (managed.sandbox) {
    config.sandbox = stricterSandbox(managed.sandbox, config.sandbox)
    sources.sandbox = 'managed'
  }
  if (sandboxOn(config.sandbox) && process.platform === 'win32') {
    warnings.push('sandbox: the OS sandbox is not supported on Windows yet; commands run unsandboxed' + (config.sandbox.failIfUnavailable ? ' — failIfUnavailable is set, so run_command will refuse to run' : ''))
  }

  const outFlags: CliFlags = { ...flags }
  if (config.mode !== undefined) outFlags.mode = config.mode
  if (config.effort !== undefined) outFlags.effort = config.effort
  return { config, flags: outFlags, sources, managed, warnings }
}

/** True when the repository has a `.hesdor/config.json` and its project files are trusted (pinned or --trust-workspace). */
export async function projectConfigTrusted(root: string, trustFlag?: boolean): Promise<boolean> {
  const files = await projectCodeFiles(root)
  if (!files.includes(path.join(root, '.hesdor', 'config.json'))) return false
  return trustFlag === true || (await isTrusted(root, await fingerprint(root, files)))
}

/** Checks for a turn: user config, overridden per kind by a trusted project's .hesdor/config.json. */
export async function loadChecksConfig(root: string, trustFlag?: boolean): Promise<ChecksConfig | undefined> {
  return (await loadEffectiveConfig(NO_FLAGS, { root, trusted: await projectConfigTrusted(root, trustFlag) })).config.checks
}

/** Why a `checks` value is malformed, or undefined when it is valid. */
export function checksError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object'
  for (const [k, v] of Object.entries(value)) {
    if (k === 'timeoutMs') {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 600_000) return 'timeoutMs must be an integer from 1 to 600000'
    } else if (!['format', 'lint', 'typecheck', 'test'].includes(k)) return `has an unknown key "${k}" (format, lint, typecheck, test, timeoutMs)`
    else if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== '')) return `${k} must be a list of non-empty strings (an argv)`
  }
  return undefined
}

/** The effective sandbox for a workspace (user, trusted project, managed), read per turn like loadPermissions. */
export async function loadSandboxConfig(root: string, trustFlag?: boolean): Promise<SandboxConfig | undefined> {
  return (await loadEffectiveConfig(NO_FLAGS, { root, trusted: await projectConfigTrusted(root, trustFlag) })).config.sandbox
}

/** Read every layer and merge them. `root` and `trusted` enable the project layer. */
export async function loadEffectiveConfig(
  flags: CliFlags = NO_FLAGS,
  opts: { root?: string; trusted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<EffectiveConfig> {
  const env = opts.env ?? process.env
  const [user, managed] = await Promise.all([loadConfig(), loadManagedSettings(managedSettingsPath(env))])
  let project: Record<string, unknown> = {}
  const projectWarnings: string[] = []
  if (opts.root) {
    const file = path.join(opts.root, '.hesdor', 'config.json')
    if (opts.trusted) project = await readJsonObject(file)
    else if (await exists(file)) {
      projectWarnings.push('ignored .hesdor/config.json: this repository is not trusted (run `hesdor` here to review it, or pass --trust-workspace)')
    }
  }
  const eff = mergeLayers({ user, project, env, flags, managed })
  eff.warnings.unshift(...projectWarnings)
  if (eff.config.profile) {
    eff.profile = await applyProfile(eff, {
      explicitMain: Boolean(flags.provider || flags.model || env.HESDOR_PROVIDER || env.HESDOR_MODEL),
      blocked: (id) => providerBlocked(managed, id),
      ...(managed.provider ? { lockedProvider: managed.provider } : {}),
    })
    eff.warnings.push(...eff.profile.warnings)
  }
  return eff
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Leaf values as dot paths; arrays and empty objects stay whole. */
function flatten(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) out.push(...flatten(v as Record<string, unknown>, `${key}.`))
    else out.push([key, v])
  }
  return out
}

function sourceOf(eff: EffectiveConfig, key: string): Layer {
  for (let k = key; k; k = k.slice(0, Math.max(0, k.lastIndexOf('.')))) if (eff.sources[k]) return eff.sources[k]!
  return 'user'
}

/** `key = value  (layer)` rows: every effective value, defaults, then managed policy keys. */
export function listRows(eff: EffectiveConfig): Array<{ key: string; value: unknown; source: Layer }> {
  const rows = flatten(eff.config as Record<string, unknown>)
    .filter(([k]) => k !== '$schema')
    .map(([key, value]) => ({ key, value, source: sourceOf(eff, key) }))
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!rows.some((r) => r.key === key)) rows.push({ key, value, source: 'default' })
  }
  const policy = { ...eff.managed } as Record<string, unknown>
  for (const k of MANAGED_SCALARS) delete policy[k]
  for (const [key, value] of flatten(policy)) rows.push({ key: `managed.${key}`, value, source: 'managed' })
  return rows
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/** Keys `hesdor config set` writes (user scope). Everything else is edited in config.json or via setup/policy. */
const SETTABLE = /^(provider|model|maxTokens|effort|mode|updateCheck|profile|escalate|models\.[a-z0-9][a-z0-9._-]*|roles\.(small|subagent|oracle)|guardian\.(enabled|model))$/

/** Parse and validate a `config set` value. Returns the value or throws with the reason. */
export function parseSetting(key: string, raw: string, user: HesdorConfig, managed: ManagedSettings = {}): unknown {
  if (!SETTABLE.test(key)) {
    throw new Error(`"${key}" cannot be set here; settable keys: provider, model, maxTokens, effort, mode, updateCheck, profile, escalate, models.<provider>, roles.small|subagent|oracle, guardian.enabled|model`)
  }
  const fail = (why: string): never => {
    throw new Error(`invalid value for ${key}: ${why}`)
  }
  const known = (id: string): void => {
    if (!PROVIDER_ID_RE.test(id) || (!getPreset(id) && !user.customProviders?.[id])) fail(`unknown provider "${id}" (see hesdor --help, or add it with hesdor setup)`)
    const blocked = providerBlocked(managed, id)
    if (blocked) fail(blocked)
  }
  if (key === 'maxTokens') {
    const n = Number(raw)
    const error = CHECK.maxTokens(n)
    return error ? fail(error) : n
  }
  if (key === 'updateCheck' || key === 'guardian.enabled' || key === 'escalate') return raw === 'true' ? true : raw === 'false' ? false : fail('must be true or false')
  if (key === 'profile' && raw === 'none') return undefined // removes the key (saveConfig drops undefined)
  if (key === 'effort' || key === 'mode' || key === 'profile') return CHECK[key](raw) ? fail(CHECK[key](raw)!) : raw
  if (key === 'provider') {
    known(raw)
    return raw
  }
  if (key.startsWith('models.')) known(key.slice('models.'.length))
  const error = modelIdError(raw)
  return error ? fail(error) : raw
}

/** `hesdor config get <key> | set <key> <value> | list`. */
export async function runConfigCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const [sub, key, ...rest] = args
  try {
    if (sub === 'set' && key && rest.length === 1) {
      const [user, managed] = await Promise.all([loadConfig(), loadManagedSettings()])
      const value = parseSetting(key, rest[0]!, user, managed)
      const [head, leaf] = key.split('.') as [keyof HesdorConfig, string | undefined]
      if (leaf === undefined) await saveConfig({ [head]: value })
      else await saveConfig({ [head]: { ...(user[head] as object | undefined), [leaf]: value } })
      console.log(value === undefined ? `removed ${key} from ${configFile()}` : `saved ${key} = ${show(value)} in ${configFile()}`)
      if ((MANAGED_SCALARS as string[]).includes(key) && (managed as Record<string, unknown>)[key] !== undefined) {
        console.log(`note: managed settings set ${key}; the managed value applies (${managedSettingsPath()})`)
      }
      return 0
    }
    if ((sub === 'get' && key && rest.length === 0) || (sub === 'list' && !key)) {
      const root = findGitRoot(cwd) ?? path.resolve(cwd)
      const eff = await loadEffectiveConfig(NO_FLAGS, { root, trusted: await projectConfigTrusted(root) })
      for (const w of eff.warnings) console.error(`• ${w}`)
      const rows = listRows(eff)
      if (sub === 'list') {
        for (const r of rows) console.log(`${r.key} = ${show(r.value)}  (${r.source})`)
        return 0
      }
      const prefix = `${key}.`
      const hits = rows.filter((r) => r.key === key || r.key.startsWith(prefix))
      if (hits.length === 0) {
        console.error(`${key} is not set`)
        return 1
      }
      if (hits.length === 1 && hits[0]!.key === key) console.log(show(hits[0]!.value))
      else for (const r of hits) console.log(`${r.key} = ${show(r.value)}  (${r.source})`)
      return 0
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  console.error('usage: hesdor config list | get <key> | set <key> <value>')
  return 1
}
