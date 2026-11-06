import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, hasRipgrep } from './index.js'
import { fallbackSearch, ripgrepSearch } from './tools/search.js'
import type { ToolContext } from './context.js'

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hesdor-search-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  return root
}

const FILES = {
  'src/app.tsx': 'const [a, setA] = useState(0)\nconst t = "at 10:12:3: here"\n',
  'src/app.test.ts': 'test()\n',
  'src/deep/util.test.ts': 'useState(\n',
  'docs/readme.md': 'useState(\n',
  'secret/keys.txt': 'useState(\n',
  'dist/out.js': 'useState(\n',
  '.hesdorignore': 'secret/\n',
}

const rgAvailable = await hasRipgrep()

describe.skipIf(!rgAvailable)('ripgrep search', () => {
  it('retries an invalid regex as plain text and returns repo-relative forward-slash paths', async () => {
    const root = repo(FILES)
    const res = await ripgrepSearch(root, '', 'useState(', 100)
    expect(res.note).toMatch(/plain text/)
    expect(res.matches.map((m) => m.file).sort()).toEqual(['docs/readme.md', 'src/app.tsx', 'src/deep/util.test.ts'])
    const sub = await ripgrepSearch(root, 'src/deep', 'useState', 100)
    expect(sub.matches.map((m) => m.file)).toEqual(['src/deep/util.test.ts'])
  })

  it('keeps `:12:3:` inside the matched text', async () => {
    const res = await ripgrepSearch(repo(FILES), '', 'here', 100)
    expect(res.matches).toEqual([{ file: 'src/app.tsx', line: 2, text: 'const t = "at 10:12:3: here"' }])
  })
})

describe('fallback search', () => {
  it('searches an invalid regex as plain text and honors ignores', async () => {
    const root = repo(FILES)
    const res = await fallbackSearch(root, root, 'useState(', 100)
    expect(res.note).toMatch(/plain text/)
    expect(res.matches.map((m) => m.file).sort()).toEqual(['docs/readme.md', 'src/app.tsx', 'src/deep/util.test.ts'])
  })

  it('stops a catastrophic regex at the time budget instead of freezing', async () => {
    const root = repo({ 'a.txt': `${'a'.repeat(40)}!\n`, 'b.txt': 'aaa\n' })
    const started = Date.now()
    const res = await fallbackSearch(root, root, '^(a+)+$', 100, 500)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(res.note).toMatch(/stopped after 500 ms/)
    expect(res.truncated).toBe(true)
  })
})

describe('find_files', () => {
  const root = repo(FILES)
  const ctx = { root, state: { activeChild: null, snapshots: [], redo: [] } } as unknown as ToolContext
  const find = (input: Record<string, unknown>) =>
    createDefaultRegistry().get('find_files')!.execute(input, ctx) as Promise<{ files: string[]; truncated: boolean }>

  it('matches globs with ** and braces, skipping ignored paths', async () => {
    expect((await find({ pattern: 'src/**/*.test.ts' })).files).toEqual(['src/app.test.ts', 'src/deep/util.test.ts'])
    expect((await find({ pattern: '**/*.{md,tsx}' })).files).toEqual(['docs/readme.md', 'src/app.tsx'])
    expect((await find({ pattern: '*.txt' })).files).toEqual([]) // secret/ is in .hesdorignore
    expect((await find({ pattern: '*.js' })).files).toEqual([]) // dist is a default ignore
  })

  it('matches bare names at any depth, relative to subdir, and caps results', async () => {
    expect((await find({ pattern: 'util.test.ts' })).files).toEqual(['src/deep/util.test.ts'])
    expect((await find({ pattern: 'deep/*.ts', subdir: 'src' })).files).toEqual(['src/deep/util.test.ts'])
    expect(await find({ pattern: '*.ts', max_results: 1 })).toMatchObject({ truncated: true, files: [expect.any(String)] })
  })
})
