import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { isInside, safeResolve, PathSafetyError } from './paths.js'

const ROOT = path.resolve('/repo')

describe('safeResolve', () => {
  it('resolves relative paths inside the root', () => {
    expect(safeResolve(ROOT, 'src/auth.ts')).toBe(path.join(ROOT, 'src', 'auth.ts'))
    expect(safeResolve(ROOT, './a/b.txt')).toBe(path.join(ROOT, 'a', 'b.txt'))
  })

  it('allows paths that stay inside via ..', () => {
    expect(safeResolve(ROOT, 'src/../package.json')).toBe(path.join(ROOT, 'package.json'))
  })

  it('rejects ../ traversal out of the root', () => {
    expect(() => safeResolve(ROOT, '../outside.txt')).toThrow(PathSafetyError)
    expect(() => safeResolve(ROOT, 'a/../../outside')).toThrow(PathSafetyError)
  })

  it('rejects absolute external paths', () => {
    const external = path.resolve(ROOT, '..', 'elsewhere.txt')
    expect(() => safeResolve(ROOT, external)).toThrow(PathSafetyError)
  })

  it('rejects empty input', () => {
    expect(() => safeResolve(ROOT, '')).toThrow(PathSafetyError)
    expect(() => safeResolve(ROOT, '   ')).toThrow(PathSafetyError)
  })
})

describe('isInside', () => {
  it('accepts the root itself and children', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
    expect(isInside(ROOT, path.join(ROOT, 'x', 'y'))).toBe(true)
  })

  it('rejects parents and siblings', () => {
    expect(isInside(ROOT, path.dirname(ROOT))).toBe(false)
    expect(isInside(ROOT, `${ROOT} sibling`.replace(' ', '-'))).toBe(false)
  })
})
