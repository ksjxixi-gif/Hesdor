import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RunEvent } from '@hesdor/protocol'

export interface PluginBeforeResult {
  deny?: string
  input?: unknown
}

export interface PluginHooks {
  /** Runs before a tool executes; may deny the call or replace its input. */
  'tool.execute.before'?(payload: { tool: string; input: unknown }): Promise<PluginBeforeResult | void>
  /** Observes completed tool executions (success or failure). */
  'tool.execute.after'?(payload: { tool: string; input: unknown; result?: unknown; error?: string }): Promise<void>
  /** Observes every protocol event emitted during runs. */
  event?(event: RunEvent): void
}

export interface LoadedPlugin {
  name: string
  file: string
  hooks: PluginHooks
}

export interface PluginWarning {
  file: string
  error: string
}

/** Global extensions dir, shared with the CLI's global config location. */
export function hesdorGlobalDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'hesdor')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'hesdor')
}

/**
 * Load plugin modules from the given directories. Each `*.js` / `*.mjs` /
 * `*.cjs` file default-exports a hooks object. Broken files become warnings,
 * never fatal.
 */
export async function loadPluginsFrom(dirs: string[]): Promise<{ plugins: LoadedPlugin[]; warnings: PluginWarning[] }> {
  const plugins: LoadedPlugin[] = []
  const warnings: PluginWarning[] = []

  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.(mjs|js|cjs)$/i.test(entry.name)) continue
      const file = path.join(dir, entry.name)
      try {
        const mod = await import(pathToFileURL(file).href)
        const hooks = (mod.default ?? mod) as unknown
        if (typeof hooks !== 'object' || hooks === null) throw new Error('default export must be a hooks object')
        plugins.push({ name: entry.name.replace(/\.(mjs|js|cjs)$/i, ''), file, hooks: hooks as PluginHooks })
      } catch (err) {
        warnings.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return { plugins, warnings }
}
