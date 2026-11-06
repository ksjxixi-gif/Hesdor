import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createReadSkillTool,
  loadCommandsFrom,
  loadPluginsFrom,
  loadSkillsFrom,
  parseFrontmatter,
  skillCommand,
  skillDirs,
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
writeFileSync(path.join(cmdDir, 'folded.md'), '﻿---\r\ndescription: >\r\n  Long\r\n  description\r\n---\r\nDo it\r\n')

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
    // BOM, CRLF and a folded description (X7).
    expect(cmds.find((c) => c.name === 'folded')).toMatchObject({ description: 'Long description', template: 'Do it' })
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

  it('returns the skill directory and bundled files, and reads them only inside the skill', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'hesdor-bundle-'))
    const skillDir = path.join(base, 'pdf')
    mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
    mkdirSync(path.join(skillDir, 'references'), { recursive: true })
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: pdf\n---\nRun scripts/extract.py\n')
    writeFileSync(path.join(skillDir, 'scripts', 'extract.py'), 'print("hi")\n')
    writeFileSync(path.join(skillDir, 'references', 'guide.md'), '# Guide\n')
    writeFileSync(path.join(base, 'secret.txt'), 'nope')
    const tool = createReadSkillTool(await loadSkillsFrom([base]))

    const out = (await tool.execute({ name: 'pdf' }, {} as never)) as { dir: string; files: string[] }
    expect(out.dir).toBe(skillDir)
    expect(out.files).toEqual(['references/guide.md', 'scripts/extract.py'])

    const file = (await tool.execute({ name: 'pdf', file: 'references/guide.md' }, {} as never)) as { content: string }
    expect(file.content).toBe('# Guide\n')
    await expect(tool.execute({ name: 'pdf', file: '../secret.txt' }, {} as never)).rejects.toThrow(/outside the skill directory/)
    await expect(tool.execute({ name: 'pdf', file: path.join(base, 'secret.txt') }, {} as never)).rejects.toThrow(
      /outside the skill directory/,
    )
    await expect(tool.execute({ name: 'pdf', file: 'missing.md' }, {} as never)).rejects.toThrow(/no file/)
  })

  it('rejects unknown skills', async () => {
    const tool = createReadSkillTool(await loadSkillsFrom([skillProject]))
    await expect(tool.execute({ name: 'nope' }, {} as never)).rejects.toThrow(/unknown skill/)
  })
})

describe('parseFrontmatter', () => {
  it('handles a BOM, CRLF, quotes, comments and folded/literal block scalars', () => {
    const raw = [
      '﻿---',
      'name: "pdf-tools"',
      'description: >',
      '  Extract text',
      '  from PDFs.',
      '',
      '  Use for forms.',
      "license: 'it''s MIT' # note",
      'notes: |-',
      '  line one',
      '  line two',
      'plain: Use when: the user asks',
      '  about PDFs # trailing',
      'metadata:',
      '  author: x',
      '---',
      'Body',
      '',
    ].join('\r\n')
    const { meta, body } = parseFrontmatter(raw)
    expect(meta.name).toBe('pdf-tools')
    expect(meta.description).toBe('Extract text from PDFs.\nUse for forms.\n')
    expect(meta.license).toBe("it's MIT")
    expect(meta.notes).toBe('line one\nline two')
    expect(meta.plain).toBe('Use when: the user asks about PDFs')
    expect(meta.metadata).toBeUndefined()
    expect(meta.author).toBeUndefined()
    expect(body).toBe('Body\n')
  })

  it('leaves files without frontmatter alone', () => {
    expect(parseFrontmatter('# Title\n---\n')).toEqual({ meta: {}, body: '# Title\n---\n' })
    expect(parseFrontmatter('---\nname: x\n')).toEqual({ meta: {}, body: '---\nname: x\n' })
  })
})

describe('Agent Skills discovery', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-skillroot-'))
  const home = mkdtempSync(path.join(tmpdir(), 'hesdor-skillhome-'))
  const globalDir = path.join(home, 'hesdor-config')
  const skill = (base: string, name: string, front: string): void => {
    mkdirSync(path.join(base, name), { recursive: true })
    writeFileSync(path.join(base, name, 'SKILL.md'), `---\n${front}\n---\nSteps for ${name}\n`)
  }
  skill(path.join(root, '.agents', 'skills'), 'shared', 'name: shared\ndescription: project copy')
  skill(path.join(home, '.claude', 'skills'), 'shared', 'name: shared\ndescription: user copy')
  skill(path.join(root, '.claude', 'skills'), 'from-claude', 'name: from-claude\ndescription: >-\n  Folded\n  description')
  skill(path.join(globalDir, 'skills'), 'hesdor-global', 'description: global hesdor skill')
  skill(path.join(home, '.agents', 'skills'), 'Bad_Name', 'name: Bad--Name\ndescription: lenient')
  skill(path.join(root, '.hesdor', 'skills'), 'mismatch', 'name: other-name\ndescription: dir differs')

  it('scans .hesdor, .agents and .claude in project then user scope', async () => {
    const warnings: string[] = []
    const skills = await loadSkillsFrom(skillDirs(root, globalDir, home), (m) => warnings.push(m))
    expect(Object.fromEntries(skills.map((s) => [s.name, s.description]))).toEqual({
      'other-name': 'dir differs',
      shared: 'project copy',
      'from-claude': 'Folded description',
      'hesdor-global': 'global hesdor skill',
      'bad--name': 'lenient',
    })
    expect(warnings.join('\n')).toMatch(/"Bad--Name" is not a valid skill name/)
    expect(warnings.join('\n')).toMatch(/"other-name" does not match its directory "mismatch"/)
  })

  it('exposes skills as slash commands', () => {
    const cmd = skillCommand({ name: 'shared', description: 'd', path: 'x' })
    expect(cmd).toMatchObject({ name: 'shared', description: 'd' })
    expect(cmd.template).toContain('read_skill')
    expect(cmd.template).toContain('$ARGUMENTS')
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

  it('picks up an edited plugin on the next load (/reload)', async () => {
    const reloadDir = mkdtempSync(path.join(tmpdir(), 'hesdor-reload-'))
    const file = path.join(reloadDir, 'v.mjs')
    writeFileSync(file, 'export default { version: 1 }\n')
    const first = await loadPluginsFrom([reloadDir])
    writeFileSync(file, 'export default { version: 2 }\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000)) // guarantee a new mtime on coarse clocks
    const second = await loadPluginsFrom([reloadDir])
    expect((first.plugins[0]!.hooks as { version: number }).version).toBe(1)
    expect((second.plugins[0]!.hooks as { version: number }).version).toBe(2)
  })
})
