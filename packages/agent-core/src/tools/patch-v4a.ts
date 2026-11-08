import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { assertWritable, safeResolve, toRel } from '../paths.js'
import type { ToolContext } from '../context.js'
import { applyFormat, assertFresh, fileFormat, pushSnapshot, readBefore, recordStamp, requireApproved, toLf } from './fs.js'
import { checkAfter, checkBefore } from '../checks.js'
import { defineTool } from './types.js'

/**
 * V4A patches, the format OpenAI's GPT-5+ and Codex models are trained on (Codex CLI's apply_patch,
 * the Responses API's built-in apply_patch tool). Grammar: codex-rs/core/assets/tools/apply_patch.lark.
 */

/** OpenAI GPT-5 and later, and Codex models, get apply_patch in V4A form; everything else keeps find/replace. */
export function usesV4APatch(model: string): boolean {
  const id = model.slice(model.lastIndexOf('/') + 1).toLowerCase()
  return /^gpt-([5-9]|\d{2,})/.test(id) || id.includes('codex')
}

interface Chunk {
  /** `@@ <line>` anchors, searched in order before the hunk. */
  anchors: string[]
  old: string[]
  new: string[]
  /** [old index, new index] of each context line, so a fuzzy match keeps the file's own line. */
  ctx: Array<[number, number]>
  /** `*** End of File`: the hunk must match the end of the file. */
  eof: boolean
}

export type PatchOp =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; chunks: Chunk[] }

/** A patch that cannot apply; `path` (repo-relative) counts toward that file's write_file fallback. */
export class PatchError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message)
  }
}

const header = (line: string, marker: string): string | undefined =>
  line.startsWith(marker) ? line.slice(marker.length).trim() : undefined

export function parseV4A(input: string): PatchOp[] {
  let lines = input.trim().split(/\r?\n/)
  // OpenAI's GPT-4.1 guide wraps the patch in a heredoc: apply_patch <<"EOF" ... EOF
  if (/^apply_patch\s*<<\s*['"]?EOF['"]?\s*$/.test(lines[0]!.trim())) {
    lines = lines.slice(1)
    if (lines.at(-1)?.trim() === 'EOF') lines.pop()
  }
  if (lines[0]?.trim() !== '*** Begin Patch') throw new PatchError('the patch must start with "*** Begin Patch"')
  const end = lines.findIndex((l) => l.trim() === '*** End Patch')
  if (end < 0) throw new PatchError('the patch must end with "*** End Patch"')
  const body = lines.slice(1, end)
  const ops: PatchOp[] = []
  let i = 0
  while (i < body.length) {
    const line = body[i++]!
    let file: string | undefined
    if (line.trim() === '') continue
    if ((file = header(line, '*** Add File: ')) !== undefined) {
      const added: string[] = []
      for (; i < body.length && !body[i]!.startsWith('***'); i++) {
        if (!body[i]!.startsWith('+')) throw new PatchError(`Add File ${file}: every line must start with "+", got ${JSON.stringify(body[i])}`)
        added.push(body[i]!.slice(1))
      }
      ops.push({ type: 'add', path: file, lines: added })
    } else if ((file = header(line, '*** Delete File: ')) !== undefined) {
      ops.push({ type: 'delete', path: file })
    } else if ((file = header(line, '*** Update File: ')) !== undefined) {
      const moveTo = i < body.length ? header(body[i]!, '*** Move to: ') : undefined
      if (moveTo !== undefined) i++
      const chunks: Chunk[] = []
      let chunk: Chunk | undefined
      for (; i < body.length && !(body[i]!.startsWith('***') && body[i]!.trim() !== '*** End of File'); i++) {
        const l = body[i]!
        if (l.trim() === '*** End of File') {
          if (chunk) chunk.eof = true
          chunk = undefined
          continue
        }
        if (l.startsWith('@@')) {
          // Consecutive @@ lines narrow down one hunk (class, then method).
          if (!chunk || chunk.old.length > 0 || chunk.new.length > 0) chunks.push((chunk = { anchors: [], old: [], new: [], ctx: [], eof: false }))
          if (l.slice(2).trim() !== '') chunk.anchors.push(l.slice(2).trim())
          continue
        }
        if (!chunk) chunks.push((chunk = { anchors: [], old: [], new: [], ctx: [], eof: false }))
        const text = l.slice(1)
        if (l === '' || l[0] === ' ') {
          chunk.ctx.push([chunk.old.length, chunk.new.length])
          chunk.old.push(text)
          chunk.new.push(text)
        } else if (l[0] === '-') chunk.old.push(text)
        else if (l[0] === '+') chunk.new.push(text)
        else throw new PatchError(`Update File ${file}: line ${JSON.stringify(l)} must start with " ", "-", "+" or "@@"`)
      }
      if (chunks.length === 0 && moveTo === undefined) throw new PatchError(`Update File ${file} has no changes`)
      ops.push({ type: 'update', path: file, chunks, ...(moveTo !== undefined ? { moveTo } : {}) })
    } else {
      throw new PatchError(`unexpected line ${JSON.stringify(line)}: expected "*** Add File: ", "*** Update File: " or "*** Delete File: "`)
    }
  }
  if (ops.length === 0) throw new PatchError('the patch changes no files')
  return ops
}

/** First index >= start where `pattern` matches: exactly, then ignoring trailing, then all surrounding whitespace (as Codex does). */
function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (pattern.length > lines.length) return -1
  const from = eof ? Math.max(start, lines.length - pattern.length) : start
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    for (let i = from; i + pattern.length <= lines.length; i++) {
      if (pattern.every((p, j) => norm(lines[i + j]!) === norm(p))) return i
    }
  }
  return eof ? seek(lines, pattern, start, false) : -1
}

