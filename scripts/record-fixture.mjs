#!/usr/bin/env node
// Record one real streaming response into packages/providers/src/__fixtures__/<adapter>.<name>.sse
// for the SSE re-chunking tests (packages/providers/src/sse-fixtures.test.ts).
//
//   RECORD_API_KEY=... node scripts/record-fixture.mjs <adapter> <name> --model <id> [--base-url <url>]
//
// adapter: openai-compatible | anthropic | openai-responses
// The key is read from RECORD_API_KEY only, sent in the request and never written anywhere:
// the fixture holds the raw response body plus a few `:` comment lines (ignored by SSE parsers).
// No request or response headers are recorded. Review the file before committing it.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASE = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'openai-responses': 'https://api.openai.com/v1',
}

const [adapter, name, ...rest] = process.argv.slice(2)
const flag = (f) => {
  const i = rest.indexOf(f)
  return i >= 0 ? rest[i + 1] : undefined
}
const model = flag('--model')
const base = (flag('--base-url') ?? DEFAULT_BASE[adapter] ?? '').replace(/\/$/, '')
const key = process.env.RECORD_API_KEY
if (!DEFAULT_BASE[adapter] || !name || !/^[\w-]+$/.test(name) || !model) {
  console.error('usage: RECORD_API_KEY=... node scripts/record-fixture.mjs <openai-compatible|anthropic|openai-responses> <name> --model <id> [--base-url <url>]')
  process.exit(2)
}
if (!key) {
  console.error('RECORD_API_KEY is not set')
  process.exit(2)
}

// A prompt that exercises multi-byte text and a streamed tool call.
const PROMPT =
  'Greet me in English, Arabic and Japanese with one emoji, then call read_file with path "README.md". Keep the text under 30 words.'
const TOOL = {
  name: 'read_file',
  description: 'Read a file in the repository.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const requests = {
  'openai-compatible': () => ({
    url: `${base}/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    body: {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: PROMPT }],
      tools: [{ type: 'function', function: TOOL }],
    },
  }),
  anthropic: () => ({
    url: `${base}/v1/messages`,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: {
      model,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
    },
  }),
  'openai-responses': () => ({
    url: `${base}/responses`,
    headers: { authorization: `Bearer ${key}` },
    body: {
      model,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      input: [{ role: 'user', content: PROMPT }],
      tools: [{ type: 'function', ...TOOL, strict: false }],
    },
  }),
}

const req = requests[adapter]()
const res = await fetch(req.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...req.headers },
  body: JSON.stringify(req.body),
})
const body = await res.text()
if (!res.ok) {
  // The error body is the provider's; it never contains our key.
  console.error(`HTTP ${res.status}: ${body.slice(0, 500)}`)
  process.exit(1)
}
if (body.includes(key)) {
  console.error('refusing to write: the response body contains the API key')
  process.exit(1)
}

const host = new URL(base).host
const header =
  `: recorded ${new Date().toISOString().slice(0, 10)} from ${host} (${adapter}, model ${model})\n` +
  ': raw response body; request and response headers are not recorded\n\n'
const out = fileURLToPath(new URL(`../packages/providers/src/__fixtures__/${adapter}.${name}.sse`, import.meta.url))
writeFileSync(out, header + body.replace(/\r\n/g, '\n'))
console.log(`wrote ${out} (${body.length} bytes). Review it, then run: npx vitest run packages/providers/src/sse-fixtures.test.ts`)
