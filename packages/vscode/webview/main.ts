import type { FromView, Item, ToView, ViewState } from '../src/view-model.js'
import { parseMarkdown, type Block, type Inline } from '../src/markdown.js'

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
const welcome = $<HTMLTemplateElement>('welcome')
/** <details> the user opened, by item index, so a re-render keeps them open. */
const open = new Set<number>()
let busy = false

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

function details(index: number, summary: Node[], body: Node[], cls: string): HTMLDetailsElement {
  const d = el('details', cls)
  d.open = open.has(index)
  d.addEventListener('toggle', () => (d.open ? open.add(index) : open.delete(index)))
  const s = el('summary')
  s.append(...summary)
  d.append(s, ...body)
  return d
}

const STATUS_LABEL: Record<string, string> = { pending: 'Pending', in_progress: 'Running', completed: 'Done', failed: 'Failed' }

/** A status dot drawn in CSS (spinner while running); the label is for screen readers. */
function statusIcon(status: string): HTMLElement {
  const icon = el('span', `status ${status}`)
  icon.setAttribute('role', 'img')
  icon.setAttribute('aria-label', STATUS_LABEL[status] ?? status)
  return icon
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p

function diffButtons(index: number, diffs: { path: string; oldText: string | null }[]): Node[] {
  return diffs.map((d, i) => {
    const b = button('', () => send({ type: 'showDiff', item: index, diff: i }), 'file')
    b.append(el('span', d.oldText === null ? 'badge add' : 'badge edit', d.oldText === null ? 'A' : 'M'), el('span', undefined, fileName(d.path)))
    b.title = `Show diff: ${d.path}`
    return b
  })
}

function inline(nodes: Inline[]): Node[] {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text':
        return document.createTextNode(n.text)
      case 'code':
        return el('code', undefined, n.text)
      case 'strong':
        return el('strong', undefined, n.text)
      case 'em':
        return el('em', undefined, n.text)
      case 'link': {
        const a = el('a', undefined, n.text)
        a.href = n.href
        a.title = n.href
        return a
      }
    }
  })
}

function codeBlock(lang: string, text: string): HTMLElement {
  const box = el('div', 'codeblock')
  const head = el('div', 'codehead')
  const copy = button('Copy', () => {
    void navigator.clipboard.writeText(text).then(() => {
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = 'Copy'), 1200)
    })
  }, 'ghost')
  copy.setAttribute('aria-label', `Copy ${lang || 'code'}`)
  head.append(el('span', 'lang', lang || 'text'), copy)
  const pre = el('pre')
  pre.append(el('code', undefined, text))
  box.append(head, pre)
  return box
}

function block(b: Block): Node {
  switch (b.t) {
    case 'code':
      return codeBlock(b.lang, b.text)
    case 'heading': {
      const h = el(`h${Math.min(b.level + 2, 6)}` as 'h3')
      h.append(...inline(b.inlines))
      return h
    }
    case 'list': {
      const list = el(b.ordered ? 'ol' : 'ul')
      for (const item of b.items) {
        const li = el('li')
        li.append(...inline(item))
        list.append(li)
      }
      return list
    }
    case 'quote': {
      const q = el('blockquote')
      q.append(...inline(b.inlines))
      return q
    }
    case 'rule':
      return el('hr')
    case 'para': {
      const p = el('p')
      p.append(...inline(b.inlines))
      return p
    }
  }
}

