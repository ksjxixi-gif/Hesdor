import { describe, expect, it } from 'vitest'
import { GitIgnoreMatcher } from './ignore.js'

describe('GitIgnoreMatcher', () => {
  it('ignores default junk directories', () => {
    const m = new GitIgnoreMatcher(['.git', 'node_modules', 'dist', 'build', 'coverage'])
    expect(m.ignored('node_modules/foo/index.js')).toBe(true)
    expect(m.ignored('packages/app/node_modules/x.js')).toBe(true)
    expect(m.ignored('.git/HEAD')).toBe(true)
    expect(m.ignored('src/index.ts')).toBe(false)
  })

  it('supports *.ext patterns at any depth', () => {
    const m = new GitIgnoreMatcher(['*.log'])
    expect(m.ignored('logs/error.log')).toBe(true)
    expect(m.ignored('error.log')).toBe(true)
    expect(m.ignored('logger.ts')).toBe(false)
  })

  it('supports ! negation with last-match-wins', () => {
    const m = new GitIgnoreMatcher(['*.log', '!keep.log'])
    expect(m.ignored('debug.log')).toBe(true)
    expect(m.ignored('keep.log')).toBe(false)
  })

  it('trailing slash matches directories only', () => {
    const m = new GitIgnoreMatcher(['fixtures/'])
    expect(m.ignored('test/fixtures/a.json', true)).toBe(true)
    expect(m.ignored('test/fixtures/a.json', false)).toBe(true) // file under ignored dir
    expect(m.ignored('src/fixtures.ts', false)).toBe(false)
  })

  it('anchored patterns (leading slash or mid slash) match from root only', () => {
    const m = new GitIgnoreMatcher(['/top-secret.txt'])
    expect(m.ignored('top-secret.txt')).toBe(true)
    expect(m.ignored('nested/top-secret.txt')).toBe(false)
  })

  it('handles ** globs', () => {
    const m = new GitIgnoreMatcher(['**/generated/**'])
    expect(m.ignored('src/generated/out.ts')).toBe(true)
    expect(m.ignored('generated/out.ts')).toBe(true)
    expect(m.ignored('src/gen/out.ts')).toBe(false)
  })

  it('skips comments and blank lines', () => {
    const m = new GitIgnoreMatcher(['# comment', '', 'temp.txt'])
    expect(m.ignored('temp.txt')).toBe(true)
    expect(m.ignored('# comment')).toBe(false)
  })
})
