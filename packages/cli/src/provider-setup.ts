import { chatgptSignedIn, createProvider, getPreset, PROVIDER_KINDS, PROVIDER_PRESETS, readChatGPTAuth } from '@hesdor/providers'
import type { Effort, ModelProvider, ProviderKind, ProviderPreset } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import { savedModel } from './config.js'
import type { CustomProviderConfig, HesdorConfig } from './config.js'
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
  keySource: 'environment' | 'stored' | 'command' | 'none' | 'not-required' | 'chatgpt'
  effort?: Effort
  maxTokens?: number
  /** Custom provider extras from config.json. */
  custom?: Pick<CustomProviderConfig, 'authHeader' | 'apiKeyCommand' | 'extraBody' | 'includeUsage'>
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
      PROVIDER_PRESETS.find((p) => p.requiresApiKey && presetEnvKeys(p).some((k) => process.env[k]))?.id ?? 'openai'
  }
  const preset = getPreset(providerId)
  const custom = cfg.customProviders?.[providerId]
  if (
    custom &&
    (!PROVIDER_KINDS.includes(custom.kind) ||
      typeof custom.baseUrl !== 'string' ||
      custom.baseUrl.trim() === '' ||
      (custom.apiKeyCommand !== undefined &&
        (!Array.isArray(custom.apiKeyCommand) || custom.apiKeyCommand.length === 0 || !custom.apiKeyCommand.every((a) => typeof a === 'string'))))
  ) {
    throw new Error(`invalid custom provider configuration for "${providerId}" — run \`hesdor setup\` again`)
  }
  if (!preset && !custom && !flags.baseUrl) {
    throw new Error(`unknown provider "${providerId}" — add it with \`hesdor setup\` or pass --base-url`)
  }

  const auth = await loadAuth()
  const kind = preset?.kind ?? custom?.kind ?? 'openai'
  // First set variable wins; report the primary name when none is set.
  const envKey = preset
    ? (presetEnvKeys(preset).find((k) => process.env[k]) ?? preset.envKey)
    : custom || flags.baseUrl
      ? customEnvKey(providerId, !custom)
      : undefined
  const envValue = envKey ? process.env[envKey] : undefined
  const envBaseUrl = preset?.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined
  const storedValue = auth[providerId]

  let keySource: ProviderSelection['keySource']
  let apiKey: string | undefined
  if (custom?.apiKeyCommand) {
    // A configured command wins; it runs at request time, not here.
    keySource = 'command'
  } else if (preset?.id === 'chatgpt') {
    // ChatGPT sign-in tokens (hesdor login chatgpt), refreshed at request time; never an API key.
    keySource = chatgptSignedIn(await readChatGPTAuth()) ? 'chatgpt' : 'none'
  } else if (!preset?.requiresApiKey) {
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
    // Per-provider memory: another provider's saved model is never sent here (CLI-6).
    model: flags.model ?? savedModel(cfg, providerId, !flags.provider) ?? preset?.defaultModel ?? 'local-model',
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
    ...(flags.effort ? { effort: flags.effort } : {}),
    ...((flags.maxTokens ?? cfg.maxTokens) ? { maxTokens: flags.maxTokens ?? cfg.maxTokens } : {}),
    ...(custom
      ? { custom: { authHeader: custom.authHeader, apiKeyCommand: custom.apiKeyCommand, extraBody: custom.extraBody, includeUsage: custom.includeUsage } }
      : {}),
  }
}

/** Key variable names for a preset: the primary `envKey`, then its alternates. */
export function presetEnvKeys(preset: ProviderPreset): string[] {
  return [...(preset.envKey ? [preset.envKey] : []), ...(preset.envKeys ?? [])]
}

/**
 * Env var for a custom provider's key: one per provider id, so a key meant for
 * one gateway is never sent to another. Unsaved one-off `--base-url` runs may
 * still use the shared HESDOR_CUSTOM_API_KEY.
 */
export function customEnvKey(providerId: string, oneOff: boolean): string {
  const own = `HESDOR_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  return oneOff && !process.env[own] ? 'HESDOR_CUSTOM_API_KEY' : own
}

/** Plans whose terms allow interactive use only (Qwen Coding Plan: https://www.alibabacloud.com/help/en/model-studio/coding-plan). */
const INTERACTIVE_ONLY: Record<string, string> = {
  'qwen-coding-plan':
    'the Qwen Coding Plan is for interactive use only; its terms forbid automated scripts and other non-interactive use (https://www.alibabacloud.com/help/en/model-studio/coding-plan). Use `hesdor` interactively, or pick another provider (e.g. qwen with a pay-as-you-go key)',
}
let headlessProcess = false
/** Called by run/ask/plan/review (not acp: a person types each prompt there): from then on interactive-only plans are refused, including roles and subagents. */
export function markHeadless(): void {
  headlessProcess = true
}
/** Why a provider may not run in this (headless) process, if it may not. */
export function headlessRefusal(providerId: string): string | undefined {
  return headlessProcess ? INTERACTIVE_ONLY[providerId] : undefined
}

export function createSelectedProvider(selection: ProviderSelection): ModelProvider {
  const refusal = headlessRefusal(selection.providerId)
  if (refusal) throw new Error(refusal)
  return createProvider({
    provider: selection.providerId,
    customKind: selection.kind,
    model: selection.model,
    ...(selection.baseUrl ? { baseUrl: selection.baseUrl } : {}),
    ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(selection.maxTokens ? { maxTokens: selection.maxTokens } : {}),
    ...(selection.custom?.authHeader ? { authHeader: selection.custom.authHeader } : {}),
    ...(selection.custom?.apiKeyCommand ? { apiKeyCommand: selection.custom.apiKeyCommand } : {}),
    ...(selection.custom?.extraBody ? { extraBody: selection.custom.extraBody } : {}),
    ...(selection.custom?.includeUsage !== undefined ? { includeUsage: selection.custom.includeUsage } : {}),
  })
}
