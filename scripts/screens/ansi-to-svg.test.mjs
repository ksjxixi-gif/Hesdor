// node --test scripts/screens   (not part of `pnpm test`, which only runs packages/*/src)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ansiToSvg, charWidth, parseAnsi } from './ansi-to-svg.mjs'

test('16, 256 and truecolor foregrounds, bold and reset', () => {
  const [line] = parseAnsi('\x1b[1;31mA\x1b[0m\x1b[38;5;196mB\x1b[38;2;1;2;3mC\x1b[39mD', 80)
  assert.equal(line[0].style.bold, true)
  assert.equal(line[0].style.fg, '#ef6b6b')
  assert.equal(line[1].style.fg, '#ff0000')
  assert.equal(line[2].style.fg, '#010203')
  assert.equal(line[3].style.fg, undefined)
})

test('wraps at cols, handles \\r and tabs, drops cursor sequences', () => {
  const lines = parseAnsi('abcdef\x1b[2K\x1b[?25l\rX\tY', 4)
  assert.deepEqual(lines.map((l) => l.map((c) => c.ch).join('')), ['abcd', 'Xf Y'])
  const tab = parseAnsi('a\tb', 20)[0]
  assert.equal(tab[8].ch, 'b')
})

test('wide characters take two cells', () => {
  assert.equal(charWidth('中'.codePointAt(0)), 2)
  assert.equal(charWidth('●'.codePointAt(0)), 1)
  const [line] = parseAnsi('中a', 10)
  assert.equal(line[2].ch, 'a')
})

test('escapes XML and sizes the window', () => {
  const svg = ansiToSvg('<a & "b">', { cols: 20, rows: 2, title: 'x&y' })
  assert.match(svg, /&lt;a &amp; &quot;b&quot;&gt;/)
  assert.match(svg, /aria-label="x&amp;y"/)
  assert.doesNotMatch(svg, /<a /)
  assert.match(svg, /height="104"/) // 34 bar + 2*16 padding + 2*19 rows
})

test('rows keeps the last lines, like a scrolled terminal', () => {
  const svg = ansiToSvg('one\ntwo\nthree', { cols: 10, rows: 2 })
  assert.doesNotMatch(svg, />one</)
  assert.match(svg, />three</)
})
