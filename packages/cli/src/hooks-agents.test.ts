import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandHooksPlugin, createDefaultRegistry, createTaskTool } from '@hesdor/agent-core'
import type { LoadedPlugin } from '@hesdor/agent-core'
import type { ChatMessage, ModelProvider, RunEvent, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { runTurn, systemPromptFor } from './run.js'
import { createSession } from './session.js'
import { fingerprint, projectCodeFiles } from './trust.js'

// Config reads in this file land in a throwaway profile.
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: Array<{ messages: ChatMessage[]; tools: string[] }> = []
  constructor(private readonly steps: StreamChunk[][]) {}
  async *stream(messages: ChatMessage[], tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push({ messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name) })
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    for (const chunk of step) yield chunk
  }
}
const call = (id: string, name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls' },
]
const answer = (text: string): StreamChunk[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop' }]

const root = mkdtempSync(path.join(tmpdir(), 'hesdor-ha-'))
writeFileSync(path.join(root, 'secret.txt'), 'top secret')
const script = path.join(root, 'hook.cjs')
// `node hook.cjs block` exits 2; `node hook.cjs marker <file>` writes a file and prints context.
writeFileSync(
  script,
  `const fs = require('node:fs')
let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  if (process.argv[2] === 'block') { process.stderr.write('hook says no: ' + JSON.parse(raw).hook_event_name); process.exit(2) }
  if (process.argv[2] === 'marker') { fs.writeFileSync(process.argv[3], raw); process.stdout.write('project uses tabs') }
})
`,
)
const hookPlugin = (event: string, matcher?: string): LoadedPlugin =>
  commandHooksPlugin({ [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `node "${script}" block` }] }] })!

function turn(provider: ModelProvider, opts: { plugins?: LoadedPlugin[]; mode?: 'build' | 'plan'; withTask?: boolean } = {}) {
  const registry = createDefaultRegistry()
  if (opts.withTask) {
    registry.register(
      createTaskTool([{ name: 'reader', description: 'reads files', tools: ['read_file', 'Bash'], prompt: 'You read files.', file: 'r.md' }], registry),
    )
  }
  const events: RunEvent[] = []
  const subEvents: RunEvent[] = []
  const result = runTurn({
    provider,
    registry,
    plugins: opts.plugins ?? [],
    systemPrompt: 'sys',
    prompt: 'go',
    root,
    mode: opts.mode ?? 'build',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    emitSubagent: (e) => subEvents.push(e),
    requestApproval: () => Promise.resolve(false),
    approvalsEnabled: false,
    state: { activeChild: null, snapshots: [], redo: [] },
  })
  return { result, events, subEvents }
}

describe('task agents and hooks in runTurn', () => {
  it('runs a task agent with its own prompt and only its allowlisted tools', async () => {
    const provider = new ScriptedProvider([
      call('p1', 'task', { agent: 'reader', prompt: 'what is in secret.txt?' }),
      call('s1', 'read_file', { path: 'secret.txt' }),
      answer('it says top secret'),
      answer('done'),
    ])
    const { result, subEvents } = turn(provider, { withTask: true })
    const r = await result
    expect(r.status).toBe('completed')
    const sub = provider.requests[1]!
    expect(sub.tools.sort()).toEqual(['job_list', 'job_output', 'job_stop', 'read_file', 'run_command'])
    expect(sub.messages[0]!.content).toMatch(/^You read files\./)
    expect(subEvents.some((e) => e.type === 'tool.completed' && e.name === 'read_file')).toBe(true)
    // The agent's answer is the task tool's result.
    expect(provider.requests[3]!.messages.at(-1)!.content).toMatch(/it says top secret/)
  })

  it('blocks a write-capable agent in plan mode', async () => {
    const provider = new ScriptedProvider([call('p1', 'task', { agent: 'reader', prompt: 'x' }), answer('ok')])
    const { result, events } = turn(provider, { withTask: true, mode: 'plan' })
    await result
    const failed = events.find((e) => e.type === 'tool.failed')
    expect(failed && 'error' in failed ? failed.error : '').toMatch(/requires risk level EXECUTE/)
    expect(provider.requests).toHaveLength(2)
  })

  it('applies command hooks inside subagents', async () => {
    const provider = new ScriptedProvider([
      call('p1', 'explore', { task: 'read the secret' }),
      call('s1', 'read_file', { path: 'secret.txt' }),
      answer('blocked'),
      answer('done'),
    ])
    const { result, subEvents } = turn(provider, { plugins: [hookPlugin('PreToolUse', 'read_file')] })
    await result
    const failed = subEvents.find((e) => e.type === 'tool.failed')
    expect(failed && 'error' in failed ? failed.error : '').toMatch(/hook says no: PreToolUse/)
    expect(provider.requests[2]!.messages.some((m) => m.content.includes('top secret'))).toBe(false)
  })

  it('a UserPromptSubmit exit 2 blocks the prompt before the model sees it', async () => {
    const provider = new ScriptedProvider([])
    const { result } = turn(provider, { plugins: [hookPlugin('UserPromptSubmit')] })
    const r = await result
    expect(r).toMatchObject({ status: 'failed', error: 'prompt blocked by a hook: hook says no: UserPromptSubmit' })
    expect(r.messages.filter((m) => m.role !== 'system')).toEqual([])
    expect(provider.requests).toHaveLength(0)
  })
})

