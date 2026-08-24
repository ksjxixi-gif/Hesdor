import { AnthropicProvider } from './anthropic.js'
import type { AnthropicConfig } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { OpenAICompatibleConfig } from './openai-compatible.js'
import type { ModelProvider, ProviderError as _PE } from './provider.js'
import { joinUrl } from './provider.js'
import { getPreset, PROVIDER_PRESETS } from './presets.js'
import type { ProviderKind } from './presets.js'

export interface CreateProviderOptions {
  /** Preset id (see PROVIDER_PRESETS) — e.g. openai, anthropic, openrouter, ollama. */
  provider: string
  model?: string
  /** Override the endpoint (self-hosted or custom gateway). */
  baseUrl?: string
  /** Wire format for an unknown provider id. Defaults to OpenAI-compatible in the CLI. */
  customKind?: ProviderKind
  /** Overrides the environment variable when set. */
  apiKey?: string
  /** Output token ceiling (default 8192). */
  maxTokens?: number
}

export class UnknownProviderError extends Error {
  constructor(id: string) {
    const known = PROVIDER_PRESETS.map((p) => p.id)
    super(`unknown provider "${id}". Known providers: ${known.join(', ')}`)
    this.name = 'UnknownProviderError'
  }
}

/** Build a ModelProvider from a preset id plus optional overrides. */
export function createProvider(opts: CreateProviderOptions): ModelProvider {
  const preset = getPreset(opts.provider)
  if (!preset && !opts.customKind) throw new UnknownProviderError(opts.provider)

  const kind = preset?.kind ?? opts.customKind!
  const model = opts.model || preset?.defaultModel || 'local-model'
  const apiKey = opts.apiKey ?? (preset?.envKey ? process.env[preset.envKey] : undefined)

  if (preset?.requiresApiKey && !apiKey) {
    throw new Error(
      `provider "${preset.id}" needs an API key. Set ${preset.envKey} in your environment ` +
        `or run \`hesdor doctor\` to inspect the current setup.`,
    )
  }

  const baseUrl = opts.baseUrl ?? preset?.baseUrl
  if (!baseUrl) {
    throw new Error(`provider "${opts.provider}" requires a base URL (use --base-url)`)
  }

  if (kind === 'anthropic') {
    const config: AnthropicConfig = {
      apiKey: apiKey ?? '',
      model,
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      baseUrl,
    }
    return new AnthropicProvider(config)
  }

  const config: OpenAICompatibleConfig = {
    name: preset?.id ?? opts.provider,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    // Unknown gateways vary in how strictly they validate request fields.
    includeUsage: preset ? preset.id !== 'ollama' && preset.id !== 'lmstudio' : false,
    ...extraHeaders(preset?.id ?? opts.provider),
  }
  return new OpenAICompatibleProvider(config)
}

function extraHeaders(providerId: string): { headers?: Record<string, string> } {
  // OpenRouter prefers attribution headers.
  if (providerId === 'openrouter') {
    return { headers: { 'x-title': 'Hesdor' } }
  }
  return {}
}

/**
 * Fetch the model catalog from a provider's /models endpoint.
 * Works with OpenAI-compatible servers (OpenAI, OpenRouter, Groq, Ollama,
 * LM Studio, ...) and Anthropic's /v1/models. Used by the /model picker.
 */
export async function fetchModels(opts: {
  provider: string
  baseUrl?: string
  apiKey?: string
  customKind?: ProviderKind
}): Promise<string[]> {
  const preset = getPreset(opts.provider)
  if (!preset && !opts.customKind) throw new Error(`unknown provider "${opts.provider}"`)

  const kind = preset?.kind ?? opts.customKind!
  const base = opts.baseUrl ?? preset?.baseUrl
  if (!base) throw new Error(`provider "${opts.provider}" requires a base URL`)

  const path = kind === 'anthropic' ? '/v1/models' : '/models'
  const headers: Record<string, string> = {}
  const key = opts.apiKey ?? (preset?.envKey ? process.env[preset.envKey] : undefined)
  if (kind === 'anthropic') {
    headers['x-api-key'] = key ?? ''
    headers['anthropic-version'] = '2023-06-01'
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }

  const res = await fetch(joinUrl(base, path), { headers })
  if (!res.ok) throw new Error(`could not list models (HTTP ${res.status})`)
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort()
}
