import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { ProviderKind } from '@hesdor/providers'
import type { PermissionRules } from '@hesdor/agent-core'

export interface CustomProviderConfig {
  /** Wire format: openai (chat completions), openai-responses, or anthropic. */
  kind: ProviderKind
  baseUrl: string
  /** Anthropic wire: send the key as x-api-key (default) or Authorization: Bearer. */
  authHeader?: 'x-api-key' | 'bearer'
  /** Command (argv array, run without a shell) that prints the API key; cached ~50 minutes. */
  apiKeyCommand?: string[]
  /** Extra JSON fields merged into every request body. */
  extraBody?: Record<string, unknown>
  /** Chat Completions: set false if the endpoint rejects stream_options.include_usage. */
  includeUsage?: boolean
}

export interface HesdorConfig {
  /** Editor hint: the JSON Schema for this file (docs/config.schema.json). Ignored by Hesdor. */
  $schema?: string
  /** Interactive default mode; --mode overrides it. */
  mode?: 'build' | 'plan' | 'ask'
  /** Default reasoning effort; --effort overrides it. */
  effort?: 'low' | 'medium' | 'high'
  /** Default provider preset id. */
  provider?: string
  /** Legacy single default model; it belonged to `provider` and is migrated into `models` on save. */
  model?: string
  /** Default model per provider id, so switching provider never sends another provider's model id. */
  models?: Record<string, string>
  /** Output token ceiling (default 8192); --max-tokens overrides it. */
  maxTokens?: number
  /** Saved endpoints for custom (openai/anthropic-compatible) providers. */
  baseUrls?: Record<string, string>
  /** User-defined providers created by `hesdor setup`. */
  customProviders?: Record<string, CustomProviderConfig>
  /**
   * run_command and file-write rules (deny > ask > allow). Only this user-scope file can
   * allow; a project's .hesdor/permissions.json can only add ask/deny rules.
   */
  permissions?: PermissionRules
  /** Daily notify-only check for a newer release (interactive runs only); false turns it off. */
  updateCheck?: boolean
  /**
   * Models for internal jobs, each `provider/model` resolved with that provider's own key:
   * small (compaction, guardian), subagent (explore/task default), oracle (the `oracle` tool),
   * fallback (tried in order when the main model is overloaded, rate limited, out of quota or unreachable).
   */
  roles?: { small?: string; subagent?: string; oracle?: string; fallback?: string[] }
  /** Guardian auto-review of approvals no rule settles (interactive; headless only with --guardian). Model defaults to roles.small. */
  guardian?: { enabled?: boolean; model?: string }
}

/**
 * Global config location. API keys deliberately do NOT live in config.json;
 * setup stores them separately in auth.json or they come from the environment.
 */
export function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hesdor')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'hesdor')
}

export function configFile(): string {
  return path.join(configDir(), 'config.json')
}

/**
 * Read a JSON object file. Missing means empty; anything unparseable throws,
 * because treating it as empty would let the next save wipe every entry.
 */
export async function readJsonObject<T extends object>(file: string): Promise<T> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {} as T
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''))
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or delete the file, then retry.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object. Fix or delete the file, then retry.`)
  }
  return parsed as T
}

/** Write via a temp file and rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, data, { encoding: 'utf8', mode })
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export async function loadConfig(): Promise<HesdorConfig> {
  return readJsonObject<HesdorConfig>(configFile())
}

/** Provider ids: 1-40 lowercase letters, digits, dots, underscores or hyphens. */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** Model ids never contain whitespace. Returns an error message, or undefined when valid. */
export function modelIdError(model: string): string | undefined {
  return model !== '' && /^\S+$/.test(model) ? undefined : `invalid model id "${model}" (no spaces allowed)`
}

/**
 * The model saved for a provider. A legacy single `model` applies only to the provider it was saved
 * with, or, when no provider was saved, to an auto-detected one (`autoDetected`: no -p flag).
 */
export function savedModel(cfg: HesdorConfig, providerId: string, autoDetected: boolean): string | undefined {
  const legacy = cfg.provider ? cfg.provider === providerId : autoDetected
  return cfg.models?.[providerId] ?? (legacy ? cfg.model : undefined)
}

/**
 * Merge and write. `model` is stored per provider (the update's provider, else the saved one);
 * callers validate ids first (see PROVIDER_ID_RE, modelIdError).
 */
export async function saveConfig(update: HesdorConfig): Promise<void> {
  const current = await loadConfig()
  // The legacy global model belonged to the saved provider (CLI-6).
  if (current.model && current.provider) {
    current.models = { [current.provider]: current.model, ...current.models }
    delete current.model
  }
  const { model, ...rest } = update
  const merged: HesdorConfig = { ...current, ...rest }
  if (current.models && rest.models) merged.models = { ...current.models, ...rest.models }
  if (model !== undefined) {
    if (merged.provider) merged.models = { ...merged.models, [merged.provider]: model }
    else merged.model = model
  }
  await writeFileAtomic(configFile(), `${JSON.stringify(merged, null, 2)}\n`)
}
