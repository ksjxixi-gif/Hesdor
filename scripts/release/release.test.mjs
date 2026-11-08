// node --test scripts/release
// Manifest rendering, and the install scripts against a fake GitHub release served by node:http
// (download, checksum verification, refusal on mismatch). Installs go to temp dirs; PATH is never touched.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assetName, parseSums, renderManifests, TARGETS, WINGET_ID } from './update-manifests.mjs'

const PACKAGING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packaging')
/** Async: the fake release server runs in this process, so a sync spawn would deadlock it. */
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sumsFor = (hashes) => TARGETS.map((t, i) => `${hashes[i] ?? String(i).repeat(64)}  ${assetName(t)}`).join('\n') + '\n'

describe('update-manifests', () => {
  const hashes = TARGETS.map((_, i) => 'abcdef0123456789'.repeat(4).slice(i) + 'f'.repeat(i))
  const files = renderManifests('1.2.3', parseSums(sumsFor(hashes)))

  test('parseSums requires every target', () => {
    assert.throws(() => parseSums(`${'a'.repeat(64)}  hesdor-win-x64.zip\n`), /no entry for: hesdor-linux-x64/)
  })

  test('winget: three manifests at 1.12.0 with the zip URL and hash', () => {
    const installer = files[`winget/${WINGET_ID}.installer.yaml`]
    assert.match(installer, /^PackageVersion: 1\.2\.3$/m)
    assert.match(installer, /InstallerUrl: https:\/\/github\.com\/ksjxixi-gif\/Hesdor\/releases\/download\/v1\.2\.3\/hesdor-win-x64\.zip$/m)
    assert.match(installer, new RegExp(`InstallerSha256: ${hashes[0].toUpperCase()}$`, 'm'))
    assert.match(installer, /NestedInstallerType: portable/)
    for (const [file, type] of [['', 'version'], ['.installer', 'installer'], ['.locale.en-US', 'defaultLocale']]) {
      const yaml = files[`winget/${WINGET_ID}${file}.yaml`]
      assert.match(yaml, new RegExp(`^PackageIdentifier: ${WINGET_ID}$`, 'm'))
      assert.match(yaml, new RegExp(`^ManifestType: ${type}\nManifestVersion: 1\\.12\\.0\n$`, 'm'))
    }
  })

  test('scoop: pinned hash plus github checkver and SHA256SUMS autoupdate', () => {
    const scoop = JSON.parse(files['scoop/hesdor.json'])
    assert.equal(scoop.version, '1.2.3')
    assert.equal(scoop.architecture['64bit'].hash, hashes[0])
    assert.equal(scoop.checkver, 'github')
    assert.equal(scoop.autoupdate.architecture['64bit'].hash.url, '$baseurl/SHA256SUMS')
  })

  test('homebrew: one url and sha256 per macOS/Linux target', () => {
    const rb = files['homebrew/hesdor.rb']
    TARGETS.slice(1).forEach((t, i) => {
      assert.ok(rb.includes(`/v1.2.3/${assetName(t)}"\n      sha256 "${hashes[i + 1]}"`), t)
    })
  })

  test('packaging/ matches what the script renders for its version', () => {
    const scoop = JSON.parse(readFileSync(path.join(PACKAGING, 'scoop/hesdor.json'), 'utf8'))
    const sums = sumsFor(TARGETS.map((t) => (t === 'win-x64' ? scoop.architecture['64bit'].hash : undefined)))
    // Only the Windows hash is recoverable from scoop; compare the files that use nothing else.
    const rendered = renderManifests(scoop.version, parseSums(sums))
    for (const file of [`winget/${WINGET_ID}.yaml`, `winget/${WINGET_ID}.installer.yaml`, `winget/${WINGET_ID}.locale.en-US.yaml`, 'scoop/hesdor.json']) {
      assert.equal(readFileSync(path.join(PACKAGING, file), 'utf8'), rendered[file], file)
    }
  })
})

