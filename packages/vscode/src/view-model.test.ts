import { describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import { addPermission, answerPermission, applyUpdate, initialState, permissionResponse } from './view-model.js'

const text = (t: string): acp.ContentBlock => ({ type: 'text', text: t })

describe('applyUpdate', () => {
  it('joins streamed chunks per kind and starts a new item when the kind changes', () => {
    const s = initialState()
    applyUpdate(s, { sessionUpdate: 'agent_thought_chunk', content: text('plan ') })
    applyUpdate(s, { sessionUpdate: 'agent_thought_chunk', content: text('it') })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('Hello') })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text(' world') })
    expect(s.items).toEqual([
      { kind: 'thought', text: 'plan it' },
      { kind: 'agent', text: 'Hello world' },
    ])
  })

  it('tracks a tool call by id, replacing its content on each update', () => {
    const s = initialState()
    applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'in_progress' })
    applyUpdate(s, { sessionUpdate: 'agent_message_chunk', content: text('…') })
    applyUpdate(s, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' },
        { type: 'content', content: text('formatted') },
      ],
    })
    expect(s.items[0]).toEqual({
      kind: 'tool',
      id: 't1',
      title: 'Edit a.ts',
      status: 'completed',
      output: 'formatted',
      diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }],
    })
    // An update for a call never announced still shows up.
    applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' })
    expect(s.items.at(-1)).toMatchObject({ kind: 'tool', id: 't2', status: 'failed', title: 'Tool call' })
  })

  it('keeps the plan, mode and notices', () => {
    const s = initialState()
    applyUpdate(s, { sessionUpdate: 'plan', entries: [{ content: 'test', priority: 'medium', status: 'pending' }] })
    applyUpdate(s, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    applyUpdate(s, { sessionUpdate: 'notice', severity: 'warning', title: 'Hesdor', description: 'fallback' })
    expect(s.plan).toHaveLength(1)
    expect(s.mode).toBe('plan')
    expect(s.items).toEqual([{ kind: 'notice', severity: 'warning', text: 'Hesdor: fallback' }])
  })
})

describe('permissions', () => {
  const options: acp.PermissionOption[] = [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ]

  it('selects only an option the agent offered; anything else cancels', () => {
    expect(permissionResponse(options, 'allow_once')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(permissionResponse(options, 'allow_always')).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(permissionResponse(options, null)).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('shows the request with its diffs and records the answer', () => {
    const s = initialState()
    addPermission(s, 7, {
      sessionId: 's',
      options,
      toolCall: { toolCallId: 't', title: 'Edit a.ts', content: [{ type: 'diff', path: '/w/a.ts', oldText: null, newText: 'x' }] },
    })
    expect(s.items[0]).toMatchObject({ kind: 'permission', id: 7, title: 'Edit a.ts', diffs: [{ path: '/w/a.ts', oldText: null, newText: 'x' }] })
    answerPermission(s, 7, 'reject_once')
    expect(s.items[0]).toMatchObject({ answer: 'Reject' })
    answerPermission(s, 7, null)
    expect(s.items[0]).toMatchObject({ answer: 'Cancelled' })
  })
})
