import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { imageMediaType, MAX_IMAGE_BYTES } from '@hesdor/protocol'
import type { ChatImage } from '@hesdor/protocol'
import { assertWritable, safeResolve, toRel } from '../paths.js'
import { GitIgnoreMatcher } from '../ignore.js'
import { decideWrite, PermissionDeniedError, requireUserApproval } from '../policy.js'
import type { ToolContext } from '../context.js'
import { writeWithChecks } from '../checks.js'
import { defineTool } from './types.js'

/** Bytes one read returns, line-number prefixes included (about 16k tokens); read_files splits it across its files. */
const MAX_READ_BYTES = 64 * 1024
const DEFAULT_READ_LINES = 2000
/** Files above this are refused by read_file instead of loaded into memory. */
const MAX_READ_FILE_BYTES = 20 * 1024 * 1024
const MAX_LIST_ENTRIES = 2000

const stampOf = (info: { mtimeMs: number; size: number }): string => `${info.mtimeMs}:${info.size}`

/** Remember how a file looked when the agent last read or wrote it (stale-edit guard). */
export async function recordStamp(ctx: ToolContext, abs: string): Promise<void> {
  try {
    ;(ctx.state.fileStamps ??= new Map()).set(abs, stampOf(await stat(abs)))
  } catch {
    ctx.state.fileStamps?.delete(abs)
  }
}

/**
 * Refuse to patch a file that changed on disk since the agent last read or wrote it.
 * A file never read this session is not blocked: apply_patch's exact `find` already proves
 * the model knows the current text, and requiring a read first would break blind small edits.
 */
export async function assertFresh(ctx: ToolContext, abs: string, relPath: string): Promise<void> {
  const known = ctx.state.fileStamps?.get(abs)
  if (known === undefined) return
  const now = await stat(abs).then(stampOf, () => 'missing')
  if (now !== known) throw new Error(`apply_patch: ${relPath} changed since you read it; read it again before editing`)
}

const pathSchema = z.string().min(1).describe('Relative path inside the repository, e.g. "src/auth.ts"')

/** Models often send "" for optional paths; treat it as absent. */
function cleanOptional(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value : undefined
}

const MAX_SNAPSHOTS = 50

/** Prior file bytes (binary-safe for /undo), or null when the file does not exist. */
export async function readBefore(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs)
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

export const BOM = '﻿'
export const toLf = (text: string): string => text.replace(/\r\n/g, '\n')

/** EOL style (CRLF by majority) and BOM of existing content, so edits keep the file's format. */
export function fileFormat(text: string): { crlf: boolean; bom: boolean } {
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return { crlf: crlf > lf, bom: text.startsWith(BOM) }
}

/** Re-apply a file's EOL style and BOM to LF text without a BOM. */
export function applyFormat(lfText: string, format: { crlf: boolean; bom: boolean }): string {
  const body = format.crlf ? lfText.replace(/\n/g, '\r\n') : lfText
  return format.bom ? BOM + body : body
}

/** Capture prior content post-approval so /undo can restore it. */
export function pushSnapshot(ctx: ToolContext, abs: string, before: Buffer | null): void {
  ctx.state.redo.length = 0
  ctx.state.snapshots.push({ path: abs, content: before })
  if (ctx.state.snapshots.length > MAX_SNAPSHOTS) ctx.state.snapshots.shift()
}

const asText = (bytes: Buffer | null): string | null => (bytes === null ? null : bytes.toString('utf8'))

