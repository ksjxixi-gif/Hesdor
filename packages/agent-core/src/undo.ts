import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from './context.js'

/**
 * Restore the most recent snapshot taken before a write/patch/delete and
 * remove it from the stack. One call undoes one file mutation.
 */
export async function undoLastChange(ctx: ToolContext): Promise<{ undone: boolean; path?: string }> {
  const snapshot = ctx.state.snapshots.pop()
  if (!snapshot) return { undone: false }

  if (snapshot.content === null) {
    // The file did not exist before — delete it again.
    await unlink(snapshot.path).catch(() => {})
    ctx.emit({ type: 'file.changed', path: rel(ctx.root, snapshot.path), op: 'delete' })
  } else {
    await mkdir(path.dirname(snapshot.path), { recursive: true })
    await writeFile(snapshot.path, snapshot.content, 'utf8')
    ctx.emit({ type: 'file.changed', path: rel(ctx.root, snapshot.path), op: 'write' })
  }
  return { undone: true, path: rel(ctx.root, snapshot.path) }
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}
