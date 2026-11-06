import React from 'react'
import { render } from 'ink'
import { stopAllJobs } from '@hesdor/agent-core'
import type { CliFlags } from './args.js'
import { loadEffectiveConfig, projectConfigTrusted, providerBlocked } from './config-layers.js'
import { resolveSelection } from './provider-setup.js'
import { resolveWorkspaceRoot } from './run.js'
import { createSession } from './session.js'
import { findSession } from './sessions.js'
import type { StoredSession } from './sessions.js'
import { askTrust, isTrusted, rememberTrust } from './trust.js'
import { updateNotice } from './update.js'
import { App } from './ui/App.js'

/** Mount the interactive Ink UI after validating the environment. */
export async function startInteractive(flags: CliFlags, initialPrompt?: string): Promise<number> {
  const ws = resolveWorkspaceRoot(process.cwd(), flags.allowHome)
  if ('error' in ws) {
    console.error(`✗ ${ws.error}`)
    return 1
  }
  const root = ws.root

  let resumed: StoredSession | undefined
  if (flags.continue || flags.resume !== undefined) {
    try {
      resumed = await findSession(root, flags.resume)
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  let providerId: string
  let model: string
  let keySource: string
  let update: string | null = null
  try {
    // shortcut: a project config approved at this start's trust prompt applies from the next start.
    const eff = await loadEffectiveConfig(flags, { root, trusted: await projectConfigTrusted(root, flags.trustWorkspace) })
    for (const w of eff.warnings) console.error(`• ${w}`)
    const cfg = eff.config
    flags = eff.flags
    // Cached result only; a stale cache refreshes in the background for the next start.
    if (process.stdout.isTTY && process.stdin.isTTY) update = await updateNotice(cfg).catch(() => null)
    const sel = await resolveSelection(flags, cfg)
    const blocked = providerBlocked(eff.managed, sel.providerId)
    if (blocked) throw new Error(blocked)
    if (sel.keySource === 'none') {
      throw new Error('no API credential found — run `hesdor setup` to save a key in one minute')
    }
    providerId = sel.providerId
    model = sel.model
    keySource = sel.keySource
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  // Created after every early return above, so its MCP children are always disposed below.
  let startup = true
  const session = await createSession({
    root,
    warn: (m) => console.error(`• ${m}`),
    trust: async (files, print) => {
      if (flags.trustWorkspace || (await isTrusted(root, print))) return true
      // Only ask before the UI takes over the terminal; a /reload after an edit stays untrusted until restart.
      if (!startup || !process.stdin.isTTY) return false
      const yes = await askTrust(root, files)
      if (yes) await rememberTrust(root, print)
      return yes
    },
  })
  startup = false
  const info = session.info

  if (keySource === 'not-required') keySource = 'local'
  // Alternate screen buffer: full-app feel, terminal restored on exit.
  process.stdout.write('\x1b[?1049h\x1b[H')
  // A crash must not leave the terminal stuck in the alternate screen.
  const onFatal = (err: unknown): void => {
    process.stdout.write('\x1b[?1049l')
    console.error(`✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    session.dispose()
    process.exit(1)
  }
  process.on('unhandledRejection', onFatal)
  process.on('uncaughtException', onFatal)
  const instance = render(
    <App
      info={info}
      flags={flags}
      providerId={providerId}
      initialModel={model}
      session={session}
      initialPrompt={initialPrompt}
      keySource={keySource}
      resumed={resumed}
      notices={[...(ws.warning ? [ws.warning] : []), ...(update ? [update] : [])]}
    />,
    { exitOnCtrlC: false },
  )
  try {
    await instance.waitUntilExit()
  } finally {
    process.off('unhandledRejection', onFatal)
    process.off('uncaughtException', onFatal)
    process.stdout.write('\x1b[?1049l')
    session.dispose()
    await stopAllJobs() // background dev servers must not outlive the session
  }
  return 0
}
