#!/usr/bin/env node
// Converts captured ANSI terminal output into an SVG "terminal window" image. No dependencies.
//   node scripts/screens/ansi-to-svg.mjs <in.ans> <out.svg> [--cols 100] [--rows 30] [--title "hesdor"]
// Handles SGR colors (16, 256, truecolor), bold, dim, italic, underline and inverse; \r, \n, \t and
// backspace; line wrapping at --cols; wide (CJK, emoji) characters as two cells. Other escape
// sequences (cursor movement, OSC titles, alternate screen) are dropped.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const THEME = {
  bg: '#0f1115',
  fg: '#d4d8de',
  bar: '#191c22',
  border: '#2a2f38',
  title: '#8b93a1',
  // black red green yellow blue magenta cyan white, then the bright variants
  ansi: [
    '#1b1e24', '#ef6b6b', '#8cc97a', '#f0b44c', '#6aa7f0', '#c58ce6', '#5cc8c8', '#c9ced6',
    '#5c6370', '#ff8a80', '#a8e08f', '#ffd27a', '#8fc1ff', '#dcaaf5', '#7fe0e0', '#f3f5f7',
  ],
}

const CELL_W = 8.4 // 0.6em at 14px: the advance width of common monospace fonts
const LINE_H = 19
const FONT = 14
const PAD = 16
const BAR_H = 34

/** Terminal cell width of a code point: 0 for combining marks, 2 for wide CJK and emoji, else 1. */
export function charWidth(cp) {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  const wide = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
    [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
    [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
  ]
  return wide.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
}

function color256(n, theme) {
  if (n < 16) return theme.ansi[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return hex(v, v, v)
  }
  const i = n - 16
  const level = (x) => (x === 0 ? 0 : 55 + x * 40)
  return hex(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6))
}

const hex = (r, g, b) => `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`

/** Applies one SGR parameter list to a style; returns the new style. */
function applySgr(style, params, theme) {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)))
  let s = { ...style }
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === 0) s = {}
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 22) s.bold = s.dim = false
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 27) s.inverse = false
    else if (c >= 30 && c <= 37) s.fg = theme.ansi[c - 30]
    else if (c >= 90 && c <= 97) s.fg = theme.ansi[c - 90 + 8]
    else if (c >= 40 && c <= 47) s.bg = theme.ansi[c - 40]
    else if (c >= 100 && c <= 107) s.bg = theme.ansi[c - 100 + 8]
    else if (c === 39) delete s.fg
    else if (c === 49) delete s.bg
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg'
      if (p[i + 1] === 5) {
        s[key] = color256(p[i + 2] ?? 0, theme)
        i += 2
      } else if (p[i + 1] === 2) {
        s[key] = hex(p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0)
        i += 4
      }
    }
  }
  return s
}

/** Parses ANSI text into lines of cells { ch, w, style }. Wraps at `cols` like a terminal. */
export function parseAnsi(input, cols, theme = THEME) {
  const lines = [[]]
  let row = 0
  let col = 0
  let style = {}
  const text = input.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (window titles, links)
  const token = /\x1b\[([0-9;:?<>=]*)([@-~])|\x1b[()][0-9A-Za-z]|\x1b[@-_]|([\s\S])/gu
  const put = (ch, w) => {
    if (col + w > cols) newline()
    const line = lines[row]
    while (line.length < col) line.push({ ch: ' ', w: 1, style: {} })
    line[col] = { ch, w, style }
    if (w === 2) line[col + 1] = { ch: '', w: 0, style }
    col += w
  }
  const newline = () => {
    row++
    col = 0
    lines[row] ??= []
  }
  for (const m of text.matchAll(token)) {
    if (m[2] !== undefined) {
      if (m[2] === 'm' && !m[1].startsWith('?')) style = applySgr(style, m[1], theme)
      continue
    }
    const ch = m[3]
    if (ch === undefined) continue
    if (ch === '\n') newline()
    else if (ch === '\r') col = 0
    else if (ch === '\t') col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8)
    else if (ch === '\b') col = Math.max(0, col - 1)
    else if (ch.codePointAt(0) < 0x20 || ch === '\x7f') continue
    else {
      const w = charWidth(ch.codePointAt(0))
      if (w === 0) {
        const prev = lines[row][col - 1]
        if (prev) prev.ch += ch
      } else put(ch, w)
    }
  }
  return lines
}

