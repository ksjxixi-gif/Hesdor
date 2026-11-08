import path from 'node:path'
import { findGitRoot, listCheckpoints, pruneAllCheckpoints, pruneCheckpoints } from '@hesdor/agent-core'

/** `hesdor checkpoints [list] | prune [--all]`. */
export async function runCheckpointsCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = findGitRoot(cwd) ?? path.resolve(cwd)
  const [sub = 'list', ...rest] = args
  try {
    if (sub === 'list' && rest.length === 0) {
      const all = await listCheckpoints(root)
      if (all.length === 0) console.log(`no checkpoints for ${root}`)
      for (const c of all) {
        console.log(`${c.id.slice(0, 10)}  ${new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  session ${c.sessionId || '-'}  turn ${c.turnIndex}  ${c.prompt.replace(/\s+/g, ' ').slice(0, 60)}`)
      }
      return 0
    }
    if (sub === 'prune' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--all'))) {
      if (rest[0] === '--all') {
        const r = await pruneAllCheckpoints()
        console.log(`removed ${r.removed} checkpoint(s), kept ${r.kept}, in ${r.repos} workspace(s)`)
        for (const f of r.failed) console.error(`✗ ${f}`)
        return r.failed.length > 0 ? 1 : 0
      }
      const r = await pruneCheckpoints(root)
      console.log(`removed ${r.removed} checkpoint(s), kept ${r.kept} for ${root}`)
      return 0
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  console.error('usage: hesdor checkpoints [list] | prune [--all]')
  return 1
}
