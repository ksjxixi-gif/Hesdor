import { execFile } from 'node:child_process'
import path from 'node:path'
import { findGitRoot } from '@hesdor/agent-core'
import { hasRipgrep } from '@hesdor/agent-core'
import type { CliFlags } from './args.js'
import { loadConfig, configDir } from './config.js'
import { resolveSelection } from './provider-setup.js'

export interface DoctorRow {
  name: string
  ok: boolean | null
  detail: string
}

/** Best-effort census of project + global extension surfaces. */
async function countExtensions(root: string): Promise<{
  commands: number
  skills: number
  plugins: number
  mcpServers: number
}> {
  const { loadCommandsFrom, loadSkillsFrom, loadPluginsFrom } = await import('@hesdor/agent-core')
  const { readFile } = await import('node:fs/promises')
  const projectExt = path.join(root, '.hesdor')
  const globalDir = configDir()

  const commands = await loadCommandsFrom([path.join(projectExt, 'commands'), path.join(globalDir, 'commands')])
  const skills = await loadSkillsFrom([path.join(projectExt, 'skills'), path.join(globalDir, 'skills')])
  const plugins = await loadPluginsFrom([path.join(projectExt, 'plugins'), path.join(globalDir, 'plugins')])

  let mcpServers = 0
  for (const file of [path.join(globalDir, 'mcp.json'), path.join(projectExt, 'mcp.json'), path.join(globalDir, 'config.json'), path.join(projectExt, 'config.json')]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcp?: Record<string, unknown> }
      mcpServers += Object.keys(parsed.mcp ?? {}).length
    } catch {
      // skip unreadable configs
    }
  }

  return { commands: commands.length, skills: skills.length, plugins: plugins.plugins.length, mcpServers }
}

function nodeVersion(): Promise<string> {
  return Promise.resolve(process.version)
}

function checkCommand(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split(/\r?\n/)[0] ?? '')
    })
  })
}

/** Collect doctor diagnostics. Never prints or returns secret values. */
export async function collectDoctorRows(flags: CliFlags): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = []

  const version = await nodeVersion()
  const major = Number(version.replace(/^v/, '').split('.')[0])
  rows.push({ name: 'Node.js', ok: major >= 22, detail: `${version}${major >= 22 ? '' : ' (22+ required)'}` })

  const git = await checkCommand('git', ['--version'])
  rows.push({ name: 'Git', ok: git !== null, detail: git ?? 'not found on PATH' })

  const root = findGitRoot(process.cwd())
  rows.push({ name: 'Repository', ok: root !== null, detail: root ?? 'no .git found above the current directory' })

  const rg = await hasRipgrep()
  rows.push({
    name: 'ripgrep',
    ok: rg,
    detail: rg ? 'found — fast code search enabled' : 'not installed — using built-in fallback search',
  })

  const cfg = await loadConfig()
  try {
    const sel = await resolveSelection(flags, cfg)
    rows.push({
      name: 'AI provider',
      ok: sel.keySource !== 'none',
      detail: `${sel.providerId} · model ${sel.model}`,
    })
    const credDetail =
      sel.keySource === 'environment'
        ? `${sel.envKey}: set (value hidden)`
        : sel.keySource === 'stored'
          ? 'key saved via hesdor setup (value hidden)'
          : sel.keySource === 'not-required'
            ? 'local provider — no key needed'
            : sel.envKey
              ? `${sel.envKey}: NOT set — run \`hesdor setup\``
              : 'missing — run `hesdor setup`'
    rows.push({ name: 'API credential', ok: sel.keySource !== 'none', detail: credDetail })
  } catch (err) {
    rows.push({ name: 'AI provider', ok: false, detail: err instanceof Error ? err.message : String(err) })
  }

  if (root) {
    try {
      const ext = await countExtensions(root)
      const parts = [
        `${ext.commands} commands`,
        `${ext.skills} skills`,
        `${ext.plugins} plugins`,
      ]
      rows.push({
        name: 'Extensions',
        ok: true,
        detail: parts.join(' · ') + (ext.mcpServers > 0 ? ` · ${ext.mcpServers} mcp server(s)` : ''),
      })
    } catch {
      // extension counting is best-effort
    }
  }

  return rows
}

export async function runDoctor(flags: CliFlags): Promise<number> {
  const rows = await collectDoctorRows(flags)
  for (const row of rows) {
    const icon = row.ok === true ? '✓' : row.ok === false ? '✗' : '?'
    console.log(`${icon} ${row.name.padEnd(14)} ${row.detail}`)
  }
  const failed = rows.filter((r) => r.ok === false)
  if (failed.length > 0) {
    console.log(`\n${failed.length} issue(s) found. Fix the ✗ items above.`)
    return 1
  }
  console.log('\nAll checks passed. Run `hesdor` to start.')
  return 0
}
