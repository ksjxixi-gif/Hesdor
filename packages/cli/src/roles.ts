import { getPreset } from '@hesdor/providers'
import type { ModelProvider } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import { createGuardian } from './guardian.js'
import { loadManagedSettings, providerBlocked } from './config-layers.js'
import type { Guardian } from './guardian.js'
import { createSelectedProvider, resolveSelection } from './provider-setup.js'
import type { ProviderSelection } from './provider-setup.js'

/**
 * Selection for a `provider/model` spec. A prefix naming another known provider goes through the
 * normal selection, so that provider's own key (env or `hesdor auth`) and endpoint are used and no
 * key crosses providers. Anything else is a model id for the current provider (`<current>/` is
 * stripped). On gateways whose ids contain a slash, write `<gateway>/vendor/model`.
 */
export async function roleSelection(spec: string, flags: CliFlags, cfg: HesdorConfig, current: ProviderSelection): Promise<ProviderSelection> {
  const slash = spec.indexOf('/')
  const prefix = slash > 0 ? spec.slice(0, slash) : ''
  const rest = spec.slice(slash + 1)
  if (prefix && prefix !== current.providerId && (getPreset(prefix) || cfg.customProviders?.[prefix])) {
    // The one-off --base-url and --model belong to the session's provider, never to another one.
    const { baseUrl: _baseUrl, model: _model, ...own } = flags
    const blocked = providerBlocked(await loadManagedSettings(), prefix)
    if (blocked) throw new Error(blocked)
    return resolveSelection({ ...own, provider: prefix, model: rest }, cfg)
  }
  return { ...current, model: prefix === current.providerId ? rest : spec }
}

/** One-line reason a selection cannot be used, or undefined when it has a key. */
export function missingKey(sel: ProviderSelection): string | undefined {
  if (sel.keySource !== 'none') return undefined
  if (sel.providerId === 'chatgpt') return 'chatgpt is not signed in (run `hesdor login chatgpt`)'
  return `${sel.providerId} needs an API key (${sel.envKey ? `set ${sel.envKey} or ` : ''}run \`hesdor setup\`)`
}

export interface RoleStatus {
  /** small, subagent, oracle, fallback 1.., guardian */
  role: string
  spec: string
  ok: boolean
  /** `provider/model`, or why the role is unavailable. */
  detail: string
}

export interface Roles {
  /** Compaction summaries and the guardian's default model. */
  small?: ModelProvider
  /** Default model for explore and task subagents (an agent's own `model:` wins). */
  subagent?: ModelProvider
  /** Tried in order when the main model fails with overloaded, rate_limit, quota_exhausted or network. */
  fallback: ModelProvider[]
  /** Set when the guardian is on for this session (interactive: guardian.enabled; headless: --guardian). */
  guardian?: Guardian
  /** One per configured role, for `hesdor doctor`. */
  status: RoleStatus[]
  /** One line per unavailable role. */
  warnings: string[]
}

/**
 * Resolve config `roles` and `guardian`. A role whose provider is unknown or has no key is
 * left out with a warning; nothing here throws for a bad role.
 */
export async function resolveRoles(flags: CliFlags, cfg: HesdorConfig, current: ProviderSelection, opts: { headless?: boolean } = {}): Promise<Roles> {
  const roles: Roles = { fallback: [], status: [], warnings: [] }
  const resolve = async (role: string, spec: unknown): Promise<ModelProvider | undefined> => {
    let error: string | undefined
    let provider: ModelProvider | undefined
    if (typeof spec !== 'string' || spec.trim() === '') {
      error = 'must be a "provider/model" string'
    } else {
      try {
        const sel = await roleSelection(spec, flags, cfg, current)
        error = missingKey(sel)
        if (!error) provider = createSelectedProvider(sel)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
    const shown = typeof spec === 'string' ? spec : JSON.stringify(spec)
    roles.status.push({ role, spec: shown, ok: !error, detail: error ? `${shown}: ${error}` : `${provider!.name}/${provider!.model}` })
    if (error) roles.warnings.push(`${role} model ${shown} is unavailable: ${error}`)
    return provider
  }

  const cfgRoles = cfg.roles ?? {}
  if (cfgRoles.small !== undefined) roles.small = await resolve('small', cfgRoles.small)
  if (cfgRoles.subagent !== undefined) roles.subagent = await resolve('subagent', cfgRoles.subagent)
  // The oracle tool is registered by the session (session.ts); this only checks its key.
  if (cfgRoles.oracle !== undefined) await resolve('oracle', cfgRoles.oracle)
  const fallback = cfgRoles.fallback === undefined ? [] : Array.isArray(cfgRoles.fallback) ? cfgRoles.fallback : [cfgRoles.fallback]
  for (const [i, spec] of fallback.entries()) {
    const provider = await resolve(`fallback ${i + 1}`, spec)
    if (provider) roles.fallback.push(provider)
  }

  // The guardian runs headless only when --guardian is passed explicitly (and is moot with --yes).
  if (opts.headless ? flags.guardian === true && !flags.yes : cfg.guardian?.enabled === true) {
    const model = cfg.guardian?.model
    const provider = model !== undefined ? await resolve('guardian', model) : roles.small
    if (model === undefined) {
      const detail = provider ? `${provider.name}/${provider.model} (roles.small)` : 'off: set guardian.model, or a working roles.small, in config.json'
      roles.status.push({ role: 'guardian', spec: cfgRoles.small ?? '', ok: provider !== undefined, detail })
      if (!provider) roles.warnings.push(`guardian is ${detail}`)
    }
    if (provider) roles.guardian = createGuardian(provider, { headless: opts.headless ?? false })
  }
  return roles
}
