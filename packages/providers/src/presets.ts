export type ProviderKind = 'openai' | 'anthropic'

export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  /** Default endpoint; may be overridden per-call for self-hosted gateways. */
  baseUrl?: string
  /** Environment variable for a service endpoint without a baked-in public URL. */
  baseUrlEnvKey?: string
  /** Environment variable that holds the API key. */
  envKey?: string
  /** Local providers (Ollama, LM Studio) do not need a key. */
  requiresApiKey: boolean
  defaultModel: string
}

/**
 * Provider catalog. Every OpenAI-compatible preset is one entry; adding a new
 * compatible provider is a single line here.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'hesdor',
    label: 'Hesdor Cloud',
    kind: 'openai',
    baseUrlEnvKey: 'HESDOR_BASE_URL',
    envKey: 'HESDOR_API_KEY',
    requiresApiKey: true,
    defaultModel: 'auto',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    envKey: 'ANTHROPIC_API_KEY',
    requiresApiKey: true,
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (300+ models)',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    requiresApiKey: true,
    defaultModel: 'anthropic/claude-sonnet-4.5',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    requiresApiKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    requiresApiKey: true,
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    requiresApiKey: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
    requiresApiKey: true,
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'grok-4-fast-non-reasoning',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    envKey: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-v4-flash',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKey: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-v4-flash',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'cerebras',
    label: 'Cerebras Inference',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    requiresApiKey: true,
    defaultModel: 'llama-3.3-70b',
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    kind: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    envKey: 'SAMBANOVA_API_KEY',
    requiresApiKey: true,
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    kind: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    envKey: 'PERPLEXITY_API_KEY',
    requiresApiKey: true,
    defaultModel: 'sonar-pro',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    requiresApiKey: true,
    defaultModel: 'meta/llama-3.3-70b-instruct',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Inference',
    kind: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    envKey: 'HF_TOKEN',
    requiresApiKey: true,
    defaultModel: 'openai/gpt-oss-120b',
  },
  {
    id: 'cohere',
    label: 'Cohere Compatibility API',
    kind: 'openai',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    envKey: 'COHERE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'command-a-03-2025',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    kind: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    envKey: 'DEEPINFRA_TOKEN',
    requiresApiKey: true,
    defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    envKey: undefined,
    requiresApiKey: false,
    defaultModel: 'qwen2.5-coder:7b',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    envKey: undefined,
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    id: 'openai-compatible',
    label: 'Custom OpenAI-compatible endpoint',
    kind: 'openai',
    baseUrl: undefined,
    envKey: 'OPENAI_COMPATIBLE_API_KEY',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    id: 'anthropic-compatible',
    label: 'Custom Anthropic-compatible endpoint',
    kind: 'anthropic',
    baseUrl: undefined,
    envKey: 'ANTHROPIC_COMPATIBLE_API_KEY',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
]

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
