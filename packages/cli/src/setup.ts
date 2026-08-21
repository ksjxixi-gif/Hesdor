import readline from 'node:readline/promises'
import { PROVIDER_PRESETS, getPreset } from '@hesdor/providers'
import { saveCredential } from './auth.js'
import { loadConfig, saveConfig } from './config.js'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * First-run wizard: pick a provider, store its key (never inside a repo),
 * set the default model. Interactive in a TTY; also accepts piped answers
 * (one per line: provider, [base-url], api-key, model).
 */
export async function runSetup(): Promise<number> {
  const isTTY = process.stdin.isTTY === true
  let rl: readline.Interface | undefined
  let scripted: string[] = []

  if (!isTTY) {
    const raw = await new Promise<string>((resolve) => {
      let buffer = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => (buffer += chunk))
      process.stdin.on('end', () => resolve(buffer))
    })
    scripted = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  } else {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  }
  let scriptIdx = 0

  const ask = async (question: string): Promise<string> => {
    if (rl) return (await rl.question(question)).trim()
    const answer = scripted[scriptIdx] ?? ''
    scriptIdx++
    console.log(`${question} ${answer}`)
    return answer
  }

  try {
    console.log(`${BOLD}Hesdor setup${RESET}`)
    console.log('Pick an AI provider:\n')

    for (let i = 0; i < PROVIDER_PRESETS.length; i++) {
      const p = PROVIDER_PRESETS[i]!
      const keyHint = p.requiresApiKey ? (p.envKey ? `uses ${p.envKey}` : '') : 'no key needed'
      console.log(`  ${String(i + 1).padStart(2)})  ${p.id.padEnd(22)} ${DIM}${p.label} · ${keyHint}${RESET}`)
    }
    console.log()

    let presetId = ''
    for (;;) {
      const answer = (await ask('Number or provider id: ')).trim().toLowerCase()
      const byNumber = /^\d+$/.test(answer) ? PROVIDER_PRESETS[Number(answer) - 1]?.id : undefined
      presetId = byNumber ?? answer
      if (getPreset(presetId)) break
      console.log('Not a valid provider — try again.')
    }

    const preset = getPreset(presetId)!
    const cfg = await loadConfig()

    // Custom endpoints need a base URL before anything else.
    let baseUrl = preset.baseUrl ?? cfg.baseUrls?.[presetId]
    if (!baseUrl) {
      for (;;) {
        const answer = (
          await ask(`Base URL for ${preset.label} (e.g. https://your-endpoint/v1): `)
        ).trim()
        if (/^https?:\/\//i.test(answer)) {
          baseUrl = answer
          await saveConfig({ baseUrls: { ...cfg.baseUrls, [presetId]: answer } })
          console.log('✓ endpoint saved')
          break
        }
        console.log('URL must start with http:// or https://')
      }
    }

    const envValue = preset.envKey ? process.env[preset.envKey] : undefined
    if (preset.requiresApiKey && preset.envKey && envValue) {
      console.log(`✓ ${preset.envKey} already set in your environment — using it.`)
    } else {
      const required = preset.requiresApiKey
      const hint = required ? 'REQUIRED' : 'optional — leave empty if your endpoint needs none'
      const key = (await ask(`API key (${hint}): `))
      if (key === '' && required) {
        console.log('No key entered. Re-run `hesdor setup` later.')
        return 1
      }
      if (key !== '') {
        await saveCredential(presetId, key)
        console.log('✓ key saved to your global Hesdor profile')
      }
    }

    const keepModel = cfg.provider === presetId ? cfg.model : undefined
    const defaultModel = keepModel ?? preset.defaultModel
    const model = (await ask(`Default model [${defaultModel}]: `)) || defaultModel

    await saveConfig({ provider: presetId, model })
    console.log(`\n✓ provider: ${presetId}`)
    console.log(`✓ model: ${model}`)
    console.log('\nNext steps:')
    console.log('  cd some-git-project')
    console.log('  hesdor doctor     # verify everything is green')
    console.log('  hesdor            # start the agent')
    return 0
  } finally {
    rl?.close()
  }
}

/** `hesdor provider [<id>]` — show or persist the default provider. */
export async function runProviderCommand(value: string): Promise<number> {
  if (value === '') {
    const cfg = await loadConfig()
    console.log(
      cfg.provider ?? 'no default provider set (auto-detects from available keys)',
    )
    return 0
  }
  if (!getPreset(value)) {
    console.error(`✗ unknown provider "${value}". Known: ${PROVIDER_PRESETS.map((p) => p.id).join(', ')}`)
    return 1
  }
  await saveConfig({ provider: value })
  console.log(`✓ default provider set to ${value}`)
  return 0
}

/** `hesdor model [<id>]` — show or persist the default model. */
export async function runModelCommand(value: string): Promise<number> {
  if (value === '') {
    const cfg = await loadConfig()
    console.log(cfg.model ?? 'no default model set (provider default applies)')
    return 0
  }
  await saveConfig({ model: value })
  console.log(`✓ default model set to ${value}`)
  return 0
}
