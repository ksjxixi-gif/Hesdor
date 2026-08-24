import React from 'react'
import { render } from 'ink'
import { findGitRoot } from '@hesdor/agent-core'
import type { CliFlags } from './args.js'
import { loadConfig } from './config.js'
import { resolveSelection } from './provider-setup.js'
import { createSession } from './session.js'
import { App } from './ui/App.js'

/** Mount the interactive Ink UI after validating the environment. */
export async function startInteractive(flags: CliFlags, initialPrompt?: string): Promise<number> {
  const root = findGitRoot(process.cwd())
  if (!root) {
    console.error('✗ hesdor runs inside a Git repository. cd into a project or run `git init` first.')
    console.error('  Tip: run `hesdor setup` once to configure your provider.')
    return 1
  }

  const session = await createSession({ root, warn: (m) => console.error(`• ${m}`) })
  const info = session.info

  let providerId: string
  let model: string
  let baseUrl: string | undefined
  let keySource: string
  try {
    const cfg = await loadConfig()
    const sel = await resolveSelection(flags, cfg)
    if (sel.keySource === 'none') {
      throw new Error('no API credential found — run `hesdor setup` to save a key in one minute')
    }
    providerId = sel.providerId
    model = sel.model
    baseUrl = sel.baseUrl
    keySource = sel.keySource
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  if (keySource === 'not-required') keySource = 'local'
  // Alternate screen buffer: full-app feel, terminal restored on exit.
  process.stdout.write('\x1b[?1049h\x1b[H')
  const instance = render(
    <App
      info={info}
      flags={flags}
      providerId={providerId}
      initialModel={model}
      session={session}
      initialPrompt={initialPrompt}
      initialBaseUrl={baseUrl}
      keySource={keySource}
    />,
    { exitOnCtrlC: false },
  )
  try {
    await instance.waitUntilExit()
  } finally {
    process.stdout.write('\x1b[?1049l')
    session.dispose()
  }
  return 0
}
