import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'
import type { SkillInfo } from './skills.js'

export interface CustomCommand {
  name: string
  description: string
  /** Prompt body; `$ARGUMENTS` is replaced with the user's text. */
  template: string
  /** When set (MCP prompts), the host awaits this with the user's text instead of filling `template`. */
  expand?: (args: string) => Promise<string>
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
      const { meta, body } = parseFrontmatter(raw)
      const description = (meta.description ?? '').replace(/\s+/g, ' ').trim()
      if (!byName.has(name)) byName.set(name, { name, description: description || firstLine(body).slice(0, 120), template: body.trim() })
    }
  }

  return [...byName.values()]
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
}

/** `/skill-name` runs a skill (user-explicit activation); a custom command with the same name wins. */
export function skillCommand(skill: SkillInfo): CustomCommand {
  return {
    name: skill.name,
    description: skill.description,
    template: `Load the "${skill.name}" skill with read_skill and follow it.\n\n$ARGUMENTS`,
  }
}
