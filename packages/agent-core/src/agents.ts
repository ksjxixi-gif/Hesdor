import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.js'

/** A markdown subagent: frontmatter `name`, `description`, `tools`, `model`; the body is its system prompt. */
export interface AgentDef {
  name: string
  description: string
  /** Allowlist; undefined = every tool except task/explore. Claude Code names (Read, Bash, ...) are mapped. */
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  prompt: string
  file: string
}

/** Agent directories in precedence order: project (`.hesdor`, `.claude`), then user scope. */
export function agentDirs(root: string, globalDir: string, home: string = os.homedir()): string[] {
  return [
    path.join(root, '.hesdor', 'agents'),
    path.join(root, '.claude', 'agents'),
    path.join(globalDir, 'agents'),
    path.join(home, '.claude', 'agents'),
  ]
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** Claude Code model aliases mean nothing to other providers: the agent inherits the session model. */
const INHERIT_MODELS = new Set(['inherit', 'sonnet', 'opus', 'haiku', 'fable'])

/** Earlier dirs win on name conflicts. Broken files become warnings. */
export async function loadAgentsFrom(dirs: string[], warn: (message: string) => void = () => {}): Promise<AgentDef[]> {
  const byName = new Map<string, AgentDef>()
  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = path.join(dir, entry.name)
      let raw
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(raw)
      const name = meta.name?.trim() || entry.name.slice(0, -3)
      if (!AGENT_NAME.test(name)) {
        warn(`agent ${file}: invalid name "${name}"`)
        continue
      }
      if (!meta.description?.trim()) {
        warn(`agent ${file}: missing description`)
        continue
      }
      if (byName.has(name)) continue
      const tools = toolList(raw, 'tools', meta.tools)
      const disallowedTools = toolList(raw, 'disallowedTools', meta.disallowedTools)
      const model = meta.model?.trim()
      byName.set(name, {
        name,
        description: meta.description.trim(),
        ...(tools ? { tools } : {}),
        ...(disallowedTools ? { disallowedTools } : {}),
        ...(model && !INHERIT_MODELS.has(model) ? { model } : {}),
        prompt: body.trim(),
        file,
      })
    }
  }
  return [...byName.values()]
}

/** `a, b`, `[a, b]` or a YAML block list (which the frontmatter parser skips; missing it would grant every tool). */
function toolList(raw: string, key: string, value: string | undefined): string[] | undefined {
  let items: string[]
  if (value !== undefined) {
    items = value.replace(/^\[|\]$/g, '').split(/[,\s]+/)
  } else {
    const block = new RegExp(`^${key}[ \\t]*:[ \\t]*\\r?\\n((?:[ \\t]*-[^\\n]*\\n?)+)`, 'm').exec(raw)
    if (!block) return undefined
    items = block[1]!.split('\n').map((l) => l.replace(/^\s*-\s*/, ''))
  }
  return items.map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

const CLAUDE_TOOL_ALIASES: Record<string, string[]> = {
  Read: ['read_file', 'read_files'],
  Grep: ['search_files'],
  Glob: ['find_files'],
  LS: ['list_files'],
  Bash: ['run_command', 'job_output', 'job_stop', 'job_list'],
  Edit: ['apply_patch'],
  MultiEdit: ['apply_patch'],
  Write: ['write_file'],
}
/** Subagents never get these: no nesting beyond depth 1. */
const NESTING_TOOLS = new Set(['task', 'explore'])

/** The registry tools an agent may use, from its allowlist and denylist. */
export function agentToolNames(agent: Pick<AgentDef, 'tools' | 'disallowedTools'>, available: string[]): string[] {
  const expand = (names: string[]): Set<string> => new Set(names.flatMap((n) => CLAUDE_TOOL_ALIASES[n] ?? [n]))
  const allow = agent.tools ? expand(agent.tools) : undefined
  const deny = expand(agent.disallowedTools ?? [])
  return available.filter((n) => !NESTING_TOOLS.has(n) && (!allow || allow.has(n)) && !deny.has(n))
}
