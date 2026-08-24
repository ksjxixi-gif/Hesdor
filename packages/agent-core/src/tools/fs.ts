import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { safeResolve, toRel } from '../paths.js'
import { GitIgnoreMatcher } from '../ignore.js'
import { PermissionDeniedError } from '../policy.js'
import type { ToolContext } from '../context.js'
import { defineTool } from './types.js'

const MAX_READ_BYTES = 256 * 1024
const MAX_LIST_ENTRIES = 2000

const pathSchema = z.string().min(1).describe('Relative path inside the repository, e.g. "src/auth.ts"')

/** Models often send "" for optional paths; treat it as absent. */
function cleanOptional(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value : undefined
}

const MAX_SNAPSHOTS = 50

/** Prior file content, or null when the file does not exist. */
async function readBefore(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, 'utf8')
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

/** Capture prior content post-approval so /undo can restore it. */
function pushSnapshot(ctx: ToolContext, abs: string, before: string | null): void {
  ctx.state.redo.length = 0
  ctx.state.snapshots.push({ path: abs, content: before })
  if (ctx.state.snapshots.length > MAX_SNAPSHOTS) ctx.state.snapshots.shift()
}

/** Host review gate for file mutations; throws when the user rejects. */
async function requireApproved(
  ctx: ToolContext,
  abs: string,
  relPath: string,
  before: string | null,
  after: string | null,
): Promise<void> {
  if (!ctx.reviewChange) return
  const approved = await ctx.reviewChange({ path: relPath, before, after })
  if (!approved) {
    throw new PermissionDeniedError(`the user rejected the change to ${relPath}`)
  }
  if ((await readBefore(abs)) !== before) {
    throw new Error(`the file changed while it was being reviewed: ${relPath}`)
  }
}

export const listFilesTool = defineTool({
  name: 'list_files',
  description:
    'List files in the repository (or a subdirectory of it), skipping ignored paths such as .git and node_modules. Use this to explore project structure.',
  risk: 'READ',
  schema: z.object({
    subdir: z
      .string()
      .optional()
      .describe('Optional subdirectory to list instead of the repository root'),
  }),
  async execute(input, ctx) {
    return walkFiles(ctx.root, cleanOptional(input.subdir) ?? '.')
  },
})

async function walkFiles(
  root: string,
  subdir: string,
): Promise<{ root: string; count: number; truncated: boolean; files: string[] }> {
  const startAbs = safeResolve(root, subdir)
  const matcher = await GitIgnoreMatcher.load(root)
  const relStart = toRel(root, startAbs)
  const files: string[] = []
  let truncated = false

  const queue: string[] = [relStart === '' ? '' : `${relStart}/`]
  while (queue.length > 0 && !truncated) {
    const dirRel = queue.shift()!
    const dirAbs = dirRel === '' ? root : path.join(root, dirRel)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRel = `${dirRel}${entry.name}`
      if (matcher.ignored(childRel, entry.isDirectory())) continue
      if (entry.isDirectory()) queue.push(`${childRel}/`)
      else if (entry.isFile()) {
        if (files.length >= MAX_LIST_ENTRIES) {
          truncated = true
          break
        }
        files.push(childRel)
      }
    }
  }
  files.sort()
  return { root: relStart || '.', count: files.length, truncated, files }
}

export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a text file. Returns its content plus total line count. Large files are capped.',
  risk: 'READ',
  schema: z.object({
    path: pathSchema,
    offset: z.number().int().positive().optional().describe('1-based line number to start from'),
    limit: z.number().int().positive().max(5000).optional().describe('Max lines to return'),
  }),
  async execute(input, ctx) {
    return readOne(ctx.root, input.path, input.offset, input.limit)
  },
})

