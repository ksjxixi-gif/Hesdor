import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDefaultRegistry, stopAllJobs } from './index.js'
import type { ToolContext } from './context.js'

const root = mkdtempSync(path.join(tmpdir(), 'hesdor-jobs-'))
// An HTTP server that also starts a grandchild, so stopping must kill the whole tree.
writeFileSync(
  path.join(root, 'server.js'),
  `const http = require('http')
const { spawn } = require('child_process')
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
console.log('grandchild ' + g.pid)
const server = http.createServer((req, res) => { console.log(req.method + ' ' + req.url); res.end('ok') })
server.listen(0, '127.0.0.1', () => console.log('listening ' + server.address().port))
`,
)
writeFileSync(path.join(root, 'forever.js'), "setInterval(() => console.log('tick'), 200)\n")
writeFileSync(path.join(root, 'quick.js'), "console.log('done'); process.exitCode = 3\n")

const registry = createDefaultRegistry()
function makeCtx(approvalsEnabled = true): ToolContext {
  return {
    root,
    mode: 'build',
    model: 'test',
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: () => Promise.resolve(false),
    approvalsEnabled,
    state: { activeChild: null, snapshots: [], redo: [] },
  }
}
const run = (name: string, input: unknown, ctx: ToolContext) => registry.get(name)!.execute(input, ctx) as Promise<any>

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100))
  return !alive(pid)
}

afterAll(() => stopAllJobs())

describe('background jobs', () => {
  it('starts a server, reads new output, lists it and stops the whole tree', async () => {
    const ctx = makeCtx()
    const started = await run('run_command', { command: 'node server.js', background: true }, ctx)
    expect(started).toMatchObject({ job_id: 'job1', status: 'running', exitCode: null })
    const port = Number(/listening (\d+)/.exec(started.output)?.[1])
    const grandchild = Number(/grandchild (\d+)/.exec(started.output)?.[1])
    expect(port).toBeGreaterThan(0)

    expect(await (await fetch(`http://127.0.0.1:${port}/hello`)).text()).toBe('ok')
    const out = await run('job_output', { job_id: 'job1', wait_ms: 5000 }, ctx)
    expect(out.output).toBe('GET /hello') // only output not returned before
    expect((await run('job_output', { job_id: 'job1' }, ctx)).output).toBe('')

    const listed = await run('job_list', {}, ctx)
    expect(listed.jobs).toEqual([expect.objectContaining({ job_id: 'job1', status: 'running', command: 'node server.js' })])
    const pid = listed.jobs[0].pid as number

    const stopped = await run('job_stop', { job_id: 'job1' }, ctx)
    expect(stopped).toMatchObject({ stopped: true, status: 'exited' })
    expect(await gone(pid)).toBe(true)
    expect(await gone(grandchild)).toBe(true)
  }, 30_000)

  it('reports exit codes of jobs that finish on their own', async () => {
    const ctx = makeCtx()
    const res = await run('run_command', { command: 'node quick.js', background: true }, ctx)
    expect(res).toMatchObject({ status: 'exited', exitCode: 3, output: 'done' })
  }, 15_000)

  it('stopAllJobs kills jobs the host left running', async () => {
    const ctx = makeCtx()
    await run('run_command', { command: 'node forever.js', background: true }, ctx)
    const pid = ctx.state.jobs!.get('job1')!.pid!
    expect(alive(pid)).toBe(true)
    await stopAllJobs()
    expect(await gone(pid)).toBe(true)
  }, 15_000)

  it('applies the run_command policy to background jobs', async () => {
    const ctx = makeCtx(false)
    await expect(
      run('run_command', { command: 'node -e "setInterval(() => {}, 1000)"', background: true }, ctx),
    ).rejects.toThrow(/blocked \(DESTRUCTIVE\)/)
    expect(ctx.state.jobs?.size ?? 0).toBe(0)
    await expect(run('job_output', { job_id: 'job9' }, ctx)).rejects.toThrow(/no background job/)
  })

  it('registers the job tools instead of stop_command', () => {
    const names = registry.list().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['job_output', 'job_stop', 'job_list', 'find_files']))
    expect(names).not.toContain('stop_command')
    expect(registry.readOnly().list().map((t) => t.name)).not.toContain('job_stop')
  })
})
