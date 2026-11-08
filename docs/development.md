# Development

```bash
pnpm install
pnpm build       # all packages
pnpm test        # vitest across packages
pnpm lint        # oxlint
pnpm typecheck
pnpm bench       # cold start and diff speed
```

To use your build as the `hesdor` command:

```bash
pnpm --filter @dean_overlord/hesdor link --global
```

See [architecture.md](architecture.md) for the package layout and the flow of one turn.

## Tests and evals

`pnpm test` includes regression evals: replayed cassettes run the real loop and tools, and SSE fixtures are re-split at random byte boundaries (`pnpm test:replay` runs only those). `evals/` has a Harbor adapter for Terminal-Bench runs. CI runs typecheck, lint, tests, build and a smoke test of the bundled CLI on Linux, Windows and macOS with Node 22 and 24.

## Benchmarks

`scripts/bench/matrix.mjs` runs a Harbor matrix (Hesdor routing profiles, Hesdor with explicit models, Claude Code and Codex CLI on the same Terminal-Bench tasks) and reports pass@1, pass@k, pass^k with confidence intervals, and dollars per solved task. Without `--execute` it only prints the commands and a cost estimate. See [benchmarks.md](benchmarks.md) for the method and how to run it.

```bash
node scripts/bench/matrix.mjs evals/matrix/tb21-smoke.json   # dry run: commands + cost estimate
node --test scripts/bench                                    # aggregation math, command generation, SVG
```

## Screenshots

The images in the README and these docs are generated, not hand-drawn. `scripts/screens/` drives the built CLI against a scripted OpenAI-compatible server in a temporary git repository, with the config directory pointed at a temp folder, and converts the terminal output to SVG.

```bash
pnpm build
node scripts/screens/capture-headless.mjs   # headless run, doctor, policy check, --help
node scripts/screens/capture-tui.mjs        # TUI frames at 120x30
node --test scripts/screens                 # tests for the ANSI to SVG converter
```

`ansi-to-svg.mjs` is dependency-free and works on any captured ANSI text: `node scripts/screens/ansi-to-svg.mjs in.ans out.svg --cols 100 --title "my shot"`.

## Release

Releases are published by [`.github/workflows/release.yml`](../.github/workflows/release.yml): bump `version` in `packages/cli/package.json`, add its section to [CHANGELOG.md](../CHANGELOG.md), then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The workflow runs typecheck, lint and tests, publishes `@dean_overlord/hesdor` to npm through trusted publishing with provenance, and creates a GitHub release from the changelog. The installed command is `hesdor`.

The npm tarball contains only `bin/`, `dist/bundle.js` with its lazily loaded `dist/chunks/` (the build is code-split so `--version`, `--help`, doctor and headless runs never load Ink, the MCP SDK or the ACP SDK; the standalone binary is still one bundled file), `LICENSE` and `README.md`, and `prepack` builds every workspace package first.

## Distribution

