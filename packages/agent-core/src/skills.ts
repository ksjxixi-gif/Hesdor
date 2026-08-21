import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from './tools/types.js'
import type { AnyTool } from './tools/types.js'

export interface SkillInfo {
  name: string
  description: string
  /** Absolute path to the SKILL.md file. */
  path: string
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: raw }
  const header = raw.slice(4, end)
  const bodyStart = raw.indexOf('\n', end + 1)
  const body = bodyStart < 0 ? '' : raw.slice(bodyStart + 1)
  const meta: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body }
}

/**
 * Skills live at `<dir>/<skill-name>/SKILL.md` with optional frontmatter
 * `name:` and `description:`. Earlier dirs in the list win on name conflicts,
 * so pass project dirs before global ones.
 */
export async function loadSkillsFrom(dirs: string[]): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>()

  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(dir, entry.name, 'SKILL.md')
      let raw
      try {
        raw = await readFile(skillPath, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(raw)
      const firstLine = body.split(/\r?\n/).find((l) => l.trim() !== '')?.replace(/^#+\s*/, '') ?? ''
      const name = (meta.name || entry.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      if (!byName.has(name)) {
        byName.set(name, { name, description: meta.description || firstLine.slice(0, 120), path: skillPath })
      }
    }
  }

  return [...byName.values()]
}

/** Bullet list injected into the system prompt so the model knows what exists. */
export function skillsSummary(skills: SkillInfo[]): string | undefined {
  if (skills.length === 0) return undefined
  const shown = skills.slice(0, 25)
  const lines = shown.map((s) => `- ${s.name}: ${s.description}`)
  if (skills.length > shown.length) {
    lines.push(`- …and ${skills.length - shown.length} more`)
  }
  return ['AVAILABLE SKILLS', 'Load one with the read_skill tool before doing a task it covers:', ...lines].join('\n')
}

const MAX_SKILL_BYTES = 32 * 1024

/** READ-risk tool that returns a skill's full instructions on demand. */
export function createReadSkillTool(skills: SkillInfo[]): AnyTool {
  return defineTool({
    name: 'read_skill',
    description:
      'Load the full instructions of a named skill (workflow guide). Call this before performing a task that matches an available skill.',
    risk: 'READ',
    schema: z.object({
      name: z.string().min(1).describe('Skill name from the available-skills list'),
    }),
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name.toLowerCase())
      if (!skill) {
        throw new Error(`unknown skill "${input.name}". Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`)
      }
      const raw = await readFile(skill.path, 'utf8')
      const content =
        Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES ? `${raw.slice(0, MAX_SKILL_BYTES)}\n... (truncated)` : raw
      return { name: skill.name, content }
    },
  })
}
