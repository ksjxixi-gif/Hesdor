import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelProvider, RunEvent, StreamChunk, ToolSpec } from '@hesdor/protocol'
import type { ToolContext } from './context.js'
import { commandHooksPlugin, hookMatches, loadHookConfig } from './hooks.js'
import type { HookConfig } from './hooks.js'
import { runAgentLoop } from './loop.js'
import type { LoadedPlugin } from './plugins.js'
import { createDefaultRegistry } from './registry.js'

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'fake-model'
  readonly requests: ChatMessage[][] = []
  constructor(private readonly steps: StreamChunk[][]) {}
  async *stream(messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(messages.map((m) => ({ ...m })))
    const step = this.steps.shift()
    if (!step) throw new Error('no scripted step left')
    for (const chunk of step) yield chunk
  }
}

const call = (name: string, args: object): StreamChunk[] => [
  { type: 'tool_call', index: 0, id: 'c1', name, argumentsDelta: JSON.stringify(args) },
  { type: 'finish', reason: 'tool_calls' },
]
const answer = (text: string): StreamChunk[] => [{ type: 'text', text }, { type: 'finish', reason: 'stop' }]

const dir = mkdtempSync(path.join(tmpdir(), 'hesdor-hooks-'))
writeFileSync(path.join(dir, 'a.txt'), 'alpha')
writeFileSync(path.join(dir, 'b.txt'), 'bravo')
const log = path.join(dir, 'log.jsonl')
// One hook script: `node hook.mjs <behavior>`; logs its stdin and acts on the behavior.
const script = path.join(dir, 'hook.mjs')
writeFileSync(
  script,
  `import { appendFileSync } from 'node:fs'
let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  const input = JSON.parse(raw)
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n')
  const out = (o) => process.stdout.write(JSON.stringify(o))
  const pre = (o) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } })
  switch (process.argv[2]) {
    case 'block': process.stderr.write('reading is forbidden here'); process.exit(2)
    case 'deny': pre({ permissionDecision: 'deny', permissionDecisionReason: 'policy says no' }); break
    case 'ask': pre({ permissionDecision: 'ask', permissionDecisionReason: 'check this one' }); break
    case 'allow': pre({ permissionDecision: 'allow' }); break
    case 'rewrite': pre({ permissionDecision: 'allow', updatedInput: { path: 'b.txt' } }); break
    case 'rewrite-bad': pre({ updatedInput: { path: 42 } }); break
    case 'context': out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'remember the style guide' } }); break
    case 'stop': if (!input.stop_hook_active) out({ decision: 'block', reason: 'run the tests first' }); break
    case 'fail': process.stderr.write('boom'); process.exit(1)
  }
})
`,
)
const hook = (behavior: string, event = 'PreToolUse', matcher?: string): LoadedPlugin =>
  commandHooksPlugin({
    [event]: [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', command: `node "${script}" ${behavior}` }] }],
  } as HookConfig)!

function ctx(opts: { approve?: boolean } = {}): { ctx: ToolContext; events: RunEvent[]; asked: string[] } {
  const events: RunEvent[] = []
  const asked: string[] = []
  return {
    events,
    asked,
    ctx: {
      root: dir,
      mode: 'build',
      model: 'fake-model',
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      requestApproval: async (req) => {
        asked.push(`${req.title} | ${req.detail ?? ''}`)
        return opts.approve ?? false
      },
      approvalsEnabled: true,
      state: { activeChild: null, snapshots: [], redo: [] },
    },
  }
}

async function readWith(plugins: LoadedPlugin[], opts: { approve?: boolean } = {}) {
  const provider = new ScriptedProvider([call('read_file', { path: 'a.txt' }), answer('done')])
  const c = ctx(opts)
  const result = await runAgentLoop({ provider, registry: createDefaultRegistry(), ctx: c.ctx, systemPrompt: 's', userPrompt: 'u', plugins })
  const toolResult = result.messages.find((m) => m.role === 'tool_result')!
  return { result, toolResult, ...c }
}

describe('command hooks', () => {
  it('exit 2 blocks the tool and feeds stderr to the model', async () => {
    const { toolResult, result } = await readWith([hook('block')])
    expect(result.status).toBe('completed')
    expect(toolResult.isError).toBe(true)
    expect(toolResult.content).toMatch(/blocked by hook: reading is forbidden here/)
    expect(toolResult.content).not.toMatch(/alpha/)
    const input = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)!)
    expect(input).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: { path: 'a.txt' }, tool_use_id: 'c1', cwd: dir, permission_mode: 'build' })
  })

  it('permissionDecision deny blocks, allow runs', async () => {
    expect((await readWith([hook('deny')])).toolResult.content).toMatch(/policy says no/)
    const allowed = await readWith([hook('allow')])
    expect(allowed.toolResult.isError).toBe(false)
    expect(allowed.toolResult.content).toMatch(/alpha/)
  })

  it('permissionDecision ask asks the user', async () => {
    const denied = await readWith([hook('ask')])
    expect(denied.asked[0]).toMatch(/hook asks you to approve read_file a\.txt \| check this one/)
    expect(denied.toolResult.content).toMatch(/denied: a hook asked for approval/)
    const approved = await readWith([hook('ask')], { approve: true })
    expect(approved.toolResult.content).toMatch(/alpha/)
  })

  it('updatedInput replaces the input and is re-validated against the schema', async () => {
    expect((await readWith([hook('rewrite')])).toolResult.content).toMatch(/bravo/)
    const bad = await readWith([hook('rewrite-bad')])
    expect(bad.toolResult.content).toMatch(/invalid hook-modified arguments for "read_file"/)
  })

  it('re-validates input rewritten by a JS plugin too (L17)', async () => {
    const plugin: LoadedPlugin = { name: 'p', file: 'p.js', hooks: { 'tool.execute.before': async () => ({ input: { path: [] } }) } }
    expect((await readWith([plugin])).toolResult.content).toMatch(/invalid hook-modified arguments/)
  })

  it('PostToolUse additionalContext reaches the model with the result', async () => {
    const { toolResult } = await readWith([hook('context', 'PostToolUse')])
    expect(toolResult.content).toMatch(/alpha/)
    expect(toolResult.content).toMatch(/<hook-context>\nremember the style guide\n<\/hook-context>/)
  })

  it('matchers select tools', async () => {
    const { toolResult } = await readWith([hook('block', 'PreToolUse', 'write_file|apply_patch')])
    expect(toolResult.content).toMatch(/alpha/)
    expect(hookMatches('read_file', 'read_file')).toBe(true)
    expect(hookMatches('Bash,read_file', 'read_file')).toBe(true)
    expect(hookMatches('read', 'read_file')).toBe(false)
    expect(hookMatches('^read_.*', 'read_files')).toBe(true)
    expect(hookMatches('*', 'x')).toBe(true)
    expect(hookMatches(undefined, 'x')).toBe(true)
  })

  it('a failing hook is a non-blocking notice', async () => {
    const { toolResult, events } = await readWith([hook('fail')])
    expect(toolResult.content).toMatch(/alpha/)
    expect(events).toContainEqual(expect.objectContaining({ type: 'hook.notice', event: 'PreToolUse', message: expect.stringMatching(/failed: boom/) }))
  })

  it('a Stop hook block continues the run once', async () => {
    const provider = new ScriptedProvider([answer('done'), answer('tests pass, done')])
    const c = ctx()
    const result = await runAgentLoop({
      provider,
      registry: createDefaultRegistry(),
      ctx: c.ctx,
      systemPrompt: 's',
      userPrompt: 'u',
      plugins: [hook('stop', 'Stop')],
    })
    expect(result.status).toBe('completed')
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]!.at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/run the tests first/) })
    const stops = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((i) => i.hook_event_name === 'Stop')
    expect(stops.slice(-2).map((s) => s.stop_hook_active)).toEqual([false, true])
    expect(stops.at(-1).last_assistant_message).toBe('tests pass, done')
  })

  it('loads Claude Code shaped files and warns about unsupported entries', async () => {
    const file = path.join(dir, 'hooks.json')
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node x.js', timeout: 5 }] }],
          Notification: [{ hooks: [{ type: 'command', command: 'x' }] }],
          Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
        },
      }),
    )
    const warnings: string[] = []
    const config = await loadHookConfig([file, path.join(dir, 'missing.json')], (w) => warnings.push(w))
    expect(config).toEqual({ PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node x.js', timeout: 5 }] }] })
    expect(warnings.join('\n')).toMatch(/unsupported event "Notification"/)
    expect(warnings.join('\n')).toMatch(/Stop has an invalid entry/)
  })
})
