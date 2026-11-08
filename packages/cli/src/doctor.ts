import { execFile } from 'node:child_process'
import path from 'node:path'
import { findGitRoot } from '@hesdor/agent-core'
import { hasRipgrep, resolveChecks, sandboxOn, sandboxStatus } from '@hesdor/agent-core'
import { applyEnvProxy } from '@hesdor/providers'
import type { CliFlags } from './args.js'
import { chatgptStatus } from './chatgpt-login.js'
import { loadConfig, configDir } from './config.js'
import { loadEffectiveConfig, managedSettingsPath, projectConfigTrusted, providerBlocked } from './config-layers.js'
import type { ManagedSettings } from './config-layers.js'
import { resolveSelection } from './provider-setup.js'
import { resolveRoles } from './roles.js'
import { fingerprint, isTrusted, projectCodeFiles } from './trust.js'
import { updateCheckStatus } from './update.js'

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
  trusted: boolean
}> {
  const { loadCommandsFrom, loadSkillsFrom, loadPluginsFrom } = await import('@hesdor/agent-core')
  const { readFile } = await import('node:fs/promises')
  const projectExt = path.join(root, '.hesdor')
  const globalDir = configDir()

  const commands = await loadCommandsFrom([path.join(projectExt, 'commands'), path.join(globalDir, 'commands')])
  const skills = await loadSkillsFrom([path.join(projectExt, 'skills'), path.join(globalDir, 'skills')])
  // Never import project plugins here: doctor must be safe to run in an untrusted clone.
  const plugins = await loadPluginsFrom([path.join(globalDir, 'plugins')])
  const projectCode = await projectCodeFiles(root)
  const projectPlugins = projectCode.filter((f) => !f.endsWith('mcp.json')).length
  const trusted = projectCode.length === 0 || (await isTrusted(root, await fingerprint(root, projectCode)))

  let mcpServers = 0
  for (const file of [path.join(globalDir, 'mcp.json'), path.join(projectExt, 'mcp.json'), path.join(globalDir, 'config.json'), path.join(projectExt, 'config.json')]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcp?: Record<string, unknown> }
      mcpServers += Object.keys(parsed.mcp ?? {}).length
    } catch {
      // skip unreadable configs
    }
  }

  return { commands: commands.length, skills: skills.length, plugins: plugins.plugins.length + projectPlugins, mcpServers, trusted }
}

/** ChatGPT sign-in state (keySource 'chatgpt' when signed in, 'none' otherwise). */
async function chatgptDoctorDetail(): Promise<string> {
  const s = await chatgptStatus()
  return s?.signedIn ? `signed in to ChatGPT${s.email ? ` as ${s.email}` : ''} (ChatGPT plan; tokens refresh automatically)` : 'not signed in — run `hesdor login chatgpt`'
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

  // Effective config (managed > flags > env > project > user); a malformed managed file is reported, not thrown.
  let cfg = await loadConfig()
  let managed: ManagedSettings = {}
  try {
    const eff = await loadEffectiveConfig(flags, root ? { root, trusted: await projectConfigTrusted(root, flags.trustWorkspace) } : {})
    ;({ config: cfg, flags, managed } = eff)
    const keys = Object.keys(managed)
    rows.push({ name: 'Managed settings', ok: true, detail: keys.length ? `${managedSettingsPath()} (${keys.join(', ')})` : `none (${managedSettingsPath()})` })
    for (const w of eff.warnings) rows.push({ name: 'Config', ok: null, detail: w })
  } catch (err) {
    rows.push({ name: 'Managed settings', ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
  try {
    const sel = await resolveSelection(flags, cfg)
    const blocked = providerBlocked(managed, sel.providerId)
    if (blocked) rows.push({ name: 'Provider policy', ok: false, detail: blocked })
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
          : sel.keySource === 'command'
            ? 'from apiKeyCommand in config.json (runs at request time)'
          : sel.keySource === 'not-required'
            ? 'local provider — no key needed'
            : sel.providerId === 'chatgpt'
              ? await chatgptDoctorDetail()
            : sel.envKey
              ? `${sel.envKey}: NOT set — run \`hesdor setup\``
              : 'missing — run `hesdor setup`'
    rows.push({ name: 'API credential', ok: sel.keySource !== 'none', detail: credDetail })
    // Configured model roles and the guardian: each must resolve with its own provider's key.
    for (const s of (await resolveRoles(flags, cfg, sel)).status) rows.push({ name: `Role ${s.role}`, ok: s.ok, detail: s.detail })
  } catch (err) {
    rows.push({ name: 'AI provider', ok: false, detail: err instanceof Error ? err.message : String(err) })
  }

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy) {
    // Never print the URL: it may carry credentials.
    rows.push(
      applyEnvProxy()
        ? { name: 'Proxy', ok: true, detail: 'HTTPS_PROXY/HTTP_PROXY set — model requests use it (NO_PROXY honored)' }
        : { name: 'Proxy', ok: false, detail: `proxy variables are set but Node ${process.version} cannot apply them at runtime: use Node 24.14+ or set NODE_USE_ENV_PROXY=1 (Node 22.21+)` },
    )
  }
  if (process.env.NODE_EXTRA_CA_CERTS) rows.push({ name: 'Extra CA', ok: true, detail: 'NODE_EXTRA_CA_CERTS set' })
  rows.push({ name: 'Telemetry', ok: true, detail: 'none — Hesdor collects and sends no usage data' })
  rows.push({ name: 'Update check', ok: true, detail: await updateCheckStatus(cfg) })
  const sb = cfg.sandbox
  const sbStatus = sandboxStatus()
  rows.push({
    name: 'Sandbox',
    // Configured but unavailable: a warning, or a failure when failIfUnavailable makes run_command refuse.
    ok: !sandboxOn(sb) || sbStatus.available ? true : sb.failIfUnavailable ? false : null,
    detail: `${sandboxOn(sb) ? `${sb.mode}, network ${sb.network ?? 'off'}` : 'off'} · ${sbStatus.available ? `${sbStatus.backend} available` : sbStatus.reason}${sandboxOn(sb) && !sbStatus.available && !sb.failIfUnavailable ? ' — commands run unsandboxed' : ''}`,
  })

  if (root) {
    try {
      const found = await resolveChecks(root, cfg.checks)
      const list = found.checks.map((c) => `${c.kind}: ${c.name}`).join(' · ')
      rows.push({ name: 'Edit checks', ok: true, detail: list || 'none (set checks in config.json, or install prettier, eslint, oxlint, biome or typescript in the repo)' })
      rows.push({
        name: 'Test runner',
        ok: found.test ? true : null,
        detail: found.test ? `${found.test.argv.join(' ')} (${found.test.source})` : 'none detected; set checks.test in config.json',
      })
    } catch {
      // detection is best-effort
    }
    try {
      const ext = await countExtensions(root)
      const parts = [
        `${ext.commands} commands`,
        `${ext.skills} skills`,
        `${ext.plugins} plugins`,
      ]
      rows.push({
        name: 'Extensions',
        ok: ext.trusted ? true : null,
        detail:
          parts.join(' · ') +
          (ext.mcpServers > 0 ? ` · ${ext.mcpServers} mcp server(s)` : '') +
          (ext.trusted ? '' : ' · project plugins/MCP not trusted (run `hesdor` here to review)'),
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
