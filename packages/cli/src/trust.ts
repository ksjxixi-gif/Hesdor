import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import readline from 'node:readline/promises'
import path from 'node:path'
import { realPathOf } from '@hesdor/agent-core'
import { configDir, readJsonObject, writeFileAtomic } from './config.js'

/**
 * Workspace trust. A repository's `.hesdor/plugins/*.js` and `.hesdor/mcp.json`
 * run code on this machine, so a freshly cloned repo must not load them until
 * the user approves that exact content. Approval is pinned to a sha256 of the
 * files: any later change asks again.
 */

/** Project files that execute code or change settings (plugins, .hesdor/mcp.json, .mcp.json, .hesdor/hooks.json, .hesdor/config.json), sorted. */
export async function projectCodeFiles(root: string): Promise<string[]> {
  const ext = path.join(root, '.hesdor')
  const files: string[] = []
  try {
    for (const e of await readdir(path.join(ext, 'plugins'), { withFileTypes: true })) {
      if (e.isFile() && /\.(mjs|js|cjs)$/i.test(e.name)) files.push(path.join(ext, 'plugins', e.name))
    }
  } catch {
    // no plugins dir
  }
  for (const file of [path.join(ext, 'mcp.json'), path.join(root, '.mcp.json'), path.join(ext, 'hooks.json'), path.join(ext, 'config.json')]) {
    try {
      if ((await stat(file)).isFile()) files.push(file)
    } catch {
      // no such config
    }
  }
  return files.sort()
}

export async function fingerprint(root: string, files: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

type TrustStore = Record<string, string>

const trustFile = (): string => path.join(configDir(), 'trusted-workspaces.json')
const keyOf = (root: string): string => {
  const real = realPathOf(root)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

export async function isTrusted(root: string, print: string): Promise<boolean> {
  return (await readJsonObject<TrustStore>(trustFile()))[keyOf(root)] === print
}

export async function rememberTrust(root: string, print: string): Promise<void> {
  const store = await readJsonObject<TrustStore>(trustFile())
  store[keyOf(root)] = print
  await writeFileAtomic(trustFile(), `${JSON.stringify(store, null, 2)}\n`, 0o600)
}

/** Ask on the terminal before anything else renders. Defaults to no. */
export async function askTrust(root: string, files: string[]): Promise<boolean> {
  console.error('\nThis repository contains project code that Hesdor would run on your machine:')
  for (const f of files) console.error(`  ${path.relative(root, f).split(path.sep).join('/')}`)
  console.error('Only trust repositories you or your team control.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('Trust this repository and load them? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export const UNTRUSTED_WARNING =
  'skipped project plugins, MCP servers, hooks and settings (.hesdor/plugins, .hesdor/mcp.json, .mcp.json, .hesdor/hooks.json, .hesdor/config.json) because this repository is not trusted. ' +
  'Run `hesdor` here to review them, or pass --trust-workspace.'
