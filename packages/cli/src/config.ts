import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export interface HesdorConfig {
  /** Default provider preset id. */
  provider?: string
  /** Default model id. */
  model?: string
  /** Saved endpoints for custom (openai/anthropic-compatible) providers. */
  baseUrls?: Record<string, string>
}

/**
 * Global config location. API keys deliberately do NOT live here —
 * they come from the environment only.
 */
export function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hesdor')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'hesdor')
}

function configFile(): string {
  return path.join(configDir(), 'config.json')
}

export async function loadConfig(): Promise<HesdorConfig> {
  try {
    const raw = await readFile(configFile(), 'utf8')
    const parsed = JSON.parse(raw) as HesdorConfig
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export async function saveConfig(update: HesdorConfig): Promise<void> {
  const current = await loadConfig()
  const merged = { ...current, ...update }
  await mkdir(configDir(), { recursive: true })
  await writeFile(configFile(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}