/** Permission rules, then the host review gate for file mutations; throws when refused. */
export async function requireApproved(
  ctx: ToolContext,
  abs: string,
  relPath: string,
  before: Buffer | null,
  after: string | null,
): Promise<void> {
  const decision = decideWrite(relPath, ctx.permissions)
  if (decision.action === 'deny') throw new PermissionDeniedError(`denied: changing ${relPath} (${decision.reason})`)
  if (decision.action === 'ask') {
    await requireUserApproval(ctx, { title: 'Allow this file change?', detail: `${relPath}\n(${decision.reason})` }, `changing ${relPath} (${decision.reason})`)
  }
  // A user allow rule for this path skips the diff review.
  if (!ctx.reviewChange || (decision.action === 'allow' && decision.source === 'user')) return
  const approved = await ctx.reviewChange({ path: relPath, before: asText(before), after })
  if (!approved) {
    throw new PermissionDeniedError(`the user rejected the change to ${relPath}`)
  }
  const now = await readBefore(abs)
  if (now === null || before === null ? now !== before : !now.equals(before)) {
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

/** Breadth-first walk skipping ignored paths; `filter` selects files, `max` caps how many are kept. */
export async function walkFiles(
  root: string,
  subdir: string,
  opts: { filter?: (relPath: string) => boolean; max?: number } = {},
): Promise<{ root: string; count: number; truncated: boolean; files: string[] }> {
  const max = opts.max ?? MAX_LIST_ENTRIES
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
      else if (entry.isFile() && (!opts.filter || opts.filter(childRel))) {
        if (files.length >= max) {
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
  description:
    'Read a text file. Each line is prefixed with its line number and a tab (cat -n style); that prefix is not part of the file, so never copy it into apply_patch. Returns up to 2000 lines; large files are capped and say which offset continues them.',
  risk: 'READ',
  schema: z.object({
    path: pathSchema,
    offset: z.number().int().positive().optional().describe('1-based line number to start from'),
    limit: z.number().int().positive().max(5000).optional().describe('Max lines to return'),
  }),
  async execute(input, ctx) {
    return (ctx.imageInput && (await readImage(ctx, input.path))) || readOne(ctx, input.path, input.offset, input.limit)
  },
})

/** A png/jpeg/gif/webp file (checked by its bytes) as an image for the model; undefined for anything else. */
async function readImage(ctx: ToolContext, relPath: string): Promise<ReadResult | undefined> {
  if (!/\.(png|jpe?g|gif|webp)$/i.test(relPath)) return undefined
  const abs = safeResolve(ctx.root, relPath)
  const info = await stat(abs)
  if (!info.isFile()) return undefined
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`"${relPath}" is ${(info.size / 1e6).toFixed(1)} MB; images over ${MAX_IMAGE_BYTES / 1e6} MB are not sent to the model`)
  }
  const buf = await readFile(abs)
  const mediaType = imageMediaType(buf)
  if (!mediaType) return undefined
  const rel = toRel(ctx.root, abs)
  return { path: rel, binary: true, bytes: info.size, totalLines: 0, offset: 1, content: '', truncated: false, image: { mediaType, data: buf.toString('base64') } }
}

interface ReadResult {
  path: string
  totalLines: number
  offset: number
  content: string
  truncated: boolean
  /** Line to pass as `offset` to continue after a truncated read. */
  nextOffset?: number
  binary?: boolean
  bytes?: number
  /** read_file of an image for a vision model; the loop attaches it to the tool result. */
  image?: ChatImage
}

async function readOne(
  ctx: ToolContext,
  relPath: string,
  offset?: number,
  limit = DEFAULT_READ_LINES,
  maxBytes = MAX_READ_BYTES,
): Promise<ReadResult> {
  const abs = safeResolve(ctx.root, relPath)
  const info = await stat(abs)
  if (info.isDirectory()) throw new Error(`"${relPath}" is a directory`)
  if (info.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `"${relPath}" is ${(info.size / 1024 / 1024).toFixed(1)} MB, too large for read_file; use search_files to find the lines you need`,
    )
  }
  const buf = await readFile(abs)
  const rel = toRel(ctx.root, abs)
  if (buf.subarray(0, 8192).includes(0)) {
    return { path: rel, binary: true, bytes: info.size, totalLines: 0, offset: 1, content: '(binary file, not shown)', truncated: false }
  }
  ;(ctx.state.fileStamps ??= new Map()).set(abs, stampOf(info))
  const allLines = buf.toString('utf8').split(/\r?\n/)
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  const start = Math.max(0, (offset ?? 1) - 1)
  const slice = allLines.slice(start, start + limit)
  // Cap the reply by UTF-8 bytes (with its "N\t" prefixes) at a line boundary, so `nextOffset` reaches the rest of the file.
  const shown: string[] = []
  let bytes = 0
  for (const line of slice) {
    const size = Buffer.byteLength(line, 'utf8') + String(start + shown.length + 1).length + 2
    if (bytes + size > maxBytes) {
      if (shown.length === 0) shown.push(Buffer.from(line, 'utf8').subarray(0, maxBytes).toString('utf8')) // one huge line
      break
    }
    shown.push(line)
    bytes += size
  }
  const end = start + shown.length
  return {
    path: rel,
    totalLines: allLines.length,
    offset: start + 1,
    content: shown.join('\n'),
    truncated: end < allLines.length || shown.at(-1) !== slice[shown.length - 1],
    ...(end < allLines.length ? { nextOffset: end + 1 } : {}),
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
    const files: Array<ReadResult | { path: string; error: string }> = []
    // Each file gets an equal share of what is left, so one big file cannot crowd out the rest.
    let left = MAX_READ_BYTES
    for (const [i, p] of input.paths.entries()) {
      try {
        const res = await readOne(ctx, p, undefined, undefined, Math.max(1024, Math.floor(left / (input.paths.length - i))))
        left -= Buffer.byteLength(formatRead(res), 'utf8')
        files.push(res)
      } catch (err) {
        files.push({ path: p, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { files }
  },
})

/** Plain-text view of a read: a header line, then `N\t`-numbered lines, then how to continue. */
export function formatRead(res: ReadResult): string {
  if (res.image) return `${res.path}: ${res.image.mediaType} image (${res.bytes} bytes), attached`
  if (res.binary) return `${res.path}: binary file (${res.bytes} bytes), not shown`
  const lines = res.content === '' && res.totalLines <= 1 ? [] : res.content.split('\n')
  if (lines.length === 0) return `${res.path} (empty)`
  const end = res.offset + lines.length - 1
  const out = [`${res.path} (lines ${res.offset}-${end} of ${res.totalLines})`, ...lines.map((l, i) => `${res.offset + i}\t${l}`)]
  if (res.nextOffset) out.push(`[… ${res.totalLines - end} more lines; read_file with offset ${res.nextOffset} continues …]`)
  else if (res.truncated) out.push(`[… line ${end} is cut off: it is too long to show …]`)
  return out.join('\n')
}

/** Plain text for read_files results. */
export function formatReadFiles(result: { files: Array<ReadResult | { path: string; error: string }> }): string {
  return result.files.map((f) => ('error' in f ? `${f.path}: ERROR: ${f.error}` : formatRead(f))).join('\n\n')
}

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
    assertWritable(ctx.root, abs)
    const before = await readBefore(abs)
    // Overwriting a CRLF/BOM file keeps its format so the edit does not churn every line; new files are written as given.
    const format = before === null ? null : fileFormat(before.toString('utf8'))
    const content =
      format && (format.crlf || format.bom)
        ? applyFormat(toLf(input.content.startsWith(BOM) ? input.content.slice(1) : input.content), format)
        : input.content
    await requireApproved(ctx, abs, toRel(ctx.root, abs), before, content)
    await mkdir(path.dirname(abs), { recursive: true })
    // Format and lint after the write; the snapshot keeps the pre-edit bytes, so /undo restores those.
    const checked = await writeWithChecks(ctx, abs, () => writeFile(abs, content, 'utf8'))
    await recordStamp(ctx, abs)
    pushSnapshot(ctx, abs, before)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'write' })
    return { path: toRel(ctx.root, abs), bytes: Buffer.byteLength(content, 'utf8'), ...checked }
  },
})

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: 'Delete a single file inside the repository.',
  risk: 'WRITE',
  schema: z.object({ path: pathSchema }),
  async execute(input, ctx) {
    const abs = safeResolve(ctx.root, input.path)
    assertWritable(ctx.root, abs)
    const before = await readBefore(abs)
    if (before === null) throw new Error(`"${input.path}" does not exist`)
    await requireApproved(ctx, abs, toRel(ctx.root, abs), before, null)
    await unlink(abs)
    ctx.state.fileStamps?.delete(abs)
    pushSnapshot(ctx, abs, before)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'delete' })
    return { deleted: true, path: toRel(ctx.root, abs) }
  },
})

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description:
    'Edit an existing file by exact text replacement. Each edit needs "find" (text that appears EXACTLY once in the file unless replace_all is set; include surrounding lines to make it unique) and "replace" (the new text, empty string to delete). If "find" is not found exactly, whole lines that match it when ignoring indentation and trailing whitespace are replaced, but only when that match is unique. Fails if the file changed since you last read it.',
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
    assertWritable(ctx.root, abs)
    await assertFresh(ctx, abs, input.path)
    const originalBytes = await readFile(abs)
    const original = originalBytes.toString('utf8')
    // read_file shows LF without the BOM, so match on that view and restore the file's own format on write.
    const format = fileFormat(original)
    const norm = (text: string): string => (format.crlf ? toLf(text) : text)
    let updated = norm(format.bom ? original.slice(1) : original)
    let tolerant = 0
    for (const { find, replace } of input.edits) {
      const edit = { find: norm(find), replace: norm(replace) }
      const occurrences = updated.split(edit.find).length - 1
      if (occurrences === 0) {
        const fuzzy = replaceIgnoringWhitespace(updated, edit.find, edit.replace)
        if (typeof fuzzy === 'string') {
          updated = fuzzy
          tolerant++
          continue
        }
        throw new Error(
          `apply_patch: "find" text not found in ${input.path}: ${JSON.stringify(edit.find.slice(0, 80))}. ${fuzzy.hint}`,
        )
      }
      if (occurrences > 1 && !input.replace_all) {
        throw new Error(
          `apply_patch: "find" text appears ${occurrences} times in ${input.path}; add surrounding lines to make it unique or set replace_all`,
        )
      }
      updated = input.replace_all
        ? updated.split(edit.find).join(edit.replace)
        : updated.replace(edit.find, () => edit.replace) // function form: `$&`, `$'`, `$$` stay literal
    }
    updated = applyFormat(updated, format)
    await requireApproved(ctx, abs, toRel(ctx.root, abs), originalBytes, updated)
    const checked = await writeWithChecks(ctx, abs, () => writeFile(abs, updated, 'utf8'))
    await recordStamp(ctx, abs)
    pushSnapshot(ctx, abs, originalBytes)
    ctx.emit({ type: 'file.changed', path: toRel(ctx.root, abs), op: 'write' })
    return {
      path: toRel(ctx.root, abs),
      applied: input.edits.length,
      ...(tolerant > 0 ? { whitespaceTolerant: tolerant } : {}),
      ...checked,
    }
  },
})

