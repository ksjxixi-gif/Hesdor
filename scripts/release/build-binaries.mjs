#!/usr/bin/env node
// Builds a standalone `hesdor` binary for the platform this runs on, as a Node.js single executable
// application (SEA), and packs it with LICENSE into dist/release/:
//   hesdor-win-x64.zip, hesdor-linux-x64.tar.gz, hesdor-linux-arm64.tar.gz, hesdor-macos-arm64.tar.gz, hesdor-macos-x64.tar.gz
// Run `pnpm build` first. Needs Node >= 25.5 (`node --build-sea`); the binary embeds the running node.
// There is no cross-building: a macOS binary must be re-signed on macOS, so CI runs this once per OS/arch.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI_DIR = path.join(ROOT, 'packages/cli')
const OUT = path.join(ROOT, 'dist/release')
const WORK = path.join(OUT, 'work')

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 25 || (major === 25 && minor < 5)) throw new Error(`node --build-sea needs Node >= 25.5, this is ${process.version}`)
const entry = path.join(CLI_DIR, 'dist/cli.js')
if (!existsSync(entry)) throw new Error('packages/cli/dist/cli.js is missing: run `pnpm build` first')

const os = { win32: 'win', linux: 'linux', darwin: 'macos' }[process.platform]
if (!os || !['x64', 'arm64'].includes(process.arch)) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)
const target = `${os}-${process.arch}`
const exe = os === 'win' ? 'hesdor.exe' : 'hesdor'
const { version } = JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'))

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// 1. One ESM file with everything inlined. The npm bundle keeps ink/react external; a binary has no node_modules.
const { build } = await import(pathToFileURL(createRequire(path.join(CLI_DIR, 'package.json')).resolve('esbuild')).href)
const bundle = path.join(WORK, 'hesdor.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm', // Ink's yoga-layout uses top-level await, so CommonJS is not an option
  target: 'node22',
  outfile: bundle,
  define: { __HESDOR_VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"' },
  // CommonJS deps (react) call require() for builtins; esbuild's ESM shim cannot, a real require can.
  banner: { js: "import { createRequire as __hesdorRequire } from 'node:module'; const require = __hesdorRequire(import.meta.url);" },
  plugins: [
    {
      // Ink loads react-devtools-core only when DEV=true; it is an optional peer that is not installed.
      name: 'stub-devtools',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}' }))
      },
    },
  ],
  logLevel: 'warning',
})

// 2. Inject it into a copy of this node binary. Code cache is off: it measured no faster on --version.
const binary = path.join(WORK, exe)
const config = path.join(WORK, 'sea.json')
writeFileSync(config, JSON.stringify({ main: bundle, output: binary, mainFormat: 'module', disableExperimentalSEAWarning: true }))
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' })
// Injection breaks node's own signature; Apple silicon refuses to run unsigned code, so sign ad hoc.
if (os === 'macos') execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' })

// 3. Archive the binary with the license. Windows' own bsdtar writes zip (Git's GNU tar on PATH cannot).
copyFileSync(path.join(ROOT, 'LICENSE'), path.join(WORK, 'LICENSE'))
const archive = path.join(OUT, `hesdor-${target}${os === 'win' ? '.zip' : '.tar.gz'}`)
rmSync(archive, { force: true })
if (os === 'win') execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', archive, '-C', WORK, exe, 'LICENSE'])
else execFileSync('tar', ['-czf', archive, '-C', WORK, exe, 'LICENSE'])

const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + ' MB'
console.log(`hesdor ${version} ${target}: ${path.relative(ROOT, binary)} (${mb(binary)}), ${path.relative(ROOT, archive)} (${mb(archive)})`)
