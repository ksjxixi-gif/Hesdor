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

The npm tarball contains only `bin/`, `dist/bundle.js`, `LICENSE` and `README.md`, and `prepack` builds every workspace package first.
