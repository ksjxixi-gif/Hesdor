import { createProvider, getPreset, PROVIDER_PRESETS } from '@hesdor/providers'
import type { ModelProvider, ProviderKind } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import type { HesdorConfig } from './config.js'
import { loadAuth } from './auth.js'

export interface ProviderSelection {
  providerId: string
  kind: ProviderKind
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
    // Pick the first configured preset key; explicit config/flags still win.
    providerId =
      PROVIDER_PRESETS.find((p) => p.requiresApiKey && p.envKey && process.env[p.envKey])?.id ?? 'openai'
  }
  const preset = getPreset(providerId)
  const custom = cfg.customProviders?.[providerId]
  if (
    custom &&
    (custom.kind !== 'openai' && custom.kind !== 'anthropic' || typeof custom.baseUrl !== 'string' || custom.baseUrl.trim() === '')
  ) {
    throw new Error(`invalid custom provider configuration for "${providerId}" — run \`hesdor setup\` again`)
  }
  if (!preset && !custom && !flags.baseUrl) {
    throw new Error(`unknown provider "${providerId}" — add it with \`hesdor setup\` or pass --base-url`)
  }

  const auth = await loadAuth()
  const kind = preset?.kind ?? custom?.kind ?? 'openai'
  const envKey = preset?.envKey ?? (custom || flags.baseUrl ? 'HESDOR_CUSTOM_API_KEY' : undefined)
  const envValue = envKey ? process.env[envKey] : undefined
  const envBaseUrl = preset?.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined
  const storedValue = auth[providerId]

  let keySource: ProviderSelection['keySource']
  let apiKey: string | undefined
  if (!preset?.requiresApiKey) {
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
    kind,
    model: flags.model ?? cfg.model ?? preset?.defaultModel ?? 'local-model',
    // CLI override wins, then a known/custom saved endpoint.
    ...(flags.baseUrl
      ? { baseUrl: flags.baseUrl }
      : cfg.baseUrls?.[providerId]
        ? { baseUrl: cfg.baseUrls[providerId] }
        : custom?.baseUrl
          ? { baseUrl: custom.baseUrl }
          : envBaseUrl
            ? { baseUrl: envBaseUrl }
            : {}),
    envKey,
    ...(apiKey ? { apiKey } : {}),
    keySource,
  }
}

export function createSelectedProvider(selection: ProviderSelection): ModelProvider {
  return createProvider({
    provider: selection.providerId,
    customKind: selection.kind,
    model: selection.model,
    ...(selection.baseUrl ? { baseUrl: selection.baseUrl } : {}),
    ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
  })
}