async function readOne(
  root: string,
  relPath: string,
  offset?: number,
  limit?: number,
): Promise<{ path: string; totalLines: number; offset: number; content: string; truncated: boolean }> {
  const abs = safeResolve(root, relPath)
  const info = await stat(abs)
  if (info.isDirectory()) throw new Error(`"${relPath}" is a directory`)
  let content = await readFile(abs, 'utf8')
  let truncatedByBytes = false
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES)
    truncatedByBytes = true
  }
  const allLines = content.split(/\r?\n/)
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  const start = Math.max(0, (offset ?? 1) - 1)
  const slice = allLines.slice(start, limit ? start + limit : undefined)
  return {
    path: toRel(root, abs),
    totalLines: allLines.length,
    offset: start + 1,
    content: slice.join('\n'),
    truncated: truncatedByBytes || start + slice.length < allLines.length,
  }
}

export const readFilesTool = defineTool({
  name: 'read_files',
  description: 'Read up to 10 files at once. More efficient than several read_file calls.',
  risk: 'READ',
  schema: z.object({
    paths: z.array(pathSchema).min(1).max(10).describe('File paths inside the repository'),
  }),
  async execute(input, ctx) {
    const files: Array<{ path: string; content: string; error?: string }> = []
    for (const p of input.paths) {
      try {
        const res = await readOne(ctx.root, p)
        files.push({ path: res.path, content: res.content })
      } catch (err) {
        files.push({ path: p, content: '', error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { files }
  },
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create or overwrite a file with the given full content. Parent directories are created automatically. For small edits prefer apply_patch.',
  risk: 'WRITE',
  schema: z.object({
    path: pathSchema,
    content: z.string().describe('Full file content to write'),
  }),
  async execute(input, ctx: ToolContext) {
    const abs = safeResolve(ctx.root, input.path)
    const before = await readBefore(abs)
    await requireApproved(ctx, abs, toRel(ctx.root, abs), before, input.content)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    pushSnapshot(ctx, abs, before)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'write' })
    return { path: toRel(ctx.root, abs), bytes: Buffer.byteLength(input.content, 'utf8') }
  },
})

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a single file inside the repository.',
  risk: 'WRITE',
  schema: z.object({ path: pathSchema }),
  async execute(input, ctx) {
    const abs = safeResolve(ctx.root, input.path)
    const before = await readBefore(abs)
    if (before === null) throw new Error(`"${input.path}" does not exist`)
    await requireApproved(ctx, abs, toRel(ctx.root, abs), before, null)
    await unlink(abs)
    pushSnapshot(ctx, abs, before)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'delete' })
    return { deleted: true, path: toRel(ctx.root, abs) }
  },
})

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description:
    'Edit an existing file by exact text replacement. Each edit needs "find" (text that appears EXACTLY once in the file unless replace_all is set; include surrounding lines to make it unique) and "replace" (the new text, empty string to delete).',
  risk: 'WRITE',
  schema: z.object({
    path: pathSchema,
    edits: z
      .array(
        z.object({
          find: z.string().min(1).describe('Exact existing text to locate'),
          replace: z.string().describe('Replacement text'),
        }),
      )
      .min(1)
      .max(20),
    replace_all: z.boolean().optional().default(false).describe('Replace every occurrence instead of requiring uniqueness'),
  }),
  async execute(input, ctx) {
    const abs = safeResolve(ctx.root, input.path)
    const original = await readFile(abs, 'utf8')
    let updated = original
    for (const edit of input.edits) {
      const occurrences = updated.split(edit.find).length - 1
      if (occurrences === 0) {
        throw new Error(`apply_patch: "find" text not found in ${input.path}: ${JSON.stringify(edit.find.slice(0, 80))}`)
      }
      if (occurrences > 1 && !input.replace_all) {
        throw new Error(
          `apply_patch: "find" text appears ${occurrences} times in ${input.path}; add surrounding lines to make it unique or set replace_all`,
        )
      }
      updated = input.replace_all
        ? updated.split(edit.find).join(edit.replace)
        : updated.replace(edit.find, edit.replace)
    }
    await requireApproved(ctx, abs, toRel(ctx.root, abs), original, updated)
    await writeFile(abs, updated, 'utf8')
    pushSnapshot(ctx, abs, original)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'write' })
    return { path: toRel(ctx.root, abs), applied: input.edits.length }
  },
})