/** Apply update hunks to LF text without a BOM. Throws PatchError naming `file` when a hunk does not match. */
export function applyChunks(text: string, chunks: Chunk[], file: string): string {
  const trailing = text.endsWith('\n')
  const lines = text === '' ? [] : (trailing ? text.slice(0, -1) : text).split('\n')
  const edits: Array<{ at: number; remove: number; insert: string[] }> = []
  let cursor = 0
  for (const chunk of chunks) {
    for (const anchor of chunk.anchors) {
      const at = seek(lines, [anchor], cursor, false)
      if (at < 0) throw new PatchError(`${file}: the @@ context line ${JSON.stringify(anchor)} was not found${cursor > 0 ? ' after the previous hunk' : ''}`, file)
      cursor = at + 1
    }
    if (chunk.old.length === 0) {
      // Pure addition: after the @@ anchor when there is one, else at the end of the file (Codex).
      edits.push({ at: chunk.anchors.length > 0 ? cursor : lines.length, remove: 0, insert: chunk.new })
      continue
    }
    let { old, new: insert } = chunk
    let at = seek(lines, old, cursor, chunk.eof)
    if (at < 0 && old.at(-1) === '') {
      // A trailing blank context line often stands for the end of the file.
      old = old.slice(0, -1)
      if (insert.at(-1) === '') insert = insert.slice(0, -1)
      at = seek(lines, old, cursor, chunk.eof)
    }
    if (at < 0) {
      const shown = chunk.old.slice(0, 12).join('\n')
      throw new PatchError(`${file}: these lines were not found${cursor > 0 ? ' after the previous hunk or @@ line' : ''}; read the file again and copy them exactly:\n${shown}`, file)
    }
    insert = [...insert]
    for (const [o, n] of chunk.ctx) if (o < old.length && n < insert.length) insert[n] = lines[at + o]!
    edits.push({ at, remove: old.length, insert })
    cursor = at + old.length
  }
  // Back to front so earlier indexes stay valid; stable sort keeps same-index edits in patch order.
  for (const e of [...edits].reverse().sort((a, b) => b.at - a.at)) lines.splice(e.at, e.remove, ...e.insert)
  if (lines.length === 0) return ''
  return lines.join('\n') + (trailing || text === '' ? '\n' : '')
}

interface PlannedWrite {
  abs: string
  rel: string
  before: Buffer | null
  /** null deletes the file. */
  after: string | null
}

const sameBytes = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b))

/**
 * Plan every file first, then review each change, then write them all: a hunk that fails or a
 * change the user rejects leaves every file untouched.
 */
