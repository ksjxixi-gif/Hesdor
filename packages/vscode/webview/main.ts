import type { FromView, Item, ToView, ViewState } from '../src/view-model.js'

declare function acquireVsCodeApi(): { postMessage(message: FromView): void }

const vscode = acquireVsCodeApi()
const send = (m: FromView): void => vscode.postMessage(m)
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const log = $<HTMLElement>('log')
const plan = $<HTMLElement>('plan')
const optionsBox = $<HTMLElement>('options')
const input = $<HTMLTextAreaElement>('input')
const contextBox = $<HTMLElement>('context')
const sendButton = $<HTMLButtonElement>('send')
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

  // Rebuilding a dropdown while it is open would close it.
  if (!optionsBox.contains(document.activeElement)) optionsBox.replaceChildren(...s.options.flatMap(optionSelect))

  contextBox.replaceChildren()
  if (s.context.length > 0) {
    contextBox.append(el('span', 'chips', `Attached: ${s.context.join(', ')}`), button('Clear', () => send({ type: 'clearContext' })))
  }
  sendButton.disabled = s.busy
}

/** One agent setting (mode, model) as a labelled dropdown; groups are flattened. */
function optionSelect(o: ViewState['options'][number]): HTMLSelectElement[] {
  if (o.type !== 'select') return []
  const select = el('select', o.category ?? undefined)
  select.setAttribute('aria-label', o.name)
  select.title = o.description ?? o.name
  const choices = o.options.flatMap((c) => ('options' in c ? c.options : [c]))
  select.append(...choices.map((c) => Object.assign(el('option', undefined, c.name), { value: c.value, title: c.description ?? '' })))
  select.value = o.currentValue
  select.addEventListener('change', () => send({ type: 'setOption', configId: o.id, value: select.value }))
  return [select]
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
window.addEventListener('message', (e: MessageEvent<ToView>) => {
  if (e.data?.type !== 'state') return
  if (e.data.state.items.length === 0) open.clear() // a new session
  render(e.data.state)
})
send({ type: 'ready' })
