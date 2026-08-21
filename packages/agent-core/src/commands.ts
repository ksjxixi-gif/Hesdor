import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export interface CustomCommand {
  name: string
  description: string
  /** Prompt body; `$ARGUMENTS` is replaced with the user's text. */
  template: string
}

function parseFrontmatter(raw: string): { description: string; body: string } {
  if (!raw.startsWith('---')) return { description: '', body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { description: '', body: raw }
  const header = raw.slice(4, end)
  const bodyStart = raw.indexOf('\n', end + 1)
  const body = bodyStart < 0 ? '' : raw.slice(bodyStart + 1)
  let description = ''
  for (const line of header.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0 && line.slice(0, idx).trim() === 'description') description = line.slice(idx + 1).trim()
  }
  return { description, body }
}

/**
 * Custom commands are markdown prompt templates: `<dir>/<name>.md` with
 * optional `description:` frontmatter. Project commands shadow global ones.
 */
export async function loadCommandsFrom(dirs: string[]): Promise<CustomCommand[]> {
  const byName = new Map<string, CustomCommand>()

  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const name = entry.name.replace(/\.md$/i, '').toLowerCase()
      let raw: string
      try {
        raw = await readFile(path.join(dir, entry.name), 'utf8')
      } catch {
        continue
      }
      const { description, body } = parseFrontmatter(raw)
      if (!byName.has(name)) byName.set(name, { name, description: description || firstLine(body).slice(0, 120), template: body.trim() })
    }
  }

  return [...byName.values()]
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
}