/** Serves `dir` as both /download/v<version>/<file> and /latest/download/<file>. */
async function fakeRelease(dir, version) {
  const server = http.createServer((req, res) => {
    const m = new RegExp(`^/(?:download/v${version.replaceAll('.', '\\.')}|latest/download)/([\\w.-]+)$`).exec(req.url)
    const file = m && path.join(dir, m[1])
    if (!file || !existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200).end(readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

/** A release dir holding `archive` (made by tar from a fake binary) and a SHA256SUMS for it. */
function makeRelease(tmp, archive, exe, tarArgs, tarCmd = 'tar') {
  const dir = path.join(tmp, 'release')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, exe), 'fake hesdor binary\n')
  writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n')
  // Relative names and cwd: GNU tar reads "C:\..." as a remote host.
  execFileSync(tarCmd, [...tarArgs, archive, exe, 'LICENSE'], { cwd: dir })
  rmSync(path.join(dir, exe))
  const good = `${sha256(readFileSync(path.join(dir, archive)))}  ${archive}\n`
  writeFileSync(path.join(dir, 'SHA256SUMS'), good)
  return { dir, good, bad: `${'0'.repeat(64)}  ${archive}\n` }
}

describe('install.ps1', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  let tmp, rel, server
  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'hesdor-ps1-'))
    rel = makeRelease(tmp, 'hesdor-win-x64.zip', 'hesdor.exe', ['-a', '-cf'], path.join(process.env.SystemRoot, 'System32', 'tar.exe'))
    server = await fakeRelease(rel.dir, '9.9.9')
  })
  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
  })
  // Windows PowerShell 5.1, the shell `irm ... | iex` users have by default. Started from pwsh 7 (CI's
  // default shell), it inherits pwsh's PSModulePath and can't load its own modules, so drop it.
  const { PSModulePath: _pwshModules, ...cleanEnv } = process.env
  const install = (dir, version) =>
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PACKAGING, 'install.ps1'), '-Version', version, '-InstallDir', dir, '-BaseUrl', server.url, '-NoPath'], { env: cleanEnv })

  test('installs a pinned version and latest when the checksum matches', async () => {
    for (const version of ['v9.9.9', 'latest']) {
      writeFileSync(path.join(rel.dir, 'SHA256SUMS'), rel.good)
      const dir = path.join(tmp, `ok-${version}`)
      const r = await install(dir, version)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(readFileSync(path.join(dir, 'hesdor.exe'), 'utf8'), 'fake hesdor binary\n')
    }
  })

  test('refuses a checksum mismatch and installs nothing', async () => {
    writeFileSync(path.join(rel.dir, 'SHA256SUMS'), rel.bad)
    const dir = path.join(tmp, 'bad')
    const r = await install(dir, '9.9.9')
    assert.notEqual(r.status, 0)
    assert.match(r.stdout + r.stderr, /Checksum mismatch/)
    assert.ok(!existsSync(path.join(dir, 'hesdor.exe')))
  })

  test('fails on a missing release', async () => {
    writeFileSync(path.join(rel.dir, 'SHA256SUMS'), rel.good)
    const r = await install(path.join(tmp, 'missing'), '1.0.0')
    assert.notEqual(r.status, 0)
  })
})

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0
describe('install.sh', { skip: !hasSh && 'no sh' }, () => {
  let tmp, rel, server, env
  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'hesdor-sh-'))
    rel = makeRelease(tmp, 'hesdor-linux-x64.tar.gz', 'hesdor', ['-czf'])
    server = await fakeRelease(rel.dir, '9.9.9')
    // Pretend to be Linux x64 whatever the host is, so the test runs on Windows (Git sh) and macOS too.
    const bin = path.join(tmp, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n')
    chmodSync(path.join(bin, 'uname'), 0o755)
    env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HESDOR_BASE_URL: server.url }
  })
  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
  })
  const install = (dir, version) =>
    run('sh', [path.join(PACKAGING, 'install.sh').replaceAll('\\', '/')], { env: { ...env, HESDOR_VERSION: version, HESDOR_INSTALL_DIR: dir.replaceAll('\\', '/') } })

  test('installs when the checksum matches', async () => {
    writeFileSync(path.join(rel.dir, 'SHA256SUMS'), rel.good)
    const dir = path.join(tmp, 'ok')
    const r = await install(dir, '9.9.9')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(path.join(dir, 'hesdor'), 'utf8'), 'fake hesdor binary\n')
  })

  test('refuses a checksum mismatch and installs nothing', async () => {
    writeFileSync(path.join(rel.dir, 'SHA256SUMS'), rel.bad)
    const dir = path.join(tmp, 'bad')
    const r = await install(dir, 'latest')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /checksum mismatch/)
    assert.ok(!existsSync(path.join(dir, 'hesdor')))
  })
})
