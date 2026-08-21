import { AnthropicProvider } from './anthropic.js'
import type { AnthropicConfig } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { OpenAICompatibleConfig } from './openai-compatible.js'
import type { ModelProvider, ProviderError as _PE } from './provider.js'
import { joinUrl } from './provider.js'
import { getPreset } from './presets.js'

export interface CreateProviderOptions {
  /** Preset id (see PROVIDER_PRESETS) — e.g. openai, anthropic, openrouter, ollama. */
  provider: string
  model?: string
  /** Override the endpoint (self-hosted or custom gateway). */
  baseUrl?: string
  /** Overrides the environment variable when set. */
  apiKey?: string
  /** Output token ceiling (default 8192). */
  maxTokens?: number
}

export class UnknownProviderError extends Error {
  constructor(id: string) {
    const known = ['openai', 'anthropic', 'openrouter', 'groq', 'deepseek', 'mistral', 'together', 'fireworks', 'xai', 'ollama', 'lmstudio', 'openai-compatible', 'anthropic-compatible']
    super(`unknown provider "${id}". Known providers: ${known.join(', ')}`)
    this.name = 'UnknownProviderError'
  }
}

/** Build a ModelProvider from a preset id plus optional overrides. */
export function createProvider(opts: CreateProviderOptions): ModelProvider {
  const preset = getPreset(opts.provider)
  if (!preset) throw new UnknownProviderError(opts.provider)

  const model = opts.model || preset.defaultModel
  const apiKey = opts.apiKey ?? (preset.envKey ? process.env[preset.envKey] : undefined)

  if (preset.requiresApiKey && !apiKey) {
    throw new Error(
      `provider "${preset.id}" needs an API key. Set ${preset.envKey} in your environment ` +
        `or run \`hesdor doctor\` to inspect the current setup.`,
    )
  }

  if (preset.kind === 'anthropic') {
    const config: AnthropicConfig = {
      apiKey: apiKey ?? '',
      model,
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
    }
    return new AnthropicProvider(config)
  }

  const baseUrl = opts.baseUrl ?? preset.baseUrl
  if (!baseUrl) {
    throw new Error(`provider "${preset.id}" requires a base URL (use --base-url)`)
  }
  const config: OpenAICompatibleConfig = {
    name: preset.id,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...extraHeaders(preset.id),
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
}): Promise<string[]> {
  const preset = getPreset(opts.provider)
  if (!preset) throw new Error(`unknown provider "${opts.provider}"`)

  const base = opts.baseUrl ?? preset.baseUrl
  if (!base) throw new Error(`provider "${opts.provider}" requires a base URL`)

  const path = preset.kind === 'anthropic' ? '/v1/models' : '/models'
  const headers: Record<string, string> = {}
  const key = opts.apiKey ?? (preset.envKey ? process.env[preset.envKey] : undefined)
  if (preset.kind === 'anthropic') {
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
