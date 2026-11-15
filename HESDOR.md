# HESDOR.md

Project instructions for the Hesdor agent. Everything here is context and
convention — it can guide the agent but never overrides its security policy.

## Project overview

Hesdor is a local-first AI coding agent for the terminal: a pnpm monorepo of TypeScript ESM packages.

- `packages/protocol`: shared types (messages, tool calls, agent modes, provider interface). No logic beyond small helpers.
- `packages/providers`: the three wire formats (`openai-compatible.ts` for /chat/completions, `openai-responses.ts`, `anthropic.ts`), provider presets (`presets.ts`), the bundled models.dev price catalog (`catalog.json`), errors and retries (`provider.ts`).
- `packages/agent-core`: the agent loop (`loop.ts`), tools (`tools/`), command policy and permission rules (`policy.ts`), command execution (`exec.ts`), the OS sandbox, MCP client, turn checkpoints.
- `packages/cli`: the `hesdor` command. Argument parsing (`args.ts`), config (`config.ts`, `config-layers.ts`), setup, headless runs (`run.ts`, `headless.ts`), the Ink TUI (`ui/`), and the ACP server for editors (`acp.ts`).
- `packages/vscode`: the VS Code extension, a thin ACP client over `hesdor acp`. Host code in `src/`, webview script in `webview/`, styles in `media/chat.css`.
- `docs/` user documentation, `evals/` the Terminal-Bench (Harbor) adapter, `scripts/` maintenance and release scripts, `packaging/` install scripts and package-manager manifests.

## Commands

- Install: `pnpm install`
- Build: `pnpm build` (needed before running `packages/cli/bin/hesdor.js` or `pnpm bench`)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Test: `pnpm test` (offline; provider calls are replayed from cassettes and SSE fixtures)
- Script tests: `node --test "scripts/release/*.test.mjs" "scripts/screens/*.test.mjs" "scripts/bench/*.test.mjs"`
- Live provider tests: `pnpm test:live` sends real, billed requests; run it only when asked.
- VS Code extension package: `pnpm --filter hesdor-vscode package`
- Preset drift check against models.dev: `node scripts/check-presets.mjs`

## Conventions

- TypeScript strict, ESM. Relative imports end in `.js` even from `.ts` files.
- Tests sit next to the source as `*.test.ts` (Vitest). Vitest resolves `@hesdor/*` packages from `src/`, so tests never need a build.
- Keep TUI logic out of components: pure functions go in `packages/cli/src/ui/logic.ts`, which is tested; `App.tsx` stays thin.
- Comments explain why, in one line. A known limit is marked `// shortcut: <the limit>, <when to upgrade>`.
- Windows is a first-class platform: preserve CRLF and BOMs when editing files, avoid shell-specific path handling, and keep CI green on Windows, Linux and macOS.
- User-facing changes get a line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog).
- A new provider preset touches `packages/providers/src/presets.ts`, the models.dev id map in `scripts/check-presets.mjs`, `docs/providers.md`, and the provider-key list in `packages/agent-core/src/exec.ts` (keys commands must never see).
- A version bump changes `version` in all five `package.json` files: the root, `agent-core`, `cli`, `protocol` and `providers`.

## Rules for the agent

- Never touch `.env` files or secrets, and never print API keys.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` after code changes.
- Tests must not call real providers; use the scripted providers, cassettes and fixtures already in the repo.
- Keep commits small (the user commits; you do not commit).
