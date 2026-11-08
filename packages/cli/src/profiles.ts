import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import type { Layer } from './config-layers.js'
import { resolveSelection } from './provider-setup.js'
import type { ProviderSelection } from './provider-setup.js'

/**
 * Ranked `provider/model` candidates per tier. A tier uses the first candidate whose provider has a
 * usable credential (env key, `hesdor setup` key or ChatGPT sign-in) and is allowed by managed settings.
 *
 * These lists are a starting point, to be tuned by benchmark results (pass rate and $ per solved task).
 * Every id must exist in the bundled catalog with tool calling; profiles.test.ts checks that.
 */
const ECONOMY = [
  'deepseek/deepseek-flash',
  'zai/glm-5.3-flash',
  'minimax/MiniMax-M3.1-Flash',
  'qwen/qwen3.8-flash',
  'openrouter/deepseek/deepseek-v4.1-flash-1017',
  'together/zai-org/GLM-5.3-Flash',
  'fireworks/accounts/fireworks/models/minimax-m3p1-flash',
  'groq/openai/gpt-oss-120b',
  'cerebras/gpt-oss-120b',
  // Cheap tiers of the frontier vendors, for users with only those keys.
  'anthropic/claude-haiku-5-5',
  'openai/gpt-6-luna',
  'gemini/gemini-3.8-flash',
]
const BALANCED = [
  'anthropic/claude-sonnet-5-5',
  'openai/gpt-6.1-terra',
  'chatgpt/gpt-6.1-sol',
  'openrouter/anthropic/claude-sonnet-5.5',
  'openrouter/openai/gpt-6.1-terra',
  'gemini/gemini-4-argon',
  'xai/grok-4.7',
  'moonshot/kimi-k3.1-pro',
  // Strongest models of the open-weight vendors, so their users still get a stronger tier.
  'deepseek/deepseek-v4-pro',
  'zai/glm-5.3',
  'qwen/qwen3.8-max',
  'minimax/MiniMax-M3',
]
const FRONTIER = [
  'anthropic/claude-opus-5-5',
  'anthropic/claude-fable-5-1',
  'openai/gpt-6-astra',
  'openrouter/anthropic/claude-opus-5.5',
  'openrouter/anthropic/claude-fable-5.1',
]
/** Cheapest tool-capable models with long context (compaction summaries, goal checks, guardian). */
const SMALL = [
  'qwen/qwen3.7-flash',
  'deepseek/deepseek-flash',
  'anthropic/claude-haiku-5-5',
  'openai/gpt-6-luna',
  'gemini/gemini-2.5-flash-lite',
  'openrouter/openai/gpt-6-luna',
  'zai/glm-4.7-flashx',
  'groq/openai/gpt-oss-20b',
]

export const PROFILE_NAMES = ['economy', 'balanced', 'frontier'] as const
export type ProfileName = (typeof PROFILE_NAMES)[number]

interface ProfileSpec {
  main: string[]
  small: string[]
  /** Second opinion through the oracle tool only. */
  oracle: string[]
  /** Stronger tiers a stuck run escalates to, in order (roles.escalation). */
  escalate: Array<{ tier: ProfileName; specs: string[] }>
}

export const PROFILES: Record<ProfileName, ProfileSpec> = {
  economy: { main: ECONOMY, small: SMALL, oracle: FRONTIER, escalate: [{ tier: 'balanced', specs: BALANCED }, { tier: 'frontier', specs: FRONTIER }] },
  balanced: { main: BALANCED, small: SMALL, oracle: FRONTIER, escalate: [{ tier: 'frontier', specs: FRONTIER }] },
  frontier: { main: FRONTIER, small: SMALL, oracle: [], escalate: [] },
}

export interface ProfileResolution {
  name: ProfileName
  /** What each tier resolved to and why, for `hesdor doctor` and /status. */
  lines: string[]
  /** Set when no main candidate has a key: the profile could not pick the model. */
  warnings: string[]
}

export interface ProfileContext {
  /** -p/-m or HESDOR_PROVIDER/HESDOR_MODEL: the main model is not the profile's to pick. */
  explicitMain: boolean
  /** Why managed settings forbid a provider (allowedProviders), or undefined. */
  blocked: (providerId: string) => string | undefined
  /** Managed settings lock the main provider to this id. */
  lockedProvider?: string
}

const keyText = (sel: ProviderSelection): string =>
  sel.keySource === 'environment'
    ? `${sel.envKey} set`
    : sel.keySource === 'stored'
      ? 'key saved by hesdor setup'
      : sel.keySource === 'chatgpt'
        ? 'ChatGPT sign-in'
        : sel.keySource === 'command'
          ? 'apiKeyCommand'
          : 'no key needed'

/**
 * Fills the unset parts of `eff.config` from the profile: the main provider and model (unless given
 * explicitly), roles small, oracle, fallback and escalation (unless set in config.json). Mutates
 * eff.config and eff.sources; never throws for a missing key.
 */