const indentOf = (line: string): string => /^\s*/.exec(line)![0]

/**
 * Fallback for a `find` that is not in the file verbatim: match whole lines while ignoring
 * indentation and trailing whitespace. Applies only to a unique match, re-indenting `replace`
 * by the file's indentation; otherwise returns a hint quoting the nearest lines.
 */
function replaceIgnoringWhitespace(text: string, find: string, replace: string): string | { hint: string } {
  const lines = text.split('\n')
  const findLines = find.split('\n')
  const trailingNewline = findLines.length > 1 && findLines.at(-1) === ''
  if (trailingNewline) findLines.pop()
  const want = findLines.map((l) => l.trim())
  if (want.every((w) => w === '')) return { hint: 'Read the file again and copy the exact lines.' }

  const starts: number[] = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => lines[i + j]!.trim() === w)) starts.push(i)
  }
  if (starts.length > 1) {
    return {
      hint: `Ignoring whitespace it matches ${starts.length} places (lines ${starts.slice(0, 5).map((s) => s + 1).join(', ')}); include more surrounding lines.`,
    }
  }
  if (starts.length === 1) {
    const at = starts[0]!
    const k = want.findIndex((w) => w !== '')
    const fromIndent = indentOf(findLines[k]!)
    const toIndent = indentOf(lines[at + k]!)
    const replLines = replace === '' ? [] : replace.split('\n')
    if (trailingNewline && replLines.at(-1) === '') replLines.pop()
    const reindented = replLines.map((l) => (l.trim() !== '' && l.startsWith(fromIndent) ? toIndent + l.slice(fromIndent.length) : l))
    lines.splice(at, want.length, ...reindented)
    return lines.join('\n')
  }

  // Nearest window: the most find lines contained in consecutive file lines.
  let best = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    let score = 0
    for (let j = 0; j < want.length && i + j < lines.length; j++) {
      if (want[j] !== '' && lines[i + j]!.includes(want[j]!)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  // No whole find line occurs: fall back to the longest prefix of the first one (typo late in the line).
  const first = want.find((w) => w !== '')!
  for (let len = Math.floor(first.length / 2); best < 0 && len >= 8; len = Math.floor(len / 2)) {
    best = lines.findIndex((l) => l.includes(first.slice(0, len)))
  }
  if (best < 0) return { hint: 'No similar lines found; read the file again.' }
  const quoted = lines
    .slice(best, best + Math.min(want.length + 1, 12))
    .map((l, i) => `${best + i + 1}: ${l}`)
    .join('\n')
  return { hint: `Nearest lines in the file:\n${quoted}\nCopy them exactly and retry.` }
}
