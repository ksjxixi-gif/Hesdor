import { createProvider, getPreset } from '@hesdor/providers'
import type { ModelProvider } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import { loadAuth } from './auth.js'

export interface ProviderSelection {
  providerId: string
  model: string
  baseUrl?: string
  envKey?: string
  /** Resolved credential. Never log or print this object's apiKey. */
  apiKey?: string
  /** Where the key came from — safe for display. */
  keySource: 'environment' | 'stored' | 'none' | 'not-required'
}

/**
 * Resolution order for provider/model: CLI flag > global config > preset default.
 * Keys: environment variable first, then stored credentials from `hesdor setup`.
 */
export async function resolveSelection(flags: CliFlags, cfg: HesdorConfig): Promise<ProviderSelection> {
  let providerId = flags.provider ?? cfg.provider
  if (!providerId) {
    // Heuristic: pick whichever cloud key is present.
    if (process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) providerId = 'openrouter'
    else if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) providerId = 'anthropic'
    else providerId = 'openai'
  }
  const preset = getPreset(providerId)
  if (!preset) throw new Error(`unknown provider "${providerId}" (see hesdor --help)`)

  const auth = await loadAuth()
  const envValue = preset.envKey ? process.env[preset.envKey] : undefined
  const storedValue = auth[providerId]

  let keySource: ProviderSelection['keySource']
  let apiKey: string | undefined
  if (!preset.requiresApiKey) {
    keySource = 'not-required'
    apiKey = envValue ?? storedValue
  } else if (envValue) {
    keySource = 'environment'
    apiKey = envValue
  } else if (storedValue) {
    keySource = 'stored'
    apiKey = storedValue
  } else {
    keySource = 'none'
  }

  return {
    providerId,
    model: flags.model ?? cfg.model ?? preset.defaultModel,
    // Custom endpoints: --base-url flag wins, then saved per-provider URL.
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : cfg.baseUrls?.[providerId] ? { baseUrl: cfg.baseUrls[providerId] } : {}),
    envKey: preset.envKey,
    ...(apiKey ? { apiKey } : {}),
    keySource,
  }
}

export function createSelectedProvider(selection: ProviderSelection): ModelProvider {
  return createProvider({
    provider: selection.providerId,
    model: selection.model,
    ...(selection.baseUrl ? { baseUrl: selection.baseUrl } : {}),
    ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
  })
}
