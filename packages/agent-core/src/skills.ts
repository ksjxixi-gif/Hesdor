import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { parseFrontmatter } from './frontmatter.js'
import { defineTool } from './tools/types.js'
import type { AnyTool } from './tools/types.js'

export interface SkillInfo {
  name: string
  description: string
  /** Absolute path to the SKILL.md file; its directory holds the bundled files. */
  path: string
}

/** Agent Skills name rule (agentskills.io/specification). */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Skill directories in precedence order: project scope (`.hesdor`, the
 * cross-client `.agents`, and `.claude`), then the same in user scope.
 */
export function skillDirs(root: string, globalDir: string, home: string = os.homedir()): string[] {
  return [
    path.join(root, '.hesdor', 'skills'),
    path.join(root, '.agents', 'skills'),
    path.join(root, '.claude', 'skills'),
    path.join(globalDir, 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
  ]
}

/**
 * Skills live at `<dir>/<skill-name>/SKILL.md` with frontmatter `name:` and
 * `description:`. Earlier dirs in the list win on name conflicts, so pass
 * project dirs before global ones. Names that break the spec still load
 * (lenient, as the spec's client guide recommends) but are reported to `warn`.
 */
export async function loadSkillsFrom(dirs: string[], warn: (message: string) => void = () => {}): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>()

  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // Installers often symlink skills into these dirs.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillPath = path.join(dir, entry.name, 'SKILL.md')
      let raw
      try {
        raw = await readFile(skillPath, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(raw)
      const declared = meta.name?.trim()
      if (declared && (declared.length > 64 || !SKILL_NAME.test(declared))) {
        warn(`skill ${skillPath}: "${declared}" is not a valid skill name (lowercase letters, digits and single hyphens, at most 64)`)
      } else if (declared && declared !== entry.name) {
        warn(`skill ${skillPath}: name "${declared}" does not match its directory "${entry.name}"`)
      }
      const name = (declared || entry.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      const firstLine = body.split('\n').find((l) => l.trim() !== '')?.replace(/^#+\s*/, '') ?? ''
      const description = (meta.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1024) || firstLine.slice(0, 120)
      if (!byName.has(name)) byName.set(name, { name, description, path: skillPath })
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
const MAX_LISTED_FILES = 200

const truncate = (text: string): string =>
  Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES ? `${text.slice(0, MAX_SKILL_BYTES)}\n... (truncated)` : text

/** Bundled files (scripts/, references/, assets/, ...) relative to the skill dir, without reading them. */
async function listSkillFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length <= MAX_LISTED_FILES) {
    const rel = queue.shift()!
    let entries
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') queue.push(child)
      } else if (child !== 'SKILL.md') files.push(child)
    }
  }
  files.sort()
  return files.length > MAX_LISTED_FILES ? [...files.slice(0, MAX_LISTED_FILES), '... (more files not listed)'] : files
}

/**
 * Reads one bundled file. This is the only way to read a user-scope skill's
 * files (read_file is confined to the repo), so the real path must stay
 * inside the skill's real directory: no `..` and no symlink escapes.
 */
async function readSkillFile(dir: string, file: string): Promise<string> {
  const realDir = await realpath(dir)
  let target: string
  try {
    target = await realpath(path.resolve(dir, file))
  } catch {
    throw new Error(`no file "${file}" in this skill`)
  }
  const rel = path.relative(realDir, target)
  if (rel === '' || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) {
    throw new Error(`"${file}" is outside the skill directory`)
  }
  if (!(await stat(target)).isFile()) throw new Error(`"${file}" is not a file`)
  const data = await readFile(target)
  if (data.includes(0)) return `(binary file, ${data.length} bytes)`
  return truncate(data.toString('utf8'))
}

/** READ-risk tool that returns a skill's instructions, or one of its bundled files, on demand. */
export function createReadSkillTool(skills: SkillInfo[]): AnyTool {
  const names = skills.map((s) => s.name)
  return defineTool({
    name: 'read_skill',
    description:
      'Load the full instructions of a named skill (workflow guide). Call this before performing a task that matches an available skill. ' +
      'The result lists the skill directory and its bundled files; relative paths in a skill are relative to that directory. ' +
      'Pass `file` to read one bundled file.',
    risk: 'READ',
    schema: z.object({
      name: (names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string().min(1)).describe(
        'Skill name from the available-skills list',
      ),
      file: z.string().min(1).optional().describe('A bundled file to read, relative to the skill directory, e.g. "references/guide.md"'),
    }),
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name.toLowerCase())
      if (!skill) {
        throw new Error(`unknown skill "${input.name}". Available: ${names.join(', ') || '(none)'}`)
      }
      const dir = path.dirname(skill.path)
      if (input.file) return { name: skill.name, dir, file: input.file, content: await readSkillFile(dir, input.file) }
      const content = truncate(await readFile(skill.path, 'utf8'))
      return { name: skill.name, dir, files: await listSkillFiles(dir), content }
    },
  })
}
