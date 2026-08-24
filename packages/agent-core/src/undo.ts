import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolContext } from './context.js'

async function writeSnapshot(snapshot: { path: string; content: string | null }): Promise<void> {
  if (snapshot.content === null) {
    try {
      await unlink(snapshot.path)
    } catch (err) {
      if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'ENOENT') throw err
    }
  } else {
    await mkdir(path.dirname(snapshot.path), { recursive: true })
    await writeFile(snapshot.path, snapshot.content, 'utf8')
  }
}

/**
 * Restore the most recent snapshot taken before a write/patch/delete, pushing
 * the file's current state onto the redo stack. One call = one file mutation.
 */
export async function undoLastChange(ctx: ToolContext): Promise<{ undone: boolean; path?: string }> {
  const snapshot = ctx.state.snapshots.at(-1)
  if (!snapshot) return { undone: false }

  let current: string | null = null
  try {
    current = await readFile(snapshot.path, 'utf8')
  } catch {
    // file did not exist
  }
  await writeSnapshot(snapshot)
  ctx.state.snapshots.pop()
  ctx.state.redo.push({ path: snapshot.path, content: current })
  ctx.emit({ type: 'file.changed', path: rel(ctx.root, snapshot.path), op: snapshot.content === null ? 'delete' : 'write' })
  return { undone: true, path: rel(ctx.root, snapshot.path) }
}

/** Invert the last undo: restore the file state captured at undo time. */
export async function redoLastChange(ctx: ToolContext): Promise<{ redone: boolean; path?: string }> {
  const snapshot = ctx.state.redo.at(-1)
  if (!snapshot) return { redone: false }

  let current: string | null = null
  try {
    current = await readFile(snapshot.path, 'utf8')
  } catch {
    // file did not exist
  }
  await writeSnapshot(snapshot)
  ctx.state.redo.pop()
  ctx.state.snapshots.push({ path: snapshot.path, content: current })
  ctx.emit({ type: 'file.changed', path: rel(ctx.root, snapshot.path), op: snapshot.content === null ? 'delete' : 'write' })
  return { redone: true, path: rel(ctx.root, snapshot.path) }
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}
