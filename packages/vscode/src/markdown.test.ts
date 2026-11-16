import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown.js'

describe('markdown', () => {
  it('parses inline code, bold, italics and http links; leaves the rest as text', () => {
    expect(parseInline('Run `npm test`, **then** *check* [docs](https://x.dev/a) or [bad](javascript:alert(1)) a*b')).toEqual([
      { t: 'text', text: 'Run ' },
      { t: 'code', text: 'npm test' },
      { t: 'text', text: ', ' },
      { t: 'strong', text: 'then' },
      { t: 'text', text: ' ' },
      { t: 'em', text: 'check' },
      { t: 'text', text: ' ' },
      { t: 'link', text: 'docs', href: 'https://x.dev/a' },
      { t: 'text', text: ' or [bad](javascript:alert(1)) a*b' },
    ])
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('parses blocks: headings, lists, fences, quotes, rules, paragraphs', () => {
    const md = ['## Plan', '', '1. one', '2. two', '- a', '', '```ts', 'const x = 1', '```', '> note', '---', 'line one', 'line two'].join('\n')
    expect(parseMarkdown(md)).toEqual([
      { t: 'heading', level: 2, inlines: [{ t: 'text', text: 'Plan' }] },
      { t: 'list', ordered: true, items: [[{ t: 'text', text: 'one' }], [{ t: 'text', text: 'two' }]] },
      { t: 'list', ordered: false, items: [[{ t: 'text', text: 'a' }]] },
      { t: 'code', lang: 'ts', text: 'const x = 1' },
      { t: 'quote', inlines: [{ t: 'text', text: 'note' }] },
      { t: 'rule' },
      { t: 'para', inlines: [{ t: 'text', text: 'line one\nline two' }] },
    ])
  })

  it('runs an unclosed fence (a streaming answer) to the end', () => {
    expect(parseMarkdown('Here:\n```py\nprint(1)\n')).toEqual([
      { t: 'para', inlines: [{ t: 'text', text: 'Here:' }] },
      { t: 'code', lang: 'py', text: 'print(1)\n' },
    ])
  })
})