Besides npm, every tagged release gets standalone binaries that need no Node.js install. They are Node.js [single executable applications](https://nodejs.org/api/single-executable-applications.html): `scripts/release/build-binaries.mjs` bundles the CLI with everything inlined (the npm bundle keeps `ink` and `react` external) and injects it into a copy of Node 26 with `node --build-sea`. The `binaries` job in `release.yml` builds each target on its own runner, smoke-tests it, and the `release-assets` job uploads the archives plus `SHA256SUMS` to the GitHub release:

| Asset | Runner |
| --- | --- |
| `hesdor-win-x64.zip` | `windows-latest` |
| `hesdor-linux-x64.tar.gz` | `ubuntu-latest` |
| `hesdor-linux-arm64.tar.gz` | `ubuntu-24.04-arm` |
| `hesdor-macos-arm64.tar.gz` | `macos-latest` |
| `hesdor-macos-x64.tar.gz` | `macos-15-intel` |

There is no cross-building, because a macOS binary has to be re-signed on macOS after injection (ad hoc for now). To build and check the binary for your own machine (Node >= 25.5):

```bash
pnpm build
node scripts/release/build-binaries.mjs                         # dist/release/hesdor-<target>.zip|.tar.gz
node scripts/release/smoke-binary.mjs dist/release/work/hesdor.exe   # --version, --help, doctor, headless run against a fake model
node --test scripts/release                                     # manifests, install.ps1 and install.sh against a fake local release
```

### Install scripts

`packaging/install.ps1` (Windows x64) and `packaging/install.sh` (Linux and macOS, x64 and arm64) download the archive and `SHA256SUMS` from the release, refuse to install on a checksum mismatch, and install to `%LOCALAPPDATA%\Programs\hesdor` (added to the user PATH) or `~/.local/bin`:

```powershell
irm https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/ksjxixi-gif/Hesdor/main/packaging/install.sh | sh
```

Options: `-Version`, `-InstallDir`, `-NoPath` for PowerShell; `HESDOR_VERSION` and `HESDOR_INSTALL_DIR` for sh.

### Package managers

`scripts/release/update-manifests.mjs` is the single source for the manifests in `packaging/`. After a release's binaries are uploaded, regenerate them from its `SHA256SUMS` and commit:

```bash
node scripts/release/update-manifests.mjs 0.2.0      # or --sums path/to/SHA256SUMS
```

The committed manifests carry placeholder (all-zero) hashes until the first release with binaries. Submission is manual for now:

- **Homebrew:** create the public repo `ksjxixi-gif/homebrew-tap` and copy `packaging/homebrew/hesdor.rb` to `Formula/hesdor.rb`. On a Mac, `brew install --formula ./Formula/hesdor.rb`, then `brew test hesdor` and `brew audit --strict --online hesdor`. Users run `brew install ksjxixi-gif/tap/hesdor`, and recent Homebrew may ask them to trust a third-party tap first. Copy the regenerated formula into the tap for each release.
- **Scoop:** create a bucket repo, for example `ksjxixi-gif/scoop-bucket` from [ScoopInstaller/BucketTemplate](https://github.com/ScoopInstaller/BucketTemplate), and add `packaging/scoop/hesdor.json` as `bucket/hesdor.json`. The template's Excavator workflow runs `checkver` daily; with `checkver: github` and `autoupdate` reading `SHA256SUMS`, new releases are picked up without manual edits. Users run `scoop bucket add hesdor https://github.com/ksjxixi-gif/scoop-bucket` then `scoop install hesdor/hesdor`.
- **winget:** check the manifests with `winget validate --manifest packaging/winget`, and optionally try them with `winget install --manifest packaging/winget` (needs `winget settings --enable LocalManifestFiles` as admin). For the first version, submit with `wingetcreate submit --token <classic PAT, public_repo> packaging/winget`, or use [Komac](https://github.com/russellbanks/Komac). Both open a PR against `microsoft/winget-pkgs` from your fork. For later versions use `wingetcreate update MohammadAbukhadija.Hesdor --version <v> --urls https://github.com/ksjxixi-gif/Hesdor/releases/download/v<v>/hesdor-win-x64.zip --submit`, or automate it with the `vedantmgoyal9/winget-releaser` action, which needs a classic PAT secret.

### Not done yet

- **Code signing.** The binaries are unsigned. Windows SmartScreen warns on first run, and Defender scans the new 100 MB exe, which makes the first start take about 10 s. Authenticode signing (an OV/EV certificate or Azure Trusted Signing) and Apple notarization (Developer ID, $99/year) both need paid accounts. When they exist, add `signtool sign /fd SHA256` and `codesign --options runtime` plus `xcrun notarytool submit` to the matrix before archiving.
- Windows arm64 (`windows-11-arm` runner) and Linux musl builds. The x64 Windows binary runs under emulation on arm64.
