/** Wire format: OpenAI /chat/completions, OpenAI /responses, or Anthropic /v1/messages. */
export type ProviderKind = 'openai' | 'openai-responses' | 'anthropic'
export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'openai-responses', 'anthropic']

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
  /** Alternate key variables, checked in order after `envKey`. */
  envKeys?: string[]
  /** Extra HTTP headers sent with every request (e.g. gateway attribution). */
  headers?: Record<string, string>
  /** Anthropic wire only: send the key as x-api-key (default) or Authorization: Bearer. */
  authHeader?: 'x-api-key' | 'bearer'
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
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    requiresApiKey: true,
    // gpt-6.1-sol and gpt-6.1-terra call tools only through the Responses API.
    defaultModel: 'gpt-6.1-sol',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT plan (Continue with ChatGPT, no API key)',
    // Sign-in tokens from `hesdor login chatgpt`, not a key; see chatgpt-auth.ts. The login saves an account-listed model.
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: false,
    defaultModel: 'gpt-6.1-sol',
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
    defaultModel: 'claude-sonnet-5-5',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (300+ models)',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    requiresApiKey: true,
    headers: { 'HTTP-Referer': 'https://github.com/ksjxixi-gif/Hesdor', 'X-OpenRouter-Title': 'Hesdor' },
    defaultModel: 'anthropic/claude-sonnet-5.5',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    requiresApiKey: true,
    defaultModel: 'openai/gpt-oss-120b',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-flash',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    requiresApiKey: true,
    defaultModel: 'mistral-large-4',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    envKey: 'TOGETHER_API_KEY',
    requiresApiKey: true,
    defaultModel: 'openai/gpt-oss-120b',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
    requiresApiKey: true,
    defaultModel: 'accounts/fireworks/models/glm-5p3-flash',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    // xAI marks Chat Completions as legacy; encrypted reasoning only round-trips over Responses.
    kind: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'grok-4.7',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    envKey: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-v4.1-flash',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    envKey: 'OPENCODE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-v4.1-flash',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    envKeys: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    requiresApiKey: true,
    defaultModel: 'gemini-3.8-flash',
  },
  {
    id: 'cerebras',
    label: 'Cerebras Inference',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    requiresApiKey: true,
    defaultModel: 'gpt-oss-120b',
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    kind: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    envKey: 'SAMBANOVA_API_KEY',
    requiresApiKey: true,
    defaultModel: 'gpt-oss-120b',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    requiresApiKey: true,
    defaultModel: 'deepseek-ai/deepseek-v4.1-flash',
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
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    envKey: 'COHERE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'command-a-plus-05-2026',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    kind: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    envKey: 'DEEPINFRA_TOKEN',
    envKeys: ['DEEPINFRA_API_KEY'],
    requiresApiKey: true,
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI (Kimi)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    envKey: 'MOONSHOT_API_KEY',
    requiresApiKey: true,
    defaultModel: 'kimi-k3.1-pro',
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code (subscription)',
    kind: 'openai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    envKey: 'KIMI_API_KEY',
    requiresApiKey: true,
    // China accounts: --base-url https://api.kimi.com/coding/v1
    defaultModel: 'kimi-for-coding',
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    kind: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZAI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'glm-5.3',
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen (Model Studio, international)',
    kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    requiresApiKey: true,
    defaultModel: 'qwen3.8-max',
  },
  {
    id: 'qwen-coding-plan',
    label: 'Qwen Coding Plan (subscription, interactive only)',
    // Plan keys are sk-sp-...; the terms forbid automated or non-interactive use, so headless refuses it.
    // https://www.alibabacloud.com/help/en/model-studio/coding-plan
    kind: 'openai',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    envKey: 'ALIBABA_CODING_PLAN_API_KEY',
    requiresApiKey: true,
    defaultModel: 'qwen3.7-plus',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    envKey: 'MINIMAX_API_KEY',
    requiresApiKey: true,
    defaultModel: 'MiniMax-M3',
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    kind: 'openai',
    baseUrl: 'https://api.stepfun.ai/v1',
    envKey: 'STEP_API_KEY',
    requiresApiKey: true,
    defaultModel: 'step-3.7-flash',
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    kind: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    envKey: 'AI_GATEWAY_API_KEY',
    requiresApiKey: true,
    defaultModel: 'zai/glm-5.3',
  },
  {
    id: 'requesty',
    label: 'Requesty',
    kind: 'openai',
    baseUrl: 'https://router.requesty.ai/v1',
    envKey: 'REQUESTY_API_KEY',
    requiresApiKey: true,
    defaultModel: 'zai/glm-5.3',
  },
  {
    id: 'nebius',
    label: 'Nebius Token Factory',
    kind: 'openai',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    envKey: 'NEBIUS_API_KEY',
    requiresApiKey: true,
    defaultModel: 'zai-org/GLM-5.3',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    kind: 'openai',
    baseUrl: 'https://api.novita.ai/openai/v1',
    envKey: 'NOVITA_API_KEY',
    requiresApiKey: true,
    defaultModel: 'zai-org/glm-5.3',
  },
  {
    id: 'baseten',
    label: 'Baseten Model APIs',
    kind: 'openai',
    baseUrl: 'https://inference.baseten.co/v1',
    envKey: 'BASETEN_API_KEY',
    requiresApiKey: true,
    defaultModel: 'zai-org/GLM-5.3',
  },
  {
    id: 'chutes',
    label: 'Chutes',
    kind: 'openai',
    baseUrl: 'https://llm.chutes.ai/v1',
    envKey: 'CHUTES_API_KEY',
    requiresApiKey: true,
    defaultModel: 'moonshotai/Kimi-K3-TEE',
  },
  {
    id: 'bedrock',
    label: 'Claude on Amazon Bedrock (API key)',
    kind: 'anthropic',
    // Messages API on bedrock-runtime; other regions: --base-url https://bedrock-runtime.<region>.amazonaws.com/anthropic
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic',
    envKey: 'AWS_BEARER_TOKEN_BEDROCK',
    requiresApiKey: true,
    defaultModel: 'global.anthropic.claude-sonnet-5-5',
  },
  {
    id: 'azure-claude',
    label: 'Claude on Microsoft Foundry',
    kind: 'anthropic',
    // https://<resource>.services.ai.azure.com/anthropic; the model is the deployment name.
    baseUrlEnvKey: 'ANTHROPIC_FOUNDRY_BASE_URL',
    envKey: 'ANTHROPIC_FOUNDRY_API_KEY',
    requiresApiKey: true,
    defaultModel: 'claude-sonnet-5-5',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI (v1 API)',
    kind: 'openai-responses',
    // https://<resource>.openai.azure.com/openai/v1; the model is the deployment name.
    baseUrlEnvKey: 'AZURE_OPENAI_BASE_URL',
    envKey: 'AZURE_OPENAI_API_KEY',
    requiresApiKey: true,
    defaultModel: 'gpt-6.1-sol',
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
    id: 'litellm',
    label: 'LiteLLM proxy (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:4000/v1',
    envKey: 'LITELLM_API_KEY',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (local)',
    kind: 'openai',
    // Port 9931 since llama.cpp v0.9 (2026-10); older builds use 8080.
    baseUrl: 'http://127.0.0.1:9931/v1',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    kind: 'openai',
    // Tool calls need: vllm serve ... --enable-auto-tool-choice --tool-call-parser <name>
    baseUrl: 'http://localhost:8000/v1',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    id: 'jan',
    label: 'Jan (local)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1337/v1',
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
