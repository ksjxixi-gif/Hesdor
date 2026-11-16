/**
 * A small markdown parser for agent answers: just the subset models write (fences, headings, lists, quotes,
 * rules, inline code, bold, italics, links). It returns plain data; the webview builds DOM nodes from it, never
 * HTML strings, so model output can't inject markup. An unclosed fence (mid-stream) runs to the end.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; text: string }
  | { t: 'em'; text: string }
  | { t: 'link'; text: string; href: string }

export type Block =
  | { t: 'code'; lang: string; text: string }
  | { t: 'heading'; level: number; inlines: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; inlines: Inline[] }
  | { t: 'rule' }
  | { t: 'para'; inlines: Inline[] }

const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of src.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', text: src.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: 'code', text: m[1] })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'strong', text: (m[2] ?? m[3])! })
    else if (m[4] !== undefined) out.push({ t: 'em', text: m[4] })
    else out.push({ t: 'link', text: m[5]!, href: m[6]! })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', text: src.slice(last) })
  return out
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push({ t: 'para', inlines: parseInline(para.join('\n')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i]!)
      blocks.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = LIST_ITEM.exec(line)
    if (!line.trim()) flush()
    else if (heading) {
      flush()
      blocks.push({ t: 'heading', level: heading[1]!.length, inlines: parseInline(heading[2]!) })
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ t: 'rule' })
    } else if (line.startsWith('>')) {
      flush()
      const quote = [line.replace(/^>\s?/, '')]
      while (lines[i + 1]?.startsWith('>')) quote.push(lines[++i]!.replace(/^>\s?/, ''))
      blocks.push({ t: 'quote', inlines: parseInline(quote.join('\n')) })
    } else if (item) {
      flush()
      // shortcut: nested lists flatten into one level; add depth if models' nested lists read badly.
      const ordered = item[2] !== undefined
      const items = [parseInline(item[3]!)]
      while (i + 1 < lines.length) {
        const next = LIST_ITEM.exec(lines[i + 1]!)
        if (!next || (next[2] !== undefined) !== ordered) break
        items.push(parseInline(next[3]!))
        i++
      }
      blocks.push({ t: 'list', ordered, items })
    } else para.push(line)
  }
  flush()
  return blocks
}
