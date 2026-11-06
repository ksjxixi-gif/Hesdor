import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@hesdor/protocol'
import { agentDirs, agentToolNames, loadAgentsFrom } from './agents.js'
import type { SubagentSpec, ToolContext } from './context.js'
import { createDefaultRegistry } from './registry.js'
import { createTaskTool } from './tools/task.js'

const base = mkdtempSync(path.join(tmpdir(), 'hesdor-agents-'))
const root = path.join(base, 'repo')
const globalDir = path.join(base, 'global')
const home = path.join(base, 'home')
const write = (dir: string, file: string, text: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, file), text)
}
write(path.join(root, '.hesdor', 'agents'), 'reviewer.md', '---\nname: reviewer\ndescription: Reviews diffs\ntools: read_file, search_files\nmodel: openai/gpt-x\n---\nYou review code.\n')
write(path.join(root, '.claude', 'agents'), 'tester.md', '---\nname: tester\ndescription: Runs tests\ntools:\n  - Read\n  - Bash\nmodel: sonnet\n---\nRun the tests.\n')
// Shadowed by the project reviewer.
write(path.join(globalDir, 'agents'), 'reviewer.md', '---\nname: reviewer\ndescription: global one\n---\nx\n')
write(path.join(globalDir, 'agents'), 'all.md', '---\ndescription: Everything but deletes\ndisallowedTools: delete_file\n---\nDo it.\n')
write(path.join(home, '.claude', 'agents'), 'broken.md', '---\nname: broken\n---\nno description\n')

describe('markdown agents', () => {
  it('parses agents from every dir, project first', async () => {
    const warnings: string[] = []
    const agents = await loadAgentsFrom(agentDirs(root, globalDir, home), (w) => warnings.push(w))
    expect(agents.map((a) => a.name)).toEqual(['reviewer', 'tester', 'all'])
    expect(agents[0]).toMatchObject({ description: 'Reviews diffs', tools: ['read_file', 'search_files'], model: 'openai/gpt-x', prompt: 'You review code.' })
    // YAML block list parsed; Claude model alias inherits the session model.
    expect(agents[1]).toMatchObject({ tools: ['Read', 'Bash'] })
    expect(agents[1]!.model).toBeUndefined()
    expect(agents[2]).toMatchObject({ disallowedTools: ['delete_file'] })
    expect(agents[2]!.tools).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/broken\.md: missing description/)
  })

  it('maps Claude Code tool names and never grants task or explore', () => {
    const all = createDefaultRegistry().list().map((t) => t.name).concat('task')
    expect(agentToolNames({ tools: ['Read', 'Bash', 'explore', 'task'] }, all)).toEqual([
      'read_file', 'read_files', 'run_command', 'job_output', 'job_stop', 'job_list',
    ])
    const everything = agentToolNames({ disallowedTools: ['delete_file'] }, all)
    expect(everything).toContain('write_file')
    expect(everything).not.toContain('delete_file')
    expect(everything).not.toContain('task')
    expect(everything).not.toContain('explore')
  })
})

describe('task tool', () => {
  const registry = createDefaultRegistry()
  const tool = createTaskTool(
    [
      { name: 'reader', description: 'reads', tools: ['read_file'], prompt: 'Read things.', file: 'r.md' },
      { name: 'fixer', description: 'fixes', tools: ['read_file', 'apply_patch'], model: 'm2', prompt: 'Fix things.', file: 'f.md' },
    ],
    registry,
  )
  registry.register(tool)

  function ctx(mode: ToolContext['mode']): { ctx: ToolContext; calls: SubagentSpec[] } {
    const calls: SubagentSpec[] = []
    const events: RunEvent[] = []
    return {
      calls,
      ctx: {
        root,
        mode,
        model: 'm',
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        requestApproval: async () => false,
        approvalsEnabled: false,
        state: { activeChild: null, snapshots: [], redo: [] },
        subagent: async (_task, _steps, agent) => {
          calls.push(agent!)
          return 'answer'
        },
      },
    }
  }

  it('runs a read-only agent in plan mode with its allowlist', async () => {
    const c = ctx('plan')
    expect(await tool.execute({ agent: 'reader', prompt: 'look' }, c.ctx)).toBe('answer')
    expect(c.calls[0]).toEqual({ name: 'reader', systemPrompt: 'Read things.', tools: ['read_file'] })
  })

  it('refuses an agent with write tools in plan mode, allows it in build mode', async () => {
    const plan = ctx('plan')
    await expect(tool.execute({ agent: 'fixer', prompt: 'fix' }, plan.ctx)).rejects.toThrow(/requires risk level WRITE/)
    expect(plan.calls).toHaveLength(0)
    const build = ctx('build')
    await tool.execute({ agent: 'fixer', prompt: 'fix' }, build.ctx)
    expect(build.calls[0]).toMatchObject({ tools: ['read_file', 'apply_patch'], model: 'm2' })
  })
})