describe('project hooks and agents in a session', () => {
  function repo(): { dir: string; marker: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-hrepo-'))
    const marker = path.join(dir, 'session-started.json')
    mkdirSync(path.join(dir, '.git'))
    mkdirSync(path.join(dir, '.hesdor'))
    mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(
      path.join(dir, '.hesdor', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${script}" marker "${marker}"` }] }] } }),
    )
    writeFileSync(path.join(dir, '.claude', 'agents', 'scout.md'), '---\nname: scout\ndescription: Finds files\ntools: Glob, Read\n---\nFind it.\n')
    return { dir, marker }
  }

  it('does not load project hooks from an untrusted repo, but loads its agents', async () => {
    const { dir, marker } = repo()
    expect(await projectCodeFiles(dir)).toContain(path.join(dir, '.hesdor', 'hooks.json'))
    const warnings: string[] = []
    const session = await createSession({ root: dir, warn: (m) => warnings.push(m) })
    session.dispose()
    expect(existsSync(marker)).toBe(false)
    expect(session.hookContext).toBeUndefined()
    expect(warnings.join('\n')).toMatch(/hooks .*not trusted/)
    expect(session.agents.map((a) => a.name)).toEqual(['scout'])
    expect(session.registry.get('task')).toBeDefined()
  })

  it('runs SessionStart hooks of a trusted repo and adds their output to the system prompt', async () => {
    const { dir, marker } = repo()
    const print = await fingerprint(dir, await projectCodeFiles(dir))
    const session = await createSession({ root: dir, trust: async (_f, p) => p === print })
    session.dispose()
    expect(existsSync(marker)).toBe(true)
    expect(systemPromptFor(session, 'build')).toMatch(/<hook-context>\nproject uses tabs\n<\/hook-context>$/)
  })
})

describe('agentProviderFor', () => {
  it('routes provider/model through that provider and plain ids to the current one', async () => {
    const { agentProviderFor } = await import('./run.js')
    const flags = { yes: false, debug: false, force: false, version: false, help: false, provider: 'openai', model: 'gpt-a' }
    const current = { providerId: 'openai', kind: 'openai-responses' as const, model: 'gpt-a', apiKey: 'sk-openai', keySource: 'environment' as const }
    const providerFor = agentProviderFor(flags, {}, current)
    // The session's openai key is never reused for another provider.
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    await expect(providerFor('anthropic/claude-x')).rejects.toThrow(/needs an API key/)
    process.env.ANTHROPIC_API_KEY = 'sk-ant'
    try {
      expect(await providerFor('anthropic/claude-x')).toMatchObject({ model: 'claude-x' })
      expect((await providerFor('anthropic/claude-x')).name).toMatch(/anthropic/)
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
    expect(await providerFor('openai/gpt-b')).toMatchObject({ model: 'gpt-b' })
    expect(await providerFor('vendor/model-c')).toMatchObject({ model: 'vendor/model-c' })
  })
})
