#!/usr/bin/env node
// Drift check: every hosted preset's defaultModel should still be listed (and not deprecated)
// for that provider on models.dev. Exit 1 on drift so the weekly workflow goes red.
import { readFileSync } from 'node:fs'

// Preset id -> models.dev provider id. null = no public catalog (local, custom, Hesdor Cloud).
const MODELS_DEV_ID = {
  openai: 'openai',
  // Account-specific catalog from GET /v1/models with the ChatGPT sign-in; the login picks a listed model.
  chatgpt: null,
  hesdor: null,
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistral',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  xai: 'xai',
  'opencode-zen': 'opencode',
  'opencode-go': 'opencode-go',
  gemini: 'google',
  cerebras: 'cerebras',
  sambanova: 'sambanova',
  nvidia: 'nvidia',
  huggingface: 'huggingface',
  cohere: 'cohere',
  deepinfra: 'deepinfra',
  moonshot: 'moonshotai',
  'kimi-code': 'kimi-code-plan-global',
  zai: 'zai',
  qwen: 'alibaba',
  'qwen-coding-plan': 'alibaba-coding-plan',
  minimax: 'minimax',
  stepfun: 'stepfun-ai',
  vercel: 'vercel',
  // models.dev lists Requesty's bare ids (glm-5.3); the preset pins the provider (zai/glm-5.3).
  requesty: null,
  nebius: 'nebius',
  novita: 'novita-ai',
  baseten: 'baseten',
  chutes: 'chutes',
  bedrock: 'amazon-bedrock',
  // The model is the user's deployment name.
  'azure-claude': null,
  'azure-openai': null,
  litellm: null,
  llamacpp: null,
  vllm: null,
  jan: null,
  ollama: null,
  lmstudio: null,
  'openai-compatible': null,
  'anthropic-compatible': null,
}

// shortcut: regex over the source instead of importing the TS module, so this runs on plain Node 22 without a build.
const src = readFileSync(new URL('../packages/providers/src/presets.ts', import.meta.url), 'utf8')
const presets = [...src.matchAll(/id: '([^']+)'[\s\S]*?defaultModel: '([^']+)'/g)].map(([, id, model]) => ({ id, model }))
if (!presets.some((p) => p.id === 'openai')) throw new Error('could not parse presets.ts')

const res = await fetch('https://models.dev/api.json')
if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`)
const catalog = await res.json()

const problems = []
for (const { id, model } of presets) {
  if (!(id in MODELS_DEV_ID)) {
    problems.push(`${id}: no models.dev mapping; add it to MODELS_DEV_ID in scripts/check-presets.mjs`)
    continue
  }
  const providerId = MODELS_DEV_ID[id]
  if (!providerId) continue
  const entry = catalog[providerId]?.models?.[model]
  if (!catalog[providerId]) problems.push(`${id}: models.dev has no provider "${providerId}"`)
  else if (!entry) problems.push(`${id}: defaultModel "${model}" is not listed for models.dev provider "${providerId}"`)
  else if (entry.status === 'deprecated') problems.push(`${id}: defaultModel "${model}" is marked deprecated on models.dev`)
  else if (entry.tool_call === false) problems.push(`${id}: defaultModel "${model}" does not support tool calling`)
}

const checked = presets.filter((p) => MODELS_DEV_ID[p.id]).length
if (problems.length) {
  console.error(`Preset drift (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`OK: ${checked} hosted preset defaults are listed on models.dev.`)
