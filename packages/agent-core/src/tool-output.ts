import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { formatRead, formatReadFiles } from './tools/fs.js'

/** Longest tool result sent to the model (about 8k tokens); longer output is cut and spilled to a file. */
export const MAX_RESULT_CHARS = 32_000
export const SPILL_DIR = '.hesdor/out'

/** Plain text for the model: reads get numbered lines, objects become `key: value` lines and blocks. */
export function formatToolResult(name: string, result: unknown): string {
  if (name === 'read_file' && isRecord(result) && 'totalLines' in result) return formatRead(result as never)
  if (name === 'read_files' && isRecord(result) && Array.isArray(result.files)) return formatReadFiles(result as never)
  return render(result)
}

/** read_file and read_files page through files themselves, so their output is never cut here. */
export function selfLimited(name: string): boolean {
  return name === 'read_file' || name === 'read_files'
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return Array.isArray(value) ? value.map(line).join('\n') : String(value)
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  // A lone text field (MCP text, explore answer) is just that text.
  if (entries.length === 1 && typeof entries[0]![1] === 'string') return entries[0]![1]
  const head: string[] = []
  const blocks: string[] = []
  for (const [key, v] of entries) {
    if (Array.isArray(v)) blocks.push(v.length === 0 ? `${key}: (none)` : `${key} (${v.length}):\n${v.map(line).join('\n')}`)
    else if (typeof v === 'string' && v.includes('\n')) blocks.push(`${key}:\n${v}`)
    else head.push(`${key}: ${typeof v === 'string' ? v || '(empty)' : JSON.stringify(v)}`)
  }
  return [...head, ...blocks].join('\n')
}

function line(item: unknown): string {
  if (typeof item === 'string') return item
  // search_files matches read like grep output.
  if (isRecord(item) && typeof item.file === 'string' && typeof item.line === 'number' && typeof item.text === 'string') {
    return `${item.file}:${item.line}: ${item.text}`
  }
  return JSON.stringify(item)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Keep results under `max` chars: the first 40% and last 60% (errors and summaries tend to be
 * at the end), with a marker naming the file under .hesdor/out that holds the full text.
 */
export async function capOutput(text: string, root: string, callId: string, max = MAX_RESULT_CHARS): Promise<string> {
  if (text.length <= max) return text
  const headBudget = Math.floor(max * 0.4)
  const tailBudget = max - headBudget
  // Snap to line boundaries unless that would waste more than half the budget (one huge line).
  const nl = text.lastIndexOf('\n', headBudget)
  const headEnd = nl > headBudget / 2 ? nl : headBudget
  const tl = text.indexOf('\n', text.length - tailBudget)
  const tailStart = tl >= 0 && tl < text.length - tailBudget / 2 ? tl + 1 : text.length - tailBudget
  const omitted = text.slice(headEnd, tailStart)
  // Both cuts sit on a newline, so the omitted text holds one more newline than whole lines.
  const lines = Math.max(1, omitted.split('\n').length - 2)
  const file = `${Date.now().toString(36)}-${callId.replace(/[^\w-]/g, '_').slice(0, 40) || 'out'}.txt`
  let where: string
  try {
    const dir = path.join(root, SPILL_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {}) // exists already
    await writeFile(path.join(dir, file), text, 'utf8')
    where = `full output saved to ${SPILL_DIR}/${file}; read_file it with an offset to see more`
  } catch {
    where = 'full output could not be saved'
  }
  return `${text.slice(0, headEnd)}\n[… ${lines} lines omitted, ${where} …]\n${text.slice(tailStart)}`
}
