import type * as acp from '@agentclientprotocol/sdk'

/** A proposed file change: `oldText` null means a new file. */
export interface Diff {
  path: string
  oldText: string | null
  newText: string
}

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; status: acp.ToolCallStatus; output: string; diffs: Diff[] }
  | { kind: 'notice'; severity: string; text: string }
  | { kind: 'permission'; id: number; title: string; options: acp.PermissionOption[]; diffs: Diff[]; answer?: string }
  | { kind: 'error'; text: string; setup?: boolean }

/** Everything the webview renders; the extension host owns it and posts it whole. */
export interface ViewState {
  items: Item[]
  plan: acp.PlanEntry[]
  busy: boolean
  modes: acp.SessionMode[]
  mode?: string
  /** Labels of editor selections attached to the next prompt. */
  context: string[]
}

/** Webview → extension host. */
export type FromView =
  | { type: 'ready' }
  | { type: 'prompt'; text: string }
  | { type: 'cancel' }
  | { type: 'newSession' }
  | { type: 'setMode'; modeId: string }
  | { type: 'permission'; id: number; optionId: string | null }
  | { type: 'showDiff'; item: number; diff: number }
  | { type: 'clearContext' }
  | { type: 'setup' }

/** Extension host → webview. */
export type ToView = { type: 'state'; state: ViewState }

export const initialState = (): ViewState => ({ items: [], plan: [], busy: false, modes: [], context: [] })

const blockText = (block: acp.ContentBlock): string =>
  block.type === 'text' ? block.text : block.type === 'resource_link' ? `[${block.name}](${block.uri})` : ''

/** The diff entries of tool call content. */
export function diffsOf(content: acp.ToolCallContent[] | null | undefined): Diff[] {
  return (content ?? []).flatMap((c) => (c.type === 'diff' ? [{ path: c.path, oldText: c.oldText ?? null, newText: c.newText }] : []))
}

const outputOf = (content: acp.ToolCallContent[]): string =>
  content.flatMap((c) => (c.type === 'content' ? [blockText(c.content)] : [])).join('\n')

/** Append streamed text to the last item when it is of the same kind, else start a new one. */
function appendText(s: ViewState, kind: 'user' | 'agent' | 'thought', text: string): void {
  if (!text) return
  const last = s.items.at(-1)
  if (last?.kind === kind) last.text += text
  else s.items.push({ kind, text })
}

/** Applies one `session/update` to the view state (mutates it). */
export function applyUpdate(s: ViewState, u: acp.SessionUpdate): void {
  switch (u.sessionUpdate) {
    case 'user_message_chunk':
      return appendText(s, 'user', blockText(u.content))
    case 'agent_message_chunk':
      return appendText(s, 'agent', blockText(u.content))
    case 'agent_thought_chunk':
      return appendText(s, 'thought', blockText(u.content))
    case 'tool_call':
    case 'tool_call_update': {
      let tool = s.items.find((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool' && i.id === u.toolCallId)
      if (!tool) {
        tool = { kind: 'tool', id: u.toolCallId, title: u.title ?? 'Tool call', status: 'pending', output: '', diffs: [] }
        s.items.push(tool)
      }
      if (u.title) tool.title = u.title
      if (u.status) tool.status = u.status
      // ACP replaces a tool call's whole content list on each update.
      if (u.content) {
        tool.output = outputOf(u.content)
        tool.diffs = diffsOf(u.content)
      }
      return
    }
    case 'plan':
      s.plan = u.entries
      return
    case 'current_mode_update':
      s.mode = u.currentModeId
      return
    case 'notice':
      s.items.push({ kind: 'notice', severity: u.severity, text: u.description ? `${u.title}: ${u.description}` : u.title })
      return
    default:
      return
  }
}

/** Shows a permission request; the answer arrives later through answerPermission. */
export function addPermission(s: ViewState, id: number, req: acp.RequestPermissionRequest): void {
  s.items.push({ kind: 'permission', id, title: req.toolCall.title ?? 'Allow this action?', options: req.options, diffs: diffsOf(req.toolCall.content) })
}

/**
 * The response for a choice in the webview: a known option is selected; anything else (cancel, a stale
 * or forged id) cancels, which the agent treats as a refusal.
 */
export function permissionResponse(options: acp.PermissionOption[], optionId: string | null): acp.RequestPermissionResponse {
  return optionId !== null && options.some((o) => o.optionId === optionId)
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

/** Marks a permission item answered with the chosen option's name ("Cancelled" otherwise). */
export function answerPermission(s: ViewState, id: number, optionId: string | null): void {
  const item = s.items.find((i): i is Extract<Item, { kind: 'permission' }> => i.kind === 'permission' && i.id === id)
  if (item) item.answer = item.options.find((o) => o.optionId === optionId)?.name ?? 'Cancelled'
}
