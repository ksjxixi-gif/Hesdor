export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
}

/**
 * Minimal unified-diff renderer (LCS based, no dependencies).
 * Produces colored-line input for the DiffReview modal.
 */
export function unifiedDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  // Drop a single trailing empty line caused by final newlines.
  if (a.length > 1 && a[a.length - 1] === '') a.pop()
  if (b.length > 1 && b[b.length - 1] === '') b.pop()

  // LCS table (files are capped upstream; fine for review-sized diffs).
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  // Walk the LCS producing raw op lines.
  type Op = { kind: 'add' | 'del' | 'ctx'; text: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i]! })
    i++
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j]! })
    j++
  }

  // Collapse to hunks with `context` lines around changes.
  const changed = ops.map((op) => op.kind !== 'ctx')
  const keep = Array.from({ length: ops.length }, () => false)
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true
  }

  const out: DiffLine[] = []
  let inHunk = false
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      if (inHunk) {
        out.push({ kind: 'meta', text: '· · ·' })
        inHunk = false
      }
      continue
    }
    inHunk = true
    const op = ops[k]!
    out.push({ kind: op.kind, text: op.text })
  }
  return out
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

const MAX_DIFF_LINES = 400

/** Cap giant diffs so the modal stays renderable. */
export function capDiff(lines: DiffLine[]): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= MAX_DIFF_LINES) return { lines, truncated: false }
  return { lines: lines.slice(0, MAX_DIFF_LINES), truncated: true }
}
