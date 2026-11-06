import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertWritable, isInside, safeResolve, PathSafetyError } from './paths.js'
import { PermissionDeniedError } from './policy.js'

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

describe('link escapes', () => {
  // A junction needs no admin rights on Windows; elsewhere it is a plain dir symlink.
  const base = mkdtempSync(path.join(tmpdir(), 'hesdor-paths-'))
  const repo = path.join(base, 'repo')
  const secrets = path.join(base, 'secrets')
  mkdirSync(repo)
  mkdirSync(secrets)
  writeFileSync(path.join(secrets, 'id_rsa'), 'PRIVATE')
  symlinkSync(secrets, path.join(repo, 'docs'), 'junction')

  it('refuses paths that leave the repo through a link', () => {
    expect(() => safeResolve(repo, 'docs/id_rsa')).toThrow(PathSafetyError)
    expect(() => safeResolve(repo, 'docs/new-file.txt')).toThrow(PathSafetyError)
    expect(() => safeResolve(repo, 'docs/a/b/not-yet.txt')).toThrow(PathSafetyError)
  })

  it('still allows ordinary paths, including ones that do not exist yet', () => {
    expect(safeResolve(repo, 'src/new/file.ts')).toBe(path.join(repo, 'src', 'new', 'file.ts'))
  })
})

describe('assertWritable', () => {
  it('blocks the .git directory in any letter case', () => {
    expect(() => assertWritable(ROOT, path.join(ROOT, '.git', 'hooks', 'pre-commit'))).toThrow(PermissionDeniedError)
    expect(() => assertWritable(ROOT, path.join(ROOT, '.GIT', 'config'))).toThrow(PermissionDeniedError)
  })

  it('allows normal files and look-alike names', () => {
    expect(() => assertWritable(ROOT, path.join(ROOT, 'src', 'a.ts'))).not.toThrow()
    expect(() => assertWritable(ROOT, path.join(ROOT, '.github', 'workflows', 'ci.yml'))).not.toThrow()
    expect(() => assertWritable(ROOT, path.join(ROOT, '.gitignore'))).not.toThrow()
  })
})