function renderItem(item: Item, index: number): Node {
  switch (item.kind) {
    case 'user':
      return el('div', 'msg user', item.text)
    case 'agent': {
      const box = el('div', 'msg agent')
      box.append(...parseMarkdown(item.text).map(block))
      return box
    }
    case 'thought':
      return details(index, [el('span', 'label', 'Thinking')], [el('pre', 'thought-text', item.text)], 'thought')
    case 'tool': {
      const body = item.output ? [el('pre', undefined, item.output)] : []
      const d = details(index, [statusIcon(item.status), el('span', 'label', item.title)], body, `tool ${item.status}${body.length ? '' : ' bare'}`)
      d.setAttribute('aria-label', `${item.title}: ${STATUS_LABEL[item.status] ?? item.status}`)
      if (!item.diffs.length) return d
      // Changed files stay in view under the row, one click from their diff.
      const files = el('div', 'files tool-files')
      files.append(...diffButtons(index, item.diffs))
      const box = el('div')
      box.append(d, files)
      return box
    }
    case 'notice':
      return el('div', `notice ${item.severity}`, item.text)
    case 'permission': {
      const box = el('div', `permission${item.answer ? ' answered' : ''}`)
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', item.title)
      box.append(el('div', 'kicker', item.answer ? 'Permission' : 'Permission needed'), el('div', 'title', item.title))
      if (item.diffs.length) {
        const files = el('div', 'files')
        files.append(...diffButtons(index, item.diffs))
        box.append(files)
      }
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
      if (item.setup) box.append(button('Run hesdor setup', () => send({ type: 'setup' }), 'primary'))
      // Same message: runSetup installs first when the CLI is missing.
      if (item.install) box.append(button('Install Hesdor', () => send({ type: 'setup' }), 'primary'))
      return box
    }
  }
}

function render(s: ViewState): void {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  busy = s.busy
  log.setAttribute('aria-busy', String(s.busy))
  log.replaceChildren(...s.items.map(renderItem))
  if (s.items.length === 0) log.append(welcome.content.cloneNode(true))
  else if (s.busy && s.items.at(-1)?.kind !== 'permission') {
    const w = el('div', 'working')
    w.append(el('span', 'pulse'), el('span', undefined, 'Working…'))
    log.append(w)
  }
  if (stick) log.scrollTop = log.scrollHeight

  plan.replaceChildren()
  if (s.plan.length > 0) {
    const done = s.plan.filter((e) => e.status === 'completed').length
    const list = el('ul')
    for (const e of s.plan) {
      const li = el('li', e.status)
      li.append(statusIcon(e.status), el('span', undefined, e.content))
      list.append(li)
    }
    const head = el('div', 'planhead')
    head.append(el('span', undefined, 'Plan'), el('span', 'count', `${done}/${s.plan.length}`))
    const bar = el('div', 'progress')
    bar.style.setProperty('--done', `${(done / s.plan.length) * 100}%`)
    plan.append(head, bar, list)
  }

  // Rebuilding a dropdown while it is open would close it.
  if (!optionsBox.contains(document.activeElement)) optionsBox.replaceChildren(...s.options.flatMap(optionSelect))

  contextBox.replaceChildren()
  if (s.context.length > 0) {
    for (const c of s.context) contextBox.append(el('span', 'chip', c))
    contextBox.append(button('Clear', () => send({ type: 'clearContext' }), 'ghost'))
  }
  sendButton.classList.toggle('stop', s.busy)
  sendButton.title = s.busy ? 'Stop' : 'Send (Enter)'
  sendButton.setAttribute('aria-label', s.busy ? 'Stop' : 'Send')
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
  if (!text.trim() || busy) return
  send({ type: 'prompt', text })
  input.value = ''
}

sendButton.addEventListener('click', () => (busy ? send({ type: 'cancel' }) : submit()))
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
})
// Starter prompts on the welcome screen fill the box; you edit and send them.
log.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-action="openSession"]')) return send({ type: 'openSession' })
  const prompt = (e.target as HTMLElement).closest<HTMLElement>('[data-prompt]')?.dataset.prompt
  if (!prompt) return
  input.value = prompt
  input.focus()
  input.setSelectionRange(prompt.length, prompt.length)
})
window.addEventListener('message', (e: MessageEvent<ToView>) => {
  if (e.data?.type !== 'state') return
  if (e.data.state.items.length === 0) open.clear() // a new session
  render(e.data.state)
})
send({ type: 'ready' })
