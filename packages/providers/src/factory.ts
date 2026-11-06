import { AnthropicProvider } from './anthropic.js'
import { CHATGPT_API_BASE, chatgptAccessToken, listChatGPTModels } from './chatgpt-auth.js'
import type { AnthropicConfig } from './anthropic.js'
import { getModelInfo } from './catalog.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { OpenAICompatibleConfig } from './openai-compatible.js'
import { OpenAIResponsesProvider } from './openai-responses.js'
import type { Effort, ModelProvider } from './provider.js'
import { applyEnvProxy, joinUrl, resolveKey } from './provider.js'
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
  /** Command (argv, no shell) whose stdout is the key; re-run about every 50 minutes. Wins over apiKey. */
  apiKeyCommand?: string[]
  /** Output token ceiling (default 8192). */
  maxTokens?: number
  /** Reasoning effort, mapped to each wire's field. */
  effort?: Effort
  /** Anthropic wire: how the key is sent (default x-api-key, or the preset's choice). */
  authHeader?: 'x-api-key' | 'bearer'
  /** Extra JSON fields merged into every request body (gateway-specific). */
  extraBody?: Record<string, unknown>
  /** Chat Completions: ask for stream usage (stream_options.include_usage). Default on. */
  includeUsage?: boolean
}

export class UnknownProviderError extends Error {
  constructor(id: string) {
    const known = PROVIDER_PRESETS.map((p) => p.id)
    super(`unknown provider "${id}". Known providers: ${known.join(', ')}`)
    this.name = 'UnknownProviderError'
  }
}

/** Local servers whose support for stream_options.include_usage is unverified. */
const NO_STREAM_USAGE = new Set(['lmstudio', 'llamacpp', 'jan'])

/** Build a ModelProvider from a preset id plus optional overrides. */
export function createProvider(opts: CreateProviderOptions): ModelProvider {
  const preset = getPreset(opts.provider)
  if (!preset && !opts.customKind) throw new UnknownProviderError(opts.provider)

  const kind = preset?.kind ?? opts.customKind!
  const model = opts.model || preset?.defaultModel || 'local-model'
  const apiKey = opts.apiKey ?? (preset?.envKey ? process.env[preset.envKey] : undefined)

  if (preset?.requiresApiKey && !apiKey && !opts.apiKeyCommand?.length) {
    throw new Error(
      `provider "${preset.id}" needs an API key. Set ${preset.envKey} in your environment ` +
        `or run \`hesdor doctor\` to inspect the current setup.`,
    )
  }

  const baseUrl = opts.baseUrl ?? preset?.baseUrl
  if (!baseUrl) {
    throw new Error(`provider "${opts.provider}" requires a base URL (use --base-url)`)
  }
  applyEnvProxy()

  const imageInput = getModelInfo(preset?.id ?? opts.provider, model)?.imageInput
  const common = {
    name: preset?.id ?? opts.provider,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(opts.apiKeyCommand?.length ? { apiKeyCommand: opts.apiKeyCommand } : {}),
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.extraBody ? { extraBody: opts.extraBody } : {}),
    ...(preset?.headers ? { headers: preset.headers } : {}),
    // Known text-only models get a note instead of images; unknown models get the images.
    ...(imageInput !== undefined ? { imageInput } : {}),
  }

  if (kind === 'anthropic') {
    const authHeader = opts.authHeader ?? preset?.authHeader
    const config: AnthropicConfig = { ...common, ...(authHeader ? { authHeader } : {}) }
    return new AnthropicProvider(config)
  }
  if (preset?.id === 'chatgpt') {
    // The sign-in tokens are bound to api.openai.com; never send them anywhere else.
    if (baseUrl.replace(/\/+$/, '') !== CHATGPT_API_BASE) throw new Error(`provider "chatgpt" only talks to ${CHATGPT_API_BASE}; remove the base URL override`)
    const { apiKey: _key, apiKeyCommand: _cmd, ...rest } = common as typeof common & { apiKeyCommand?: string[] }
    return new OpenAIResponsesProvider({ ...rest, baseUrl: CHATGPT_API_BASE, chatgptPlan: true, token: (failed) => chatgptAccessToken(failed ? { failed } : {}) })
  }
  if (kind === 'openai-responses') return new OpenAIResponsesProvider(common)

  const config: OpenAICompatibleConfig = {
    ...common,
    includeUsage: opts.includeUsage ?? !(preset && NO_STREAM_USAGE.has(preset.id)),
  }
  return new OpenAICompatibleProvider(config)
}

/** Model ids that cannot serve a chat/tool loop (embeddings, audio, images, moderation). */
const NON_CHAT = /embed|whisper|tts|transcri|speech|audio|realtime|dall-e|image|moderation|rerank|sora|davinci|babbage/i

/**
 * Fetch the model catalog from a provider's /models endpoint.
 * Works with OpenAI-compatible servers (OpenAI, OpenRouter, Groq, Ollama,
 * LM Studio, ...) and Anthropic's paginated /v1/models. Used by the /model picker.
 */
export async function fetchModels(opts: {
  provider: string
  baseUrl?: string
  apiKey?: string
  apiKeyCommand?: string[]
  customKind?: ProviderKind
  authHeader?: 'x-api-key' | 'bearer'
  /** Default 15 s for the whole listing. */
  timeoutMs?: number
}): Promise<string[]> {
  const preset = getPreset(opts.provider)
  if (!preset && !opts.customKind) throw new Error(`unknown provider "${opts.provider}"`)

  const kind = preset?.kind ?? opts.customKind!
  const base = opts.baseUrl ?? preset?.baseUrl
  if (!base) throw new Error(`provider "${opts.provider}" requires a base URL`)
  applyEnvProxy()
  if (preset?.id === 'chatgpt') return (await listChatGPTModels(await chatgptAccessToken(), CHATGPT_API_BASE, AbortSignal.timeout(opts.timeoutMs ?? 15_000))).sort()

  const headers: Record<string, string> = {}
  const key = await resolveKey({
    apiKey: opts.apiKey ?? (preset?.envKey ? process.env[preset.envKey] : undefined),
    ...(opts.apiKeyCommand ? { apiKeyCommand: opts.apiKeyCommand } : {}),
  })
  const authHeader = opts.authHeader ?? preset?.authHeader
  if (kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (key) Object.assign(headers, authHeader === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key })
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000)
  const ids: string[] = []
  let after: string | undefined
  // Anthropic pages with has_more/last_id; OpenAI-style servers return one page.
  for (let page = 0; page < 20; page++) {
    const url = kind === 'anthropic' ? joinUrl(base, `/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`) : joinUrl(base, '/models')
    const res = await fetch(url, { headers, signal })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`could not list models (HTTP ${res.status})${body ? `: ${body}` : ''}`)
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }>; has_more?: boolean; last_id?: string }
    for (const m of json.data ?? []) if (typeof m.id === 'string' && m.id.length > 0) ids.push(m.id)
    if (kind !== 'anthropic' || !json.has_more || !json.last_id) break
    after = json.last_id
  }
  return [...new Set(ids)].filter((id) => !NON_CHAT.test(id)).sort()
}
