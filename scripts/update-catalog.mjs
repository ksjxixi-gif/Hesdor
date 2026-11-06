#!/usr/bin/env node
// Regenerates packages/providers/src/catalog.json: a trimmed models.dev snapshot keyed by Hesdor preset id.
// Usage: node scripts/update-catalog.mjs [path/to/api.json]   (default: fetch https://models.dev/api.json)
import { readFileSync, writeFileSync } from 'node:fs'

// shortcut: reads the preset -> models.dev id map out of check-presets.mjs (importing it would run the drift check);
// move the map to a shared module if a third script needs it.
const checkSrc = readFileSync(new URL('./check-presets.mjs', import.meta.url), 'utf8')
const block = checkSrc.match(/const MODELS_DEV_ID = \{([\s\S]*?)\n\}/)?.[1]
if (!block) throw new Error('could not find MODELS_DEV_ID in scripts/check-presets.mjs')
const ids = Object.fromEntries([...block.matchAll(/^\s*'?([\w-]+)'?: '([^']+)'/gm)].map(([, preset, md]) => [preset, md]))
if (ids.openai !== 'openai') throw new Error('could not parse MODELS_DEV_ID')

const source = process.argv[2]
const api = source
  ? JSON.parse(readFileSync(source, 'utf8'))
  : await fetch('https://models.dev/api.json').then((r) => {
      if (!r.ok) throw new Error(`models.dev returned HTTP ${r.status}`)
      return r.json()
    })

const price = (v) => (typeof v === 'number' ? v : null)
/**
 * Row: [context, maxOutput, input, output, cacheRead, cacheWrite, flags, releaseDate, tier?]
 * Prices are USD per million tokens (null = unknown). flags: t tool_call, r reasoning, i image input,
 * d deprecated, b beta/alpha. tier: [contextAbove, input, output, cacheRead] for long-context pricing.
 */
function row(m) {
  const c = m.cost ?? {}
  const flags =
    (m.tool_call ? 't' : '') +
    (m.reasoning ? 'r' : '') +
    (m.modalities?.input?.includes('image') ? 'i' : '') +
    (m.status === 'deprecated' ? 'd' : m.status === 'beta' || m.status === 'alpha' ? 'b' : '')
  const r = [m.limit?.context ?? null, m.limit?.output ?? null, price(c.input), price(c.output), price(c.cache_read), price(c.cache_write), flags, m.release_date ?? null]
  const t = c.tiers?.find((x) => x.tier?.type === 'context' && typeof x.tier.size === 'number')
  if (t) r.push([t.tier.size, price(t.input), price(t.output), price(t.cache_read)])
  return r
}

const out = {}
let models = 0
for (const [preset, mdId] of Object.entries(ids)) {
  const provider = api[mdId]
  if (!provider) {
    console.warn(`skip ${preset}: models.dev has no provider "${mdId}"`)
    continue
  }
  out[preset] = {}
  for (const [id, m] of Object.entries(provider.models ?? {})) {
    if (m.type && m.type !== 'chat') continue // embeddings, image, speech, ...
    out[preset][id] = row(m)
    models++
  }
}

const file = new URL('../packages/providers/src/catalog.json', import.meta.url)
const json = JSON.stringify({ source: 'https://models.dev/api.json', fetched: new Date().toISOString().slice(0, 10), providers: out })
writeFileSync(file, `${json}\n`)
console.log(`catalog.json: ${Object.keys(out).length} providers, ${models} models, ${(json.length / 1024).toFixed(0)} KB`)
