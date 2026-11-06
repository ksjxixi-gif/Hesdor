import { describe, expect, it } from 'vitest'
import { MAX_DIFF_EDITS, showWhitespace, unifiedDiff } from './diff.js'

const file = (lines: number): string => Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n'

describe('unifiedDiff performance (G8 budget)', () => {
  it('diffs a 2k-line file with one edit', () => {
    const before = file(2000)
    const out = unifiedDiff(before, before.replace('line 1000\n', 'line 1000 edited\n'))
    expect(out.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['line 1000 edited'])
  })

  it('diffs a 20k-line file with a few edits within 1 s', () => {
    const before = file(20_000)
    const after = before.replace('line 7\n', 'line 7 edited\n').replace('line 15000\n', 'line 15000 edited\n')
    const t = performance.now()
    const out = unifiedDiff(before, after)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(out.filter((l) => l.kind === 'add')).toHaveLength(2)
  })

  it('falls back to a replaced block when the changed middle has too many edits', () => {
    const n = MAX_DIFF_EDITS / 2 + 10
    const before = Array.from({ length: n }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: n }, (_, i) => `b${i}`).join('\n')
    const t = performance.now()
    const out = unifiedDiff(`head\n${before}\ntail\n`, `head\n${after}\ntail\n`)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(out.some((l) => l.kind === 'meta' && l.text === `lines 2-${n + 1} replaced (too large to diff line by line)`)).toBe(true)
    expect(out.filter((l) => l.kind === 'del')).toHaveLength(n)
    expect(out.filter((l) => l.kind === 'add')).toHaveLength(n)
  })
})

describe('unifiedDiff hunks', () => {
  it('numbers lines and starts each hunk with an @@ header', () => {
    const out = unifiedDiff(file(20), file(20).replace('line 2\n', 'line 2x\n').replace('line 15\n', ''))
    expect(out.filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual(['@@ -1,6 +1,6 @@', '@@ -13,7 +13,6 @@'])
    expect(out.find((l) => l.kind === 'del' && l.text === 'line 2')).toMatchObject({ oldNo: 3 })
    expect(out.find((l) => l.kind === 'add')).toMatchObject({ text: 'line 2x', newNo: 3 })
    expect(out.find((l) => l.kind === 'del' && l.text === 'line 15')).toMatchObject({ oldNo: 16 })
  })

  it('handles new and emptied files', () => {
    expect(unifiedDiff('', 'a\nb\n')).toEqual([
      { kind: 'meta', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', text: 'a', newNo: 1 },
      { kind: 'add', text: 'b', newNo: 2 },
    ])
    expect(unifiedDiff('a\n', '').map((l) => l.kind)).toEqual(['meta', 'del'])
  })
})

describe('unifiedDiff correctness', () => {
  it('old and new sides rebuild both inputs', () => {
    let seed = 7
    const rand = (n: number): number => (seed = (seed * 48271) % 2147483647) % n
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rand(30) }, () => `l${rand(6)}`)
      const b = Array.from({ length: rand(30) }, () => `l${rand(6)}`)
      const out = unifiedDiff(a.join('\n'), b.join('\n'), Number.MAX_SAFE_INTEGER)
      expect(out.filter((l) => l.kind === 'ctx' || l.kind === 'del').map((l) => l.text)).toEqual(a)
      expect(out.filter((l) => l.kind === 'ctx' || l.kind === 'add').map((l) => l.text)).toEqual(b)
    }
  })
})

describe('showWhitespace', () => {
  it('marks tabs and trailing spaces on changed lines only', () => {
    expect(showWhitespace('\tx = 1  \r', true)).toBe('→   x = 1··')
    expect(showWhitespace('\tx = 1  \r', false)).toBe('    x = 1  ')
  })
})
