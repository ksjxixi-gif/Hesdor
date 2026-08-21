# Hesdor

Open-source, **local-first** AI software engineering CLI. Point it at a Git repository, give it a task, and Hesdor inspects code, edits files, runs commands and iterates until things work — using your choice of AI provider.

No cloud service. No accounts, billing, telemetry or hosted sandboxes. Your code stays on your machine; prompts go straight to the model provider you configure.

## Install

Requires Node.js 22+.

```bash
git clone https://github.com/hesdor/hesdor && cd hesdor
pnpm install && pnpm build
cd packages/cli && npm link   # puts `hesdor` on your PATH
```

## Quick start

```bash
export OPENAI_API_KEY=sk-...     # or ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, ...
cd some-existing-project         # any git repository

hesdor init                      # create HESDOR.md + .hesdorignore starters
hesdor doctor                    # check node/git/ripgrep/provider/credentials

hesdor ask "What does this project do?"     # read-only Q&A
hesdor plan "Add rate limiting"             # read-only implementation plan
hesdor run "Fix the failing test"           # full agent: read + edit + execute
hesdor                                      # interactive TUI
```

## Commands

| Command | Mode | Capabilities |
|---|---|---|
| `hesdor` | build (switchable) | interactive Ink UI |
| `hesdor run "<prompt>"` | build | read + write + execute |
| `hesdor plan "<task>"` | plan | read-only |
| `hesdor ask "<question>"` | ask | read-only |

Modes are enforced by hard permission checks in the runtime, not by prompt instructions: in `plan`/`ask` the write/execute tools are refused no matter what the model asks for.

## Tools

`list_files`, `read_file`, `read_files`, `search_files` (ripgrep when installed, Node fallback otherwise), `write_file`, `apply_patch`, `delete_file`, `run_command`, `stop_command`, `git_status`, `git_diff`, `git_log`.

Filesystem tools are sandboxed to the repository root — traversal attempts (`../`, absolute external paths) are rejected before execution. Destructive and network-touching commands (`rm -rf`, `git reset --hard`, `sudo`, ...) require explicit approval and are blocked outright in headless runs unless you pass `--yes`.

## Providers

Any OpenAI-compatible endpoint works out of the box:

`openai` · `openrouter` · `groq` · `deepseek` · `mistral` · `together` · `fireworks` · `xai` · `ollama` (local) · `lmstudio` (local) · `openai-compatible` (custom base URL)

Plus native Anthropic (`anthropic`) and `anthropic-compatible` gateways.

```bash
hesdor -p openrouter -m anthropic/claude-sonnet-4.5
hesdor -p ollama -m qwen2.5-coder:7b            # fully local
hesdor -p openai-compatible --base-url http://localhost:8080/v1
```

Defaults persist in the global config (`hesdor config`: `%APPDATA%\hesdor\config.json` or `~/.config/hesdor/config.json`). API keys are read from environment variables only — never stored in files.

## Project context

Hesdor reads lightweight repo metadata (branch, status, manifests), your `HESDOR.md` instructions and `.hesdorignore` rules. It never loads the whole repository into model context.

## Development

```bash
pnpm install
pnpm build       # all packages
pnpm test        # vitest across packages
pnpm lint        # oxlint
pnpm typecheck
```

Monorepo layout:

- `packages/protocol` — stable shared types (events, messages, tools, modes)
- `packages/providers` — ModelProvider abstraction + OpenAI-compatible & Anthropic clients
- `packages/agent-core` — tools, permissions, repo discovery, agent loop (no UI deps)
- `packages/cli` — Ink terminal experience and command dispatch

MIT licensed.
