export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
  /** 1-based line number in the old file (del, ctx). */
  oldNo?: number
  /** 1-based line number in the new file (add, ctx). */
  newNo?: number
}

/** More edits than this in the changed middle (or too much work, see MAX_DIFF_WORK) shows it as one replaced block. */
export const MAX_DIFF_EDITS = 2000
const MAX_DIFF_WORK = 50_000_000

function splitLines(text: string): string[] {
  const lines = text === '' ? [] : text.split('\n')
  // Drop a single trailing empty line caused by a final newline.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Unified diff with @@ hunk headers and line numbers (no dependencies). The common prefix and
 * suffix are trimmed first and the middle is diffed with Myers' O((n+m)·D) algorithm; a middle
 * with too many edits becomes one "replaced" block instead of freezing the UI.
 */
export function unifiedDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const ops: DiffLine[] = []
  const ctx = (i: number, j: number): void => {
    ops.push({ kind: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 })
  }
  const del = (i: number): void => {
    ops.push({ kind: 'del', text: a[i]!, oldNo: i + 1 })
  }
  const add = (j: number): void => {
    ops.push({ kind: 'add', text: b[j]!, newNo: j + 1 })
  }
  for (let k = 0; k < pre; k++) ctx(k, k)

  const aEnd = a.length - suf
  const bEnd = b.length - suf
  const middle = myers(a.slice(pre, aEnd), b.slice(pre, bEnd))
  if (middle) {
    let i = pre
    let j = pre
    for (const op of middle) {
      if (op === 0) ctx(i++, j++)
      else if (op === 1) del(i++)
      else add(j++)
    }
  } else {
    ops.push({ kind: 'meta', text: `lines ${pre + 1}-${aEnd} replaced (too large to diff line by line)` })
    for (let i = pre; i < aEnd; i++) del(i)
    for (let j = pre; j < bEnd; j++) add(j)
  }
  for (let k = 0; k < suf; k++) ctx(aEnd + k, bEnd + k)

  // Keep `context` lines around changes and start each hunk with an @@ header.
  const keep = new Uint8Array(ops.length)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.kind === 'ctx') continue
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = 1
  }
  const out: DiffLine[] = []
  let oldSeen = 0
  let newSeen = 0
  for (let k = 0; k < ops.length; ) {
    if (!keep[k]) {
      const op = ops[k++]!
      if (op.oldNo !== undefined) oldSeen++
      if (op.newNo !== undefined) newSeen++
      continue
    }
    let end = k
    while (end < ops.length && keep[end]) end++
    const hunk = ops.slice(k, end)
    const oldLen = hunk.filter((l) => l.oldNo !== undefined).length
    const newLen = hunk.filter((l) => l.newNo !== undefined).length
    out.push({ kind: 'meta', text: `@@ -${oldSeen + (oldLen > 0 ? 1 : 0)},${oldLen} +${newSeen + (newLen > 0 ? 1 : 0)},${newLen} @@` })
    out.push(...hunk)
    oldSeen += oldLen
    newSeen += newLen
    k = end
  }
  return out
}

/**
 * Myers' greedy diff: 0 keep, 1 delete (a), 2 insert (b), in order. null when the edit
 * distance exceeds the caps. Memory is O(D²), time O((n+m)·D).
 */
function myers(a: string[], b: string[]): Array<0 | 1 | 2> | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const maxD = Math.min(max, MAX_DIFF_EDITS, Math.floor(MAX_DIFF_WORK / Math.max(1, max)))
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d][k + d]: furthest x on diagonal k after d edits.
  const trace: Int32Array[] = []
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1))
        return backtrack(trace, n, m)
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): Array<0 | 1 | 2> {
  const ops: Array<0 | 1 | 2> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!
    const at = (k: number): number => prev[k + d - 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(0)
      x--
      y--
    }
    ops.push(prevK === k + 1 ? 2 : 1)
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push(0)
    x--
    y--
  }
  return ops.reverse()
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * Text of a diff line for the terminal: CR dropped, and on changed lines tabs shown as `→`
 * and trailing spaces as `·`, so whitespace-only edits are visible.
 */
export function showWhitespace(text: string, changed: boolean): string {
  const line = text.replace(/\r$/, '')
  if (!changed) return line.replace(/\t/g, '    ')
  const body = line.replace(/[ \t]+$/, '')
  const trail = line.slice(body.length).replace(/ /g, '·')
  return (body + trail).replace(/\t/g, '→   ')
}
