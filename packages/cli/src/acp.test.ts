import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import type { ChatMessage, ModelProvider, StreamChunk, ToolSpec } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import { createAcpAgent, promptText } from './acp.js'
import type { Roles } from './roles.js'

// Sessions and config land in a throwaway profile (own worker per test file).
process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))

/** Replays one chunk list per model call; a 'hang' step waits until the run is cancelled. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []
  constructor(private readonly steps: Array<StreamChunk[] | 'hang'>) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    if (step === 'hang') {
      yield { type: 'text', text: 'thinking about it' }
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return
    }
    for (const chunk of step) yield chunk
  }
}

const call = (id: string, name: string, args: object): StreamChunk[] => [
  { type: 'reasoning', text: 'I should write the file' },
  { type: 'text', text: 'Writing it now.' },
  { type: 'tool_call', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls' },
]
const answer = (text: string): StreamChunk[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop' }]

const flags: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }

/** Connects a test client to the agent in-process and runs `op` against it. */
async function withClient<T>(
  provider: ModelProvider,
  permission: (req: acp.RequestPermissionRequest) => acp.RequestPermissionResponse,
  op: (ctx: acp.ClientContext, updates: acp.SessionUpdate[], permissions: acp.RequestPermissionRequest[]) => Promise<T>,
  roles?: Roles,
): Promise<T> {
  const updates: acp.SessionUpdate[] = []
  const permissions: acp.RequestPermissionRequest[] = []
  const client = acp
    .client()
    .onNotification('session/update', ({ params }) => {
      updates.push(params.update)
    })
    .onRequest('session/request_permission', ({ params }) => {
      permissions.push(params)
      return permission(params)
    })
  return client.connectWith(createAcpAgent(flags, { provider, ...(roles ? { roles } : {}) }), async (ctx) => {
    const init = await ctx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION)
    return op(ctx, updates, permissions)
  })
}

const pick = (optionId: string) => (): acp.RequestPermissionResponse => ({ outcome: { outcome: 'selected', optionId } })

