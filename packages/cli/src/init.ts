import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HESDOR_MD = `# HESDOR.md

Project instructions for the Hesdor agent. Everything here is context and
convention — it can guide the agent but never overrides its security policy.

## Project overview

Describe what this project is, its architecture and key directories.

## Commands

- Install: \`pnpm install\`
- Build: \`pnpm build\`
- Test: \`pnpm test\`
- Lint: \`pnpm lint\`

## Conventions

- Language, formatting and style rules the agent should follow.
- Where new modules belong.
- Naming conventions.

## Rules for the agent

- Never touch \`.env\` files or secrets.
- Run the test suite after code changes when tests exist.
- Keep commits small (the user commits; you do not commit).
`

const HESDORIGNORE = `# Paths Hesdor should never read or search.
# Same syntax as .gitignore. .gitignore rules are applied automatically.

.env
.env.*
*.pem
*.key
secrets/
dist/
coverage/
`

export interface InitResult {
  created: string[]
  skipped: string[]
  overwritten: string[]
}

/** Create starter HESDOR.md + .hesdorignore in cwd. Never overwrites without force. */
export async function runInit(force: boolean): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], overwritten: [] }
  await writeStarter('HESDOR.md', HESDOR_MD, force, result)
  await writeStarter('.hesdorignore', HESDORIGNORE, force, result)
  return result
}

async function writeStarter(name: string, content: string, force: boolean, result: InitResult): Promise<void> {
  const target = path.join(process.cwd(), name)
  let exists = true
  try {
    await readFile(target, 'utf8')
  } catch {
    exists = false
  }
  if (exists && !force) {
    result.skipped.push(name)
    return
  }
  await writeFile(target, content, 'utf8')
  if (exists) result.overwritten.push(name)
  else result.created.push(name)
}

export function printInitResult(result: InitResult): void {
  for (const name of result.created) console.log(`✓ created ${name}`)
  for (const name of result.overwritten) console.log(`✓ overwrote ${name}`)
  for (const name of result.skipped) console.log(`• ${name} already exists — left untouched (use --force to overwrite)`)
}