async function applyV4A(ctx: ToolContext, patch: string): Promise<string> {
  const ops = parseV4A(patch)
  const writes: PlannedWrite[] = []
  const seen = new Set<string>()
  const target = (p: string): { abs: string; rel: string } => {
    const abs = safeResolve(ctx.root, p)
    assertWritable(ctx.root, abs)
    const rel = toRel(ctx.root, abs)
    if (seen.has(abs)) throw new PatchError(`${rel} appears twice in one patch; put all its changes in one section`)
    seen.add(abs)
    return { abs, rel }
  }
  for (const op of ops) {
    const { abs, rel } = target(op.path)
    if (op.type === 'add') {
      if ((await readBefore(abs)) !== null) throw new PatchError(`${rel} already exists; use "*** Update File: ${rel}"`, rel)
      writes.push({ abs, rel, before: null, after: op.lines.length > 0 ? `${op.lines.join('\n')}\n` : '' })
      continue
    }
    await assertFresh(ctx, abs, rel)
    const before = await readBefore(abs)
    if (before === null) throw new PatchError(`${rel} does not exist`, rel)
    if (op.type === 'delete') {
      writes.push({ abs, rel, before, after: null })
      continue
    }
    if (before.subarray(0, 8192).includes(0)) throw new PatchError(`${rel} is a binary file and cannot be patched`, rel)
    // Match on the LF view without BOM (what read_file shows) and write back in the file's own format.
    const original = before.toString('utf8')
    const format = fileFormat(original)
    const body = format.bom ? original.slice(1) : original
    const updated = applyFormat(applyChunks(format.crlf ? toLf(body) : body, op.chunks, rel), format)
    if (op.moveTo === undefined) {
      writes.push({ abs, rel, before, after: updated })
      continue
    }
    const dest = target(op.moveTo)
    if ((await readBefore(dest.abs)) !== null) throw new PatchError(`cannot move ${rel} to ${dest.rel}: it already exists`, rel)
    writes.push({ ...dest, before: null, after: updated }, { abs, rel, before, after: null })
  }

  for (const w of writes) await requireApproved(ctx, w.abs, w.rel, w.before, w.after)
  for (const w of writes) {
    if (!sameBytes(await readBefore(w.abs), w.before)) throw new Error(`${w.rel} changed while the patch was being reviewed; nothing was written`)
  }

  // Post-edit checks (checks.ts): lint baselines now, format and lint after the write.
  for (const w of writes) if (w.after !== null) await checkBefore(ctx, w.abs)
  const done: PlannedWrite[] = []
  try {
    for (const w of writes) {
      if (w.after === null) await unlink(w.abs)
      else {
        await mkdir(path.dirname(w.abs), { recursive: true })
        await writeFile(w.abs, w.after, 'utf8')
      }
      done.push(w)
    }
  } catch (err) {
    // All or nothing: put back the files already written.
    for (const w of done.reverse()) await (w.before === null ? unlink(w.abs) : writeFile(w.abs, w.before)).catch(() => {})
    throw err
  }

  const notes: string[] = []
  for (const w of writes) {
    if (w.after === null) continue
    const checked = await checkAfter(ctx, w.abs) // may reformat, so before the stamp
    notes.push(...[checked.formatted, checked.checks].filter((n): n is string => n !== undefined))
  }
  for (const w of writes) {
    if (w.after === null) ctx.state.fileStamps?.delete(w.abs)
    else await recordStamp(ctx, w.abs)
    pushSnapshot(ctx, w.abs, w.before)
    ctx.state.patchFailures?.delete(w.rel)
    ctx.emit({ type: 'file.changed', path: w.rel, op: w.after === null ? 'delete' : 'write' })
  }
  const status = (w: PlannedWrite): string => (w.after === null ? 'D' : w.before === null ? 'A' : 'M')
  return `Success. Updated the following files:\n${writes.map((w) => `${status(w)} ${w.rel}`).join('\n')}${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`
}

export const applyPatchV4ATool = defineTool({
  name: 'apply_patch',
  description: [
    'Edit files with a patch in the V4A format. Pass the whole patch as "input":',
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+every line of a new file starts with +',
    '*** Update File: src/app.ts',
    '*** Move to: src/main.ts   (optional: also renames the file)',
    '@@ function start() {      (optional: a line just above the change, repeat @@ to narrow down)',
    ' context line (starts with a space)',
    '-old line',
    '+new line',
    '*** Delete File: src/old.ts',
    '*** End Patch',
    'Paths are relative to the repository root. Give about 3 lines of context above and below each change and no line numbers; put "*** End of File" after a hunk that ends the file.',
    'Every hunk must apply or nothing is written. Fails if a file changed since you last read it.',
  ].join('\n'),
  risk: 'WRITE',
  schema: z.object({
    input: z.string().min(1).describe('The whole patch, from "*** Begin Patch" to "*** End Patch"'),
  }),
  async execute(input, ctx) {
    try {
      return await applyV4A(ctx, input.input)
    } catch (err) {
      if (!(err instanceof PatchError) || err.path === undefined) throw err
      const failures = (ctx.state.patchFailures ??= new Map())
      const count = (failures.get(err.path) ?? 0) + 1
      failures.set(err.path, count)
      if (count < 2) throw err
      throw new PatchError(`${err.message}\nPatching ${err.path} failed ${count} times in a row: stop patching it, read it again and rewrite the whole file with write_file.`, err.path)
    }
  },
})
