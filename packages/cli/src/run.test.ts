import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '@hesdor/agent-core'
import type { LoadedPlugin } from '@hesdor/agent-core'
import type { ChatMessage, ModelProvider, RunEvent, StreamChunk, ToolSpec } from '@hesdor/protocol'
import { addUsage, resolveWorkspaceRoot, runTurn } from './run.js'

// runTurn reads user permissions and writes turn checkpoints under the config dir.
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

/** Replays one chunk list per model call, recording the requests it saw. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []
  constructor(private readonly steps: Array<StreamChunk[] | Error>) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    if (step instanceof Error) throw step
    for (const chunk of step) yield chunk
  }
}

const call = (id: string, name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, ready: true } },
]
const answer = (text: string, tokens = 11): StreamChunk[] => [
  { type: 'text', text },
  { type: 'finish', reason: 'stop', usage: { inputTokens: tokens - 1, outputTokens: 1, totalTokens: tokens, ready: true } },
]

describe('resolveWorkspaceRoot', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'hesdor-ws-'))
  const home = path.join(base, 'home')
  const repo = path.join(home, 'repo')
  const plain = path.join(home, 'plain')
  mkdirSync(path.join(repo, '.git', 'x'), { recursive: true })
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(plain, { recursive: true })

  it('uses the enclosing repository', () => {
    expect(resolveWorkspaceRoot(path.join(repo, 'src'), false, home)).toEqual({ root: repo })
  })

  it('falls back to the current directory outside git, with a warning', () => {
    const ws = resolveWorkspaceRoot(plain, false, home)
    expect(ws).toMatchObject({ root: plain, warning: expect.stringMatching(/not inside a Git repository/) })
  })

  it('refuses the home directory and filesystem roots unless allowed', () => {
    expect(resolveWorkspaceRoot(home, false, home)).toMatchObject({ error: expect.stringMatching(/home directory/) })
    expect(resolveWorkspaceRoot(path.parse(base).root, false, home)).toHaveProperty('error')
    expect(resolveWorkspaceRoot(home, true, home)).toMatchObject({ root: home })
  })

  it('refuses a git repository rooted at the home directory (dotfiles repo)', () => {
    const dotHome = path.join(base, 'dothome')
    mkdirSync(path.join(dotHome, '.git'), { recursive: true })
    mkdirSync(path.join(dotHome, 'proj'), { recursive: true })
    expect(resolveWorkspaceRoot(path.join(dotHome, 'proj'), false, dotHome)).toMatchObject({ error: expect.stringMatching(/dotfiles/) })
    expect(resolveWorkspaceRoot(path.join(dotHome, 'proj'), true, dotHome)).toMatchObject({ root: dotHome })
  })
})

describe('runTurn', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-turn-'))
  writeFileSync(path.join(root, 'secret.txt'), 'top secret')

  function turn(provider: ModelProvider, plugins: LoadedPlugin[] = []) {
    const events: RunEvent[] = []
    const subEvents: RunEvent[] = []
    const result = runTurn({
      provider,
      registry: createDefaultRegistry(),
      plugins,
      systemPrompt: 'sys',
      prompt: 'go',
      root,
      mode: 'build',
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      emitSubagent: (e) => subEvents.push(e),
      requestApproval: () => Promise.resolve(false),
      approvalsEnabled: false,
      state: { activeChild: null, snapshots: [], redo: [] },
    })
    return { result, events, subEvents }
  }

  it('adds subagent usage to the turn and forwards its progress', async () => {
    const provider = new ScriptedProvider([
      call('p1', 'explore', { task: 'read the secret' }),
      call('s1', 'read_file', { path: 'secret.txt' }),
      answer('it says top secret', 21),
      answer('done', 31),
    ])
    const { result, subEvents, events } = turn(provider)
    const r = await result
    expect(r.status).toBe('completed')
    expect(r.text).toBe('done')
    expect(r.steps).toBe(2)
    // parent: 11 + 31, subagent: 11 + 21
    expect(r.usage?.totalTokens).toBe(74)
    expect(subEvents.map((e) => e.type)).toContain('tool.completed')
    expect(events.some((e) => e.type === 'tool.started' && e.name === 'read_file')).toBe(false)
  })

  it('applies plugin denies to subagent calls', async () => {
    const seen: string[] = []
    const plugin: LoadedPlugin = {
      name: 'guard',
      file: 'guard.js',
      hooks: {
        'tool.execute.before': async ({ tool }) => {
          seen.push(tool)
          return tool === 'read_file' ? { deny: 'no secrets' } : undefined
        },
      },
    }
    const provider = new ScriptedProvider([
      call('p1', 'explore', { task: 'read the secret' }),
      call('s1', 'read_file', { path: 'secret.txt' }),
      answer('blocked'),
      answer('done'),
    ])
    const { result, subEvents } = turn(provider, [plugin])
    await result
    expect(seen).toEqual(['explore', 'read_file'])
    const failed = subEvents.find((e) => e.type === 'tool.failed')
    expect(failed && 'error' in failed ? failed.error : '').toMatch(/blocked by plugin "guard"/)
    // The subagent's tool result never contained the file.
    expect(provider.requests[2]!.some((m) => m.content.includes('top secret'))).toBe(false)
  })

  it('reports the provider error class of a failed turn', async () => {
    const err = Object.assign(new Error('bad key'), { kind: 'auth' })
    const { result } = turn(new ScriptedProvider([err]))
    expect(await result).toMatchObject({ status: 'failed', errorKind: 'auth', text: '' })
  })
})

describe('addUsage', () => {
  it('sums fields and ignores missing usage', () => {
    expect(addUsage({ totalTokens: 1, ready: true }, { totalTokens: 2, cacheReadTokens: 1, ready: true })).toEqual({
      totalTokens: 3,
      cacheReadTokens: 1,
      ready: true,
    })
    expect(addUsage(undefined, { totalTokens: 2, ready: true })).toEqual({ totalTokens: 2, ready: true })
    expect(addUsage(undefined, undefined)).toBeUndefined()
  })
})

describe('outside a Git repository', () => {
  it('discovers the directory without git and git tools fail with a clear message', async () => {
    const { discoverRepo, runGit } = await import('@hesdor/agent-core')
    const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-nogit-'))
    const info = await discoverRepo(dir)
    expect(info).toMatchObject({ root: dir, git: false, branch: null })
    expect(info.statusLines[0]).toMatch(/not a Git repository/)
    await expect(runGit(['status'], dir)).rejects.toThrow(/not a Git repository/)
  })
})
