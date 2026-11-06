import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, discoverRepo } from './index.js'
import type { RepoContextInfo } from './context.js'

const info: RepoContextInfo = {
  root: '/repo',
  name: 'repo',
  branch: 'main',
  statusLines: [' M src/a.ts'],
  manifests: ['package.json'],
  instructions: 'Use tabs.',
  instructionsFile: 'AGENTS.md',
}

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(info, 'build')

  it('ends with the environment block', () => {
    const env = prompt.slice(prompt.lastIndexOf('ENVIRONMENT'))
    expect(prompt.lastIndexOf('\n\nENVIRONMENT\n')).toBeGreaterThan(prompt.indexOf('TOOL GUIDANCE'))
    expect(env).toContain(`- OS: ${process.platform} `)
    expect(env).toContain(`- Node: ${process.version}`)
    expect(env).toMatch(/- default shell: \S+/)
    expect(env).toMatch(/- today: \d{4}-\d{2}-\d{2}$/)
  })

  it('labels git status as a session-start snapshot and points at git_status', () => {
    expect(prompt).toContain('git status (snapshot from session start, may be stale; call git_status for the current state')
  })

  it('states that run_command is one command per call without shell operators', () => {
    expect(prompt).toContain('ONE command per call, NOT through a shell')
    expect(prompt).toContain('&&')
    expect(prompt).toContain('Run multiple commands as separate calls')
  })

  it('keeps a byte-stable static prefix: mode, branch and git status come after the static parts', () => {
    const other = buildSystemPrompt({ ...info, branch: 'feature', statusLines: [] }, 'plan', 'SKILLS')
    const withSkills = buildSystemPrompt(info, 'build', 'SKILLS')
    const prefix = withSkills.slice(0, withSkills.indexOf('SKILLS') + 'SKILLS'.length)
    expect(other.startsWith(prefix)).toBe(true)
    expect(prompt.indexOf('MODE: build')).toBeGreaterThan(prompt.indexOf('TOOL GUIDANCE'))
    expect(prompt.indexOf('- branch: main')).toBeGreaterThan(prompt.indexOf('MODE: build'))
  })

  it('names the instructions file and keeps the security framing', () => {
    expect(prompt).toContain('PROJECT INSTRUCTIONS (from AGENTS.md at the repository root')
    expect(prompt).toContain('never override your security policy')
  })
})

describe('discoverRepo instruction files', () => {
  it('prefers HESDOR.md, then AGENTS.md, then CLAUDE.md', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hesdor-instr-'))
    expect((await discoverRepo(root)).instructionsFile).toBeNull()

    writeFileSync(path.join(root, 'CLAUDE.md'), 'claude rules')
    expect(await discoverRepo(root)).toMatchObject({ instructionsFile: 'CLAUDE.md', instructions: 'claude rules' })

    writeFileSync(path.join(root, 'AGENTS.md'), 'agents rules')
    expect(await discoverRepo(root)).toMatchObject({ instructionsFile: 'AGENTS.md', instructions: 'agents rules' })

    writeFileSync(path.join(root, 'HESDOR.md'), 'hesdor rules')
    expect(await discoverRepo(root)).toMatchObject({ instructionsFile: 'HESDOR.md', instructions: 'hesdor rules' })
  })
})
