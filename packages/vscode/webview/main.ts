import type { FromView, Item, ToView, ViewState } from '../src/view-model.js'

declare function acquireVsCodeApi(): { postMessage(message: FromView): void }

const vscode = acquireVsCodeApi()
const send = (m: FromView): void => vscode.postMessage(m)
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const log = $<HTMLElement>('log')
const plan = $<HTMLElement>('plan')
const mode = $<HTMLSelectElement>('mode')
const input = $<HTMLTextAreaElement>('input')
const contextBox = $<HTMLElement>('context')
const sendButton = $<HTMLButtonElement>('send')
const cancelButton = $<HTMLButtonElement>('cancel')
/** <details> the user opened, by item index, so a re-render keeps them open. */
const open = new Set<number>()

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, onClick: () => void, cls = 'secondary'): HTMLButtonElement {
  const b = el('button', cls, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

function details(index: number, summary: string, body: Node[], cls: string): HTMLDetailsElement {
  const d = el('details', cls)
  d.open = open.has(index)
  d.addEventListener('toggle', () => (d.open ? open.add(index) : open.delete(index)))
  d.append(el('summary', undefined, summary), ...body)
  return d
}

const STATUS: Record<string, string> = { pending: '○', in_progress: '◐', completed: '✓', failed: '✗' }

function diffButtons(index: number, diffs: { path: string }[]): Node[] {
  return diffs.map((d, i) => button(`Show diff: ${d.path.split(/[\\/]/).pop()}`, () => send({ type: 'showDiff', item: index, diff: i })))
}

function renderItem(item: Item, index: number): Node {
  switch (item.kind) {
    case 'user':
      return el('div', 'msg user', item.text)
    case 'agent':
      return el('div', 'msg agent', item.text)
    case 'thought':
      return details(index, 'Thinking', [el('pre', undefined, item.text)], 'thought')
    case 'tool': {
      const body: Node[] = [...diffButtons(index, item.diffs)]
      if (item.output) body.push(el('pre', undefined, item.output))
      const d = details(index, `${STATUS[item.status] ?? ''} ${item.title}`, body, `tool ${item.status}`)
      d.setAttribute('aria-label', `${item.title}: ${item.status.replace('_', ' ')}`)
      return d
    }
    case 'notice':
      return el('div', `notice ${item.severity}`, item.text)
    case 'permission': {
      const box = el('div', 'permission')
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', item.title)
      box.append(el('div', 'title', item.title), ...diffButtons(index, item.diffs))
      if (item.answer) box.append(el('div', 'answer', item.answer))
      else {
        const row = el('div', 'choices')
        for (const o of item.options) {
          row.append(button(o.name, () => send({ type: 'permission', id: item.id, optionId: o.optionId }), o.kind.startsWith('allow') ? 'primary' : 'secondary'))
        }
        box.append(row)
      }
      return box
    }
    case 'error': {
      const box = el('div', 'error', item.text)
      box.setAttribute('role', 'alert')
      if (item.setup) box.append(button('Run hesdor setup', () => send({ type: 'setup' })))
      return box
    }
  }
}

function render(s: ViewState): void {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  log.setAttribute('aria-busy', String(s.busy))
  log.replaceChildren(...s.items.map(renderItem))
  if (s.items.length === 0) log.append(el('div', 'empty', 'Ask Hesdor to plan, explain or change code in this workspace.'))
  if (stick) log.scrollTop = log.scrollHeight

  plan.replaceChildren()
  if (s.plan.length > 0) {
    const list = el('ul')
    for (const e of s.plan) list.append(el('li', e.status, `${STATUS[e.status] ?? ''} ${e.content}`))
    plan.append(el('h2', undefined, 'Plan'), list)
  }

  if (document.activeElement !== mode) {
    mode.replaceChildren(...s.modes.map((m) => Object.assign(el('option', undefined, m.name), { value: m.id, title: m.description ?? '' })))
    if (s.mode) mode.value = s.mode
  }
  mode.disabled = s.modes.length === 0

  contextBox.replaceChildren()
  if (s.context.length > 0) {
    contextBox.append(el('span', 'chips', `Attached: ${s.context.join(', ')}`), button('Clear', () => send({ type: 'clearContext' })))
  }
  sendButton.disabled = s.busy
  cancelButton.disabled = !s.busy
}

function submit(): void {
  const text = input.value
  if (!text.trim() || sendButton.disabled) return
  send({ type: 'prompt', text })
  input.value = ''
}

sendButton.addEventListener('click', submit)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
})
cancelButton.addEventListener('click', () => send({ type: 'cancel' }))
$<HTMLButtonElement>('new').addEventListener('click', () => {
  open.clear()
  send({ type: 'newSession' })
})
mode.addEventListener('change', () => send({ type: 'setMode', modeId: mode.value }))
window.addEventListener('message', (e: MessageEvent<ToView>) => {
  if (e.data?.type === 'state') render(e.data.state)
})
send({ type: 'ready' })
