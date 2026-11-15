import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'

/** The editor operations the ACP fs methods need; extension.ts implements them with the vscode API. */
export interface EditorFiles {
  /** Absolute paths of the open workspace folders. */
  roots(): string[]
  /** Text of the document when it is open in the editor (unsaved edits included). */
  openText(file: string): string | undefined
  readDisk(file: string): Promise<string>
  /** Replace the whole file in the editor and save it (undo works); new files are created on disk. */
  write(file: string, content: string): Promise<void>
}

/** True when `file` is inside one of `roots` (case-insensitive on Windows). */
export function inside(roots: string[], file: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  return roots.some((root) => {
    const rel = path.relative(fold(root), fold(path.resolve(file)))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

// The agent is a local process the user chose, but a file request outside the workspace is refused anyway.
function checkPath(files: EditorFiles, file: string): void {
  if (!path.isAbsolute(file) || !inside(files.roots(), file)) {
    throw new Error(`refusing file access outside the workspace: ${file}`)
  }
}

/** fs/read_text_file: the open buffer if there is one, else the disk; `line` (1-based) and `limit` slice it. */
export async function readTextFile(files: EditorFiles, params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
  checkPath(files, params.path)
  const text = files.openText(params.path) ?? (await files.readDisk(params.path))
  if (params.line == null && params.limit == null) return { content: text }
  const start = Math.max(0, (params.line ?? 1) - 1)
  const lines = text.split('\n')
  return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join('\n') }
}

/** fs/write_text_file: through the editor, so the change can be undone there. */
export async function writeTextFile(files: EditorFiles, params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
  checkPath(files, params.path)
  await files.write(params.path, params.content)
  return {}
}
