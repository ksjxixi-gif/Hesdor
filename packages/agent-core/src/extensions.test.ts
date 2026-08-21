import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createReadSkillTool,
  loadCommandsFrom,
  loadPluginsFrom,
  loadSkillsFrom,
  skillsSummary,
} from './index.js'

const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-ext-'))

// commands
const cmdDir = path.join(dir, 'commands')
mkdirSync(cmdDir, { recursive: true })
writeFileSync(
  path.join(cmdDir, 'review.md'),
  '---\ndescription: Review code changes\n---\nReview $ARGUMENTS for bugs.\n',
)
writeFileSync(path.join(cmdDir, 'deploy.md'), 'Deploy the app to $ARGUMENTS\n')

// skills (project + global with shadowing)
const skillProject = path.join(dir, 'skills-project')
mkdirSync(path.join(skillProject, 'release'), { recursive: true })
writeFileSync(
  path.join(skillProject, 'release', 'SKILL.md'),
  '---\ndescription: Cut a release safely\n---\n1. bump version\n2. tag\n',
)
const skillGlobal = path.join(dir, 'skills-global')
mkdirSync(path.join(skillGlobal, 'release'), { recursive: true })
mkdirSync(path.join(skillGlobal, 'typing'), { recursive: true })
writeFileSync(path.join(skillGlobal, 'typing', 'SKILL.md'), '# Typing workflow\nUse strict types everywhere.\n')

// plugins
const pluginDir = path.join(dir, 'plugins')
mkdirSync(pluginDir, { recursive: true })
writeFileSync(
  path.join(pluginDir, 'no-deny.mjs'),
  "export default {\n  event: () => {},\n  async 'tool.execute.before'() {},\n}\n",
)
writeFileSync(path.join(pluginDir, 'broken.mjs'), 'throw new Error("boom")\n')

describe('loadCommandsFrom', () => {
  it('parses frontmatter and templates', async () => {
    const cmds = await loadCommandsFrom([cmdDir])
    const names = cmds.map((c) => c.name)
    expect(names).toContain('review')
    expect(names).toContain('deploy')
    const review = cmds.find((c) => c.name === 'review')!
    expect(review.description).toBe('Review code changes')
    expect(review.template).toContain('$ARGUMENTS')
  })

  it('earlier dirs shadow later ones', async () => {
    const first = path.join(dir, 'cmd-first')
    const second = path.join(dir, 'cmd-second')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(path.join(first, 'greet.md'), 'FIRST')
    writeFileSync(path.join(second, 'greet.md'), 'SECOND')
    const cmds = await loadCommandsFrom([first, second])
    expect(cmds.find((c) => c.name === 'greet')?.template).toBe('FIRST')
  })
})

describe('loadSkillsFrom', () => {
  it('reads SKILL.md files and shadows by order', async () => {
    const skills = await loadSkillsFrom([skillProject, skillGlobal])
    expect(skills.map((s) => s.name).sort()).toEqual(['release', 'typing'])
    const release = skills.find((s) => s.name === 'release')!
    expect(release.description).toBe('Cut a release safely')
    expect(release.path).toContain(path.join('skills-project', 'release'))
  })

  it('falls back to the first heading as description', async () => {
    const skills = await loadSkillsFrom([skillGlobal])
    expect(skills.find((s) => s.name === 'typing')?.description).toBe('Typing workflow')
  })
})

describe('read_skill tool', () => {
  it('returns full instructions by name', async () => {
    const skills = await loadSkillsFrom([skillProject, skillGlobal])
    const tool = createReadSkillTool(skills)
    const out = (await tool.execute({ name: 'release' }, {} as never)) as { content: string }
    expect(out.content).toContain('bump version')
  })

  it('rejects unknown skills', async () => {
    const tool = createReadSkillTool(await loadSkillsFrom([skillProject]))
    await expect(tool.execute({ name: 'nope' }, {} as never)).rejects.toThrow(/unknown skill/)
  })
})

describe('skillsSummary', () => {
  it('is undefined without skills', () => {
    expect(skillsSummary([])).toBeUndefined()
  })

  it('lists names and descriptions', () => {
    const summary = skillsSummary([{ name: 'a', description: 'do a', path: 'x' }])
    expect(summary).toContain('- a: do a')
  })
})

describe('loadPluginsFrom', () => {
  it('loads good plugins and warns on broken ones', async () => {
    const { plugins, warnings } = await loadPluginsFrom([pluginDir])
    expect(plugins.map((p) => p.name)).toEqual(['no-deny'])
    expect(typeof plugins[0]!.hooks.event).toBe('function')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.file).toContain('broken.mjs')
  })
})