describe('hesdor acp', () => {
  it('advertises capabilities, modes and a setup auth method', async () => {
    const res = await acp.client().connectWith(createAcpAgent(flags, { provider: new ScriptedProvider([]) }), async (ctx) => {
      const init = await ctx.request('initialize', { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } })
      const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
      const session = await ctx.request('session/new', { cwd, mcpServers: [] })
      return { init, session }
    })
    expect(res.init.agentCapabilities?.loadSession).toBe(true)
    expect(res.init.authMethods?.map((m) => m.id)).toEqual(['hesdor-setup', 'hesdor-setup-terminal'])
    expect(res.init.authMethods?.[1]).toMatchObject({ type: 'terminal', args: ['setup'] })
    expect(res.session.modes?.currentModeId).toBe('build')
    expect(res.session.configOptions?.[0]).toMatchObject({ id: 'mode', category: 'mode', currentValue: 'build' })
  })

  it('streams text, reasoning and a tool call with a diff the client approves', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
    const provider = new ScriptedProvider([call('c1', 'write_file', { path: 'a.txt', content: 'hello\n' }), answer('done')])
    const { stop, updates, permissions } = await withClient(provider, pick('allow_once'), async (ctx, updates, permissions) => {
      const { sessionId } = await ctx.request('session/new', { cwd, mcpServers: [] })
      const stop = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write a.txt' }] })
      return { stop, updates, permissions }
    })
    expect(stop.stopReason).toBe('end_turn')
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('hello\n')
    const kinds = updates.map((u) => u.sessionUpdate)
    expect(kinds[0]).toBe('notice') // not a git repo: setup warning surfaces once the session exists
    expect(kinds).toContain('agent_thought_chunk')
    expect(kinds).toContain('agent_message_chunk')
    expect(updates.find((u) => u.sessionUpdate === 'tool_call')).toMatchObject({ toolCallId: 'c1', kind: 'edit', status: 'in_progress' })
    expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'diff', path: path.join(cwd, 'a.txt'), oldText: null, newText: 'hello\n' }],
    })
    expect(permissions).toHaveLength(1)
    expect(permissions[0]!.toolCall).toMatchObject({ toolCallId: 'c1', content: [{ type: 'diff' }] })
    expect(permissions[0]!.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once'])
  })

  it('does not write when the client rejects the change', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
    const provider = new ScriptedProvider([call('c1', 'write_file', { path: 'b.txt', content: 'x' }), answer('ok')])
    const updates = await withClient(provider, pick('reject_once'), async (ctx, updates) => {
      const { sessionId } = await ctx.request('session/new', { cwd, mcpServers: [] })
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write b.txt' }] })
      return updates
    })
    expect(existsSync(path.join(cwd, 'b.txt'))).toBe(false)
    expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({ toolCallId: 'c1', status: 'failed' })
  })

  it('session/cancel stops a running prompt with stopReason cancelled', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
    const stop = await withClient(new ScriptedProvider(['hang']), pick('allow_once'), async (ctx, updates) => {
      const { sessionId } = await ctx.request('session/new', { cwd, mcpServers: [] })
      const pending = ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })
      while (updates.length === 0) await new Promise((r) => setTimeout(r, 5))
      await ctx.notify('session/cancel', { sessionId })
      return pending
    })
    expect(stop.stopReason).toBe('cancelled')
  })

  it('switches modes via set_mode and set_config_option, and loads a saved session', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
    const provider = new ScriptedProvider([answer('first answer')])
    await withClient(provider, pick('allow_once'), async (ctx, updates) => {
      const { sessionId } = await ctx.request('session/new', { cwd, mcpServers: [] })
      const set = await ctx.request('session/set_config_option', { sessionId, configId: 'mode', value: 'ask' })
      expect(set.configOptions[0]).toMatchObject({ currentValue: 'ask' })
      await ctx.request('session/set_mode', { sessionId, modeId: 'plan' })
      await expect(ctx.request('session/set_mode', { sessionId, modeId: 'yolo' })).rejects.toThrow()
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi there' }] })
      expect(provider.requests[0]![0]!.content).toContain('MODE: plan.')

      updates.length = 0
      const loaded = await ctx.request('session/load', { sessionId, cwd, mcpServers: [] })
      expect(loaded?.modes?.currentModeId).toBe('build')
      expect(updates).toEqual([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi there' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first answer' } },
      ])
    })
  })

  it('falls back via the session roles and sends todos as a plan and switches as notices', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hesdor-acp-'))
    const down: ModelProvider = {
      name: 'down',
      model: 'm1',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw Object.assign(new Error('overloaded'), { kind: 'overloaded', retryable: false })
      },
    }
    const backup = new ScriptedProvider([
      [
        { type: 'tool_call', index: 0, id: 't1', name: 'todo_write', argumentsDelta: JSON.stringify({ todos: [{ content: 'fix bug', status: 'in_progress' }, { content: 'test', status: 'done' }] }) },
        { type: 'finish', reason: 'tool_calls' },
      ],
      answer('done'),
    ])
    const roles: Roles = { fallback: [backup], status: [], warnings: [] }
    const { stop, updates } = await withClient(
      down,
      pick('allow_once'),
      async (ctx, updates) => {
        const { sessionId } = await ctx.request('session/new', { cwd, mcpServers: [] })
        const stop = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })
        return { stop, updates }
      },
      roles,
    )
    expect(stop.stopReason).toBe('end_turn')
    expect(updates.find((u) => u.sessionUpdate === 'notice' && /down\/m1 unavailable \(overloaded\): scripted\/fake-model/.test(u.description ?? ''))).toBeTruthy()
    expect(updates.find((u) => u.sessionUpdate === 'plan')).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'fix bug', priority: 'medium', status: 'in_progress' },
        { content: 'test', priority: 'medium', status: 'completed' },
      ],
    })
  })

  it('flattens prompt blocks', () => {
    expect(
      promptText([
        { type: 'text', text: 'see' },
        { type: 'resource', resource: { uri: 'file:///x.ts', text: 'code' } },
      ]),
    ).toBe('see\n<context uri="file:///x.ts">\ncode\n</context>')
  })
})