export const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

const sameStyle = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Renders ANSI text as an SVG terminal window.
 * rows: fixed height; extra lines are cut from the top (as a terminal scrolls), missing ones padded.
 * Without rows, trailing blank lines are dropped and the height fits the content.
 */
export function ansiToSvg(input, { cols = 100, rows, title = 'hesdor', theme = THEME } = {}) {
  let lines = parseAnsi(input, cols, theme)
  if (rows === undefined) {
    while (lines.length > 1 && lines.at(-1).every((c) => c.ch.trim() === '' && !c.style.bg)) lines.pop()
    rows = lines.length
  }
  if (lines.length > rows) lines = lines.slice(lines.length - rows)
  const width = PAD * 2 + cols * CELL_W
  const height = BAR_H + PAD * 2 + rows * LINE_H
  const out = []
  lines.forEach((line, r) => {
    const y = BAR_H + PAD + r * LINE_H
    // Runs of narrow cells with one style; a wide character is a run of its own.
    let c = 0
    while (c < line.length) {
      const cell = line[c]
      if (!cell || cell.w === 0) {
        c++
        continue
      }
      let end = c + cell.w
      if (cell.w === 1) while (end < line.length && line[end]?.w === 1 && sameStyle(line[end].style, cell.style)) end++
      const s = cell.style
      const fg = s.inverse ? (s.bg ?? theme.bg) : (s.fg ?? theme.fg)
      const bg = s.inverse ? (s.fg ?? theme.fg) : s.bg
      const x = PAD + c * CELL_W
      if (bg) out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${((end - c) * CELL_W).toFixed(1)}" height="${LINE_H}" fill="${bg}"/>`)
      let str = line.slice(c, end).map((x) => x.ch).join('')
      if (!s.underline) str = str.replace(/\s+$/, '')
      const lead = str.length - str.trimStart().length
      str = str.trimStart()
      if (str !== '') {
        const attrs = [`x="${(x + lead * CELL_W).toFixed(1)}"`, `y="${y + 14}"`]
        if (fg !== theme.fg) attrs.push(`fill="${fg}"`)
        if (s.bold) attrs.push('font-weight="bold"')
        if (s.dim) attrs.push('fill-opacity="0.6"')
        if (s.italic) attrs.push('font-style="italic"')
        if (s.underline) attrs.push('text-decoration="underline"')
        // textLength pins every run to the cell grid whatever monospace font the viewer has.
        const cells = cell.w === 2 ? 2 : [...str].length
        attrs.push(`textLength="${(cells * CELL_W).toFixed(1)}"`, 'lengthAdjust="spacingAndGlyphs"')
        out.push(`<text ${attrs.join(' ')}>${escapeXml(str)}</text>`)
      }
      c = end
    }
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height}" viewBox="0 0 ${width.toFixed(1)} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;font-size:${FONT}px;white-space:pre}</style>`,
    `<rect x="0.5" y="0.5" width="${(width - 1).toFixed(1)}" height="${height - 1}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>`,
    `<path d="M0.5 ${BAR_H}V10.5a10 10 0 0 1 10-10H${(width - 10.5).toFixed(1)}a10 10 0 0 1 10 10V${BAR_H}Z" fill="${theme.bar}"/>`,
    `<line x1="0.5" y1="${BAR_H}" x2="${(width - 0.5).toFixed(1)}" y2="${BAR_H}" stroke="${theme.border}"/>`,
    `<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>`,
    `<text x="${(width / 2).toFixed(1)}" y="22" fill="${theme.title}" text-anchor="middle" style="font-size:13px">${escapeXml(title)}</text>`,
    `<g fill="${theme.fg}" xml:space="preserve">`,
    ...out,
    `</g>`,
    `</svg>`,
    '',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args.splice(i, 2)[1]
  }
  const cols = Number(opt('cols') ?? 100)
  const rowsArg = opt('rows')
  const title = opt('title') ?? 'hesdor'
  const [inFile, outFile] = args
  if (!inFile || !outFile) {
    console.error('usage: ansi-to-svg.mjs <in.ans> <out.svg> [--cols 100] [--rows 30] [--title "hesdor"]')
    process.exit(1)
  }
  writeFileSync(outFile, ansiToSvg(readFileSync(inFile, 'utf8'), { cols, rows: rowsArg ? Number(rowsArg) : undefined, title }))
}
