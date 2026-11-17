import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectInstall, isNewer, readUpdateCache, refreshUpdateCache, updateCheckDisabled, updateNotice, upgradeCommand } from './update.js'

beforeEach(() => {
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'hesdor-home-'))
})

const DAY = 24 * 60 * 60 * 1000
const okFetch = (version: string) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
const opts = { env: {}, version: '0.1.0' }
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('update check', () => {
  it('shows nothing on first start, fetches in the background, notifies on the next start', async () => {
    const fetchMock = okFetch('0.2.0')
    expect(await updateNotice({}, { ...opts, fetch: fetchMock, now: 1_000 })).toBeNull()
    // Wait for the background refresh to land in the cache; a fixed sleep raced it on slow CI runners.
    await vi.waitFor(async () => expect((await readUpdateCache())?.latest).toBe('0.2.0'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/ksjxixi-gif/Hesdor/releases/latest')
    expect(Object.keys(init ?? {})).toEqual(['signal']) // a plain GET: no headers, no body
    expect(await updateNotice({}, { ...opts, fetch: fetchMock, now: 2_000 })).toContain('0.2.0 is available')
    expect(fetchMock).toHaveBeenCalledTimes(1) // cached for 24 h
    await updateNotice({}, { ...opts, fetch: fetchMock, now: 1_000 + DAY })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('stays quiet when up to date', async () => {
    await refreshUpdateCache(okFetch('0.1.0'), 1)
    expect(await updateNotice({}, { ...opts, fetch: okFetch('0.1.0'), now: 2 })).toBeNull()
  })

  it('records a failed or timed-out fetch without throwing', async () => {
    // A server that never answers: the real 2 s AbortSignal.timeout must end the request.
    const hanging = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    ) as unknown as typeof fetch
    const started = Date.now()
    await refreshUpdateCache(hanging, 5)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(await readUpdateCache()).toEqual({ checkedAt: 5 })
  })

  it('honors opt-outs and never fetches when off', async () => {
    expect(updateCheckDisabled({}, { HESDOR_NO_UPDATE_CHECK: '1' }, '0.1.0')).toMatch(/HESDOR_NO_UPDATE_CHECK/)
    expect(updateCheckDisabled({ updateCheck: false }, {}, '0.1.0')).toMatch(/config/)
    expect(updateCheckDisabled({}, { CI: 'true' }, '0.1.0')).toMatch(/CI/)
    expect(updateCheckDisabled({}, { CI: '0' }, '0.1.0')).toBeNull()
    expect(updateCheckDisabled({}, {}, '0.0.0-dev')).toMatch(/development/)
    const fetchMock = okFetch('9.9.9')
    await updateNotice({ updateCheck: false }, { ...opts, fetch: fetchMock })
    await updateNotice({}, { env: { CI: '1' }, version: '0.1.0', fetch: fetchMock })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('compares versions numerically', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('upgrade command', () => {
  it('detects the install method from the script path', () => {
    expect(detectInstall('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@dean_overlord\\hesdor\\bin\\hesdor.js')).toBe('npm')
    expect(detectInstall('/usr/local/lib/node_modules/@dean_overlord/hesdor/bin/hesdor.js')).toBe('npm')
    expect(detectInstall('C:/tools/hesdor.exe', true)).toBe('binary')
    expect(detectInstall('/home/me/.local/share/pnpm/global/5/.pnpm/@dean_overlord+hesdor@0.1.0/node_modules/@dean_overlord/hesdor/bin/hesdor.js')).toBe('pnpm')
    expect(detectInstall('/home/me/.npm/_npx/1a2b3c/node_modules/@dean_overlord/hesdor/bin/hesdor.js')).toBe('npx')
    expect(detectInstall('/src/Hesdor/packages/cli/bin/hesdor.js')).toBe('source')
    expect(upgradeCommand('binary', 'win32')).toBe('irm https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.ps1 | iex')
    expect(upgradeCommand('binary', 'linux')).toBe('curl -fsSL https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.sh | sh')
    // npm is frozen at 0.1.0: never suggest `npm install -g ...@latest`, which would downgrade
    expect(upgradeCommand('npm', 'darwin')).toMatch(/^curl .*install\.sh \| sh .*remove the npm copy/)
    expect(upgradeCommand('npx', 'win32')).toMatch(/^irm .*install\.ps1 \| iex .*remove the npx copy/)
  })
})
