# Hesdor

Open-source, **local-first** AI software engineering CLI. Point it at a Git repository, give it a task, and Hesdor inspects code, edits files, runs commands and iterates until things work — using your choice of AI provider.

No hosted code execution or telemetry. Your code stays on your machine; prompts go to the model provider you configure, including optional Hesdor Cloud access.

## Install

Requires Node.js 22+.

```bash
git clone https://github.com/hesdor/hesdor && cd hesdor
pnpm install && pnpm build
pnpm --filter hesdor link --global

# Or install the published CLI (after the Hesdor packages are published):
npm i -g hesdor
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

To publish a release from this monorepo, run `pnpm build` and publish the workspace
packages with `pnpm -r publish --access public`. After that, users can install the
CLI with `npm i -g hesdor`.

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

`hesdor` (Hesdor Cloud) · `openai` · `openrouter` · `groq` · `deepseek` · `mistral` · `together` · `fireworks` · `xai` · `opencode-zen` · `opencode-go` · `gemini` · `cerebras` · `sambanova` · `perplexity` · `nvidia` · `huggingface` · `cohere` · `deepinfra` · `ollama` (local) · `lmstudio` (local) · `openai-compatible` (custom base URL)

Plus native Anthropic (`anthropic`) and `anthropic-compatible` gateways.

```bash
hesdor -p openrouter -m anthropic/claude-sonnet-4.5
hesdor -p ollama -m qwen2.5-coder:7b            # fully local
hesdor -p openai-compatible --base-url http://localhost:8080/v1
HESDOR_CUSTOM_API_KEY=... hesdor -p my-gateway --base-url https://example.com/v1
```

Run `hesdor setup` to save a preset or your own endpoint, format, model and API key in the user profile. Defaults persist in `%APPDATA%\hesdor\config.json` or `~/.config/hesdor/config.json`; credentials are kept separately in the profile and never inside a repository.

For an unknown endpoint, choose `custom` in setup and select `openai` or `anthropic` compatibility. For a one-off OpenAI-compatible endpoint, pass `-p <name> --base-url <url>` and set `HESDOR_CUSTOM_API_KEY` if it needs authentication. Custom Anthropic endpoints should use an API root such as `https://gateway.example.com`; Hesdor adds `/v1/messages`.

Hesdor Cloud pricing is available with `hesdor pricing`: Free ($0, hard limit), Starter ($5/month), Pro ($7/month), and Max ($10/month). Account billing and quota enforcement belong to the Hesdor API service, not the local CLI.

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