export async function applyProfile(
  eff: { config: HesdorConfig; flags: CliFlags; sources: Record<string, Layer> },
  ctx: ProfileContext,
): Promise<ProfileResolution> {
  const cfg = eff.config
  const name = cfg.profile as ProfileName
  const profile = PROFILES[name]
  const { provider: _provider, model: _model, baseUrl: _baseUrl, ...own } = eff.flags
  const cache = new Map<string, Promise<ProviderSelection | undefined>>()
  const select = (spec: string): Promise<ProviderSelection | undefined> => {
    const slash = spec.indexOf('/')
    if (!cache.has(spec)) cache.set(spec, resolveSelection({ ...own, provider: spec.slice(0, slash), model: spec.slice(slash + 1) }, cfg).catch(() => undefined))
    return cache.get(spec)!
  }
  const mainOk = (id: string): boolean => !ctx.blocked(id) && (!ctx.lockedProvider || ctx.lockedProvider === id)
  const roleOk = (id: string): boolean => !ctx.blocked(id)
  /** First usable candidate, or the key variables that would enable one. */
  const first = async (
    specs: string[],
    ok: (id: string) => boolean,
    skip: (spec: string, sel: ProviderSelection) => boolean = () => false,
  ): Promise<{ spec: string; sel: ProviderSelection } | { missing: string[] }> => {
    const missing: string[] = []
    for (const spec of specs) {
      const sel = ok(spec.slice(0, spec.indexOf('/'))) ? await select(spec) : undefined
      if (!sel) continue
      if (sel.keySource === 'none') {
        const hint = sel.providerId === 'chatgpt' ? '`hesdor login chatgpt`' : sel.envKey
        if (hint && !missing.includes(hint)) missing.push(hint)
      } else if (!skip(spec, sel)) return { spec, sel }
    }
    return { missing }
  }
  const none = (missing: string[]): string =>
    missing.length > 0
      ? `no candidate has a key; set ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' or another listed in profiles.ts' : ''} (or run \`hesdor setup\`) to enable one`
      : 'every candidate is blocked by managed settings'

  const from = ({ flag: '--profile', env: 'HESDOR_PROFILE', managed: 'managed settings' } as Record<string, string>)[eff.sources.profile ?? ''] ?? 'config.json'
  const lines = [`profile ${name} (from ${from})`]
  const warnings: string[] = []
  let main: { spec: string; sel: ProviderSelection } | undefined
  if (ctx.explicitMain) lines.push('main: set by -p/-m or HESDOR_PROVIDER/HESDOR_MODEL, not by the profile')
  else {
    const r = await first(profile.main, mainOk)
    if ('spec' in r) {
      main = r
      cfg.provider = r.sel.providerId
      cfg.models = { ...cfg.models, [r.sel.providerId]: r.sel.model }
      eff.sources.provider = 'profile'
      eff.sources[`models.${r.sel.providerId}`] = 'profile'
      lines.push(`main: ${r.spec} (${keyText(r.sel)})`)
    } else {
      const why = `profile ${name}: ${none(r.missing)}; using the configured provider`
      lines.push(`main: ${why}`)
      warnings.push(why)
    }
  }

  const roles = { ...cfg.roles }
  for (const role of ['small', 'oracle'] as const) {
    if (profile[role].length === 0) continue
    if (roles[role] !== undefined) {
      lines.push(`${role}: roles.${role} from config.json`)
      continue
    }
    const r = await first(profile[role], roleOk)
    if ('spec' in r) {
      roles[role] = r.spec
      eff.sources[`roles.${role}`] = 'profile'
      lines.push(`${role}: ${r.spec} (${keyText(r.sel)})`)
    } else lines.push(`${role}: ${none(r.missing)}`)
  }
  // For outages: the next keyed main candidate from another vendor.
  if (main && roles.fallback === undefined) {
    const r = await first(profile.main, mainOk, (_spec, sel) => sel.providerId === main.sel.providerId)
    if ('spec' in r) {
      roles.fallback = [r.spec]
      eff.sources['roles.fallback'] = 'profile'
      lines.push(`fallback: ${r.spec} (${keyText(r.sel)})`)
    }
  }
  if (profile.escalate.length > 0) {
    if (cfg.escalate === false) lines.push('escalation: off (escalate: false)')
    else if (roles.escalation !== undefined) lines.push('escalation: roles.escalation from config.json')
    else {
      const ladder: string[] = []
      for (const { tier, specs } of profile.escalate) {
        const r = await first(specs, mainOk, (spec) => spec === main?.spec || ladder.includes(spec))
        if ('spec' in r) ladder.push(r.spec)
        else lines.push(`escalation to ${tier}: ${none(r.missing)}`)
      }
      if (ladder.length > 0) {
        roles.escalation = ladder
        eff.sources['roles.escalation'] = 'profile'
        lines.push(`escalation when stuck: ${ladder.join(' → ')}`)
      }
    }
  }
  if (Object.keys(roles).length > 0) cfg.roles = roles
  return { name, lines, warnings }
}
