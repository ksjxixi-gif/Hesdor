import readline from 'node:readline/promises'
import { PROVIDER_PRESETS, getPreset } from '@hesdor/providers'
import type { ProviderKind, ProviderPreset } from '@hesdor/providers'
import { saveCredential } from './auth.js'
import { loadConfig, saveConfig } from './config.js'

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * First-run wizard: pick a provider, store its key (never inside a repo),
 * set the default model. Interactive in a TTY; also accepts piped answers
 * (one per line: provider, [custom-id, format, base-url], api-key, model).
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
    scripted = raw.split(/\r?\n/).map((l) => l.trim())
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

  const askSecret = async (question: string): Promise<string> => {
    if (!rl) {
      const answer = scripted[scriptIdx] ?? ''
      scriptIdx++
      console.log(`${question} [hidden]`)
      return answer
    }
    rl.close()
    rl = undefined
    const answer = await readHiddenLine(question)
    rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return answer.trim()
  }

  try {
    console.log(`${BOLD}Hesdor setup${RESET}`)
    console.log('Pick an AI provider:\n')

    for (let i = 0; i < PROVIDER_PRESETS.length; i++) {
      const p = PROVIDER_PRESETS[i]!
      const keyHint = p.requiresApiKey ? (p.envKey ? `uses ${p.envKey}` : '') : 'no key needed'
      console.log(`  ${String(i + 1).padStart(2)})  ${p.id.padEnd(22)} ${DIM}${p.label} · ${keyHint}${RESET}`)
    }
    console.log(`  ${String(PROVIDER_PRESETS.length + 1).padStart(2)})  custom${' '.repeat(19)}${DIM}your own OpenAI- or Anthropic-compatible endpoint${RESET}`)
    console.log()

    let providerId = ''
    let preset: ProviderPreset | undefined
    let customKind: ProviderKind | undefined
    for (;;) {
      const answer = (await ask('Number or provider id: ')).trim().toLowerCase()
      const byNumber = /^\d+$/.test(answer) ? PROVIDER_PRESETS[Number(answer) - 1]?.id : undefined
      const isCustom = answer === 'custom' || answer === 'other' || Number(answer) === PROVIDER_PRESETS.length + 1
      if (isCustom) {
        for (;;) {
          const customId = (await ask('Provider id (letters, numbers, ., _ or -): ')).trim().toLowerCase()
          if (/^[a-z0-9][a-z0-9._-]{0,39}$/.test(customId) && !getPreset(customId) && customId !== 'custom') {
            providerId = customId
            break
          }
          console.log('Use a new provider id with 1-40 letters, numbers, dots, underscores or hyphens.')
        }
        for (;;) {
          const format = (await ask('API format [openai]: ')).trim().toLowerCase() || 'openai'
          if (format === 'openai' || format === 'openai-compatible') {
            customKind = 'openai'
            break
          }
          if (format === 'anthropic' || format === 'anthropic-compatible') {
            customKind = 'anthropic'
            break
          }
          console.log('Format must be openai or anthropic.')
        }
        break
      }
      providerId = byNumber ?? answer
      preset = getPreset(providerId)
      if (preset) break
      console.log('Not a valid provider — try again.')
    }

    const cfg = await loadConfig()

    // Custom endpoints need a base URL before anything else.
    const envBaseUrl = preset?.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined
    let baseUrl = customKind ? undefined : preset?.baseUrl ?? cfg.baseUrls?.[providerId] ?? envBaseUrl
    if (!baseUrl) {
      for (;;) {
        const example = customKind === 'anthropic' ? 'https://your-endpoint' : 'https://your-endpoint/v1'
        const answer = (await ask(`Base URL for ${preset?.label ?? providerId} (e.g. ${example}): `)).trim()
        if (isHttpUrl(answer)) {
          baseUrl = answer
          if (customKind) {
            await saveConfig({ customProviders: { ...cfg.customProviders, [providerId]: { kind: customKind, baseUrl: answer } } })
          } else {
            await saveConfig({ baseUrls: { ...cfg.baseUrls, [providerId]: answer } })
          }
          console.log('✓ endpoint saved')
          break
        }
        console.log('URL must start with http:// or https://')
      }
    }

    const envKey = preset?.envKey ?? (customKind ? 'HESDOR_CUSTOM_API_KEY' : undefined)
    const envValue = envKey ? process.env[envKey] : undefined
    if (envValue) {
      console.log(`✓ ${envKey} already set in your environment — using it.`)
    } else {
      const required = preset?.requiresApiKey ?? false
      const hint = required ? 'REQUIRED' : 'optional — leave empty if your endpoint needs none'
      const key = await askSecret(`API key (${hint}): `)
      if (key === '' && required) {
        console.log('No key entered. Re-run `hesdor setup` later.')
        return 1
      }
      if (key !== '') {
        await saveCredential(providerId, key)
        console.log('✓ key saved to your global Hesdor profile')
      }
    }

    const keepModel = cfg.provider === providerId ? cfg.model : undefined
    const defaultModel = keepModel ?? preset?.defaultModel ?? 'local-model'
    const model = (await ask(`Default model [${defaultModel}]: `)) || defaultModel

    await saveConfig({ provider: providerId, model })
    console.log(`\n✓ provider: ${providerId}`)
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function readHiddenLine(question: string): Promise<string> {
  const input = process.stdin
  if (!input.setRawMode) return new Promise((resolve) => resolve(''))

  process.stdout.write(question)
  const wasRaw = input.isRaw ?? false
  input.setRawMode(true)
  input.resume()

  return new Promise((resolve) => {
    let value = ''
    const finish = (): void => {
      input.off('data', onData)
      input.setRawMode?.(wasRaw)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n' || char === '\u0004' || char === '\u0003') {
          finish()
          return
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    input.on('data', onData)
  })
}

/** `hesdor provider [<id>]` — show or persist the default provider. */
export async function runProviderCommand(value: string): Promise<number> {
  const providerId = value.trim().toLowerCase()
  if (providerId === '') {
    const cfg = await loadConfig()
    console.log(
      cfg.provider ?? 'no default provider set (auto-detects from available keys)',
    )
    return 0
  }
  const cfg = await loadConfig()
  if (!getPreset(providerId) && !cfg.customProviders?.[providerId]) {
    console.error(`✗ unknown provider "${providerId}". Run \`hesdor setup\` to add a custom endpoint.`)
    return 1
  }
  await saveConfig({ provider: providerId })
  console.log(`✓ default provider set to ${providerId}`)
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
