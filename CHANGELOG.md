# Changelog

All notable changes to Hesdor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versions refer to
the published CLI package (`packages/cli`).

## [Unreleased]

### Security

- `.hesdor/config.json` is part of the workspace trust fingerprint and can only set mode, maxTokens, effort and model. Managed settings can lock providers, force deny rules and disable the guardian, web tools, MCP and the update check.
- ChatGPT sign-in tokens never leave api.openai.com: other base URLs are refused, redirects are not followed with a token, and the ID token is validated (signature, issuer, audience, nonce).
- `web_fetch` refuses loopback, private, CGNAT, link-local, cloud-metadata, multicast and reserved addresses (IPv4, IPv6 and IPv4-mapped), re-checks DNS on every redirect and connects only to the checked address, and strips zero-width, bidi and Unicode tag characters. After web or MCP output, approval prompts say "after reading web/MCP content".
- MCP tool annotations set a tool's risk only for servers in your own `mcp.json`; a repository's servers stay network-risk. MCP OAuth tokens are stored per server URL with mode 0600 and never sent to another origin.
- Search API keys are stripped from child processes, and headless runs warn under `pull_request_target`.
- **Permission rules:** `permissions: { allow, ask, deny }` in your config.json for command prefixes and `{ "write": glob }` file rules; a project's `.hesdor/permissions.json` can only add ask and deny rules. Deny beats ask beats allow, and built-in risky commands are only relaxed by a user rule naming exactly that command. In the TUI, commands outside a small safe list ask first and "always allow" saves a rule. Headless runs without `--yes` behave as before. `hesdor policy check <command>` shows the decision and the rule behind it.
- Hesdor's own git calls ignore `core.fsmonitor` and hooks, and `git_diff` ignores external diff and textconv drivers.
- Headless runs refuse to run as root unless `--allow-root` is passed.
- `.hesdor/hooks.json` is part of the workspace trust fingerprint, and input rewritten by a plugin or hook is validated against the tool schema again.
- **Workspace trust gate.** A repository's `.hesdor/plugins/*.js` and `.hesdor/mcp.json` run code, so they load only after you approve them once per repository. The approval is pinned to the files' content and asks again when they change. Headless runs never prompt: they load project code only with a stored approval or `--trust-workspace`. `hesdor doctor` no longer imports project plugins and reports untrusted ones.
- **Command policy asks before running code it cannot inspect:** shells (`bash`, `sh`, `cmd`, `powershell`, `pwsh`, `wsl`, ...), inline code (`node -e`, `python -c`, `ruby -e`, `php -r`, ...), wrappers (`npx`, `xargs`, `env`, `timeout`, ...), `npm|pnpm|yarn|bun dlx/exec/x`, and `find -exec/-delete`. Headless runs block these unless `--yes` is passed.
- **Risky git commands need approval:** `reset --hard/--keep/--merge`, `clean -f`, `checkout -- .`/`--force`, `restore`, `stash drop/clear`, `branch -D`, force pushes, `push --delete`/`--mirror`/`+refspec`, `reflog expire/delete`, `filter-repo`, `update-ref -d`, `git config` writes, and global options that can run programs or target another repository (`-c`, `--exec-path`, `--git-dir`, `--work-tree`, `--config-env`).
- **Windows:** arguments containing cmd.exe metacharacters (`& | < > ^ % ! "` or line breaks) are refused instead of quoted, so one command can never become two.
- **Symlink and junction containment:** filesystem tools resolve real paths, so a link inside the repository that points outside it is rejected.
- **`.git` write guard:** the agent can never write or delete files inside `.git` (hooks there run on your next commit), whatever the approval.
- **Provider API keys are stripped from the environment** of commands and MCP servers the agent starts (every preset key plus any `HESDOR_*` variable).
- **Owner-only files:** credentials and saved session transcripts are written with mode `0600` in a `0700` directory.
- **Config writes are atomic and fail loudly:** config, credentials and sessions are written through a temp file and rename; a malformed JSON config now stops with an error instead of being treated as empty and overwritten on the next save.
- **Per-provider key variables for custom providers:** a saved custom provider reads `HESDOR_<PROVIDER_ID>_API_KEY`, so a key meant for one gateway is never sent to another. `HESDOR_CUSTOM_API_KEY` still works for one-off `--base-url` runs.

### Changed

- The diff review is full height and scrollable (arrows, PgUp/PgDn, Home/End) with old and new line numbers, `@@` hunk headers, and visible tabs and trailing spaces on changed lines.
- The transcript scrolls by wrapped lines, so long messages can be read in full.
- Tool results are plain text instead of JSON: `read_file` shows line numbers, and long outputs keep the first 40% and last 60% with the full text saved to `.hesdor/out/`.
- The system prompt keeps a byte-stable prefix and sends the same name-sorted tool list in every mode, so prompt caching hits more often.
- The default step budget is 100. When it runs out, the model gets one final call to summarize. Repeating the same tool call 3 times, or editing one file 5 times, is refused as a loop.
- **Provider presets updated against live docs (2026-11-06):** current default models for anthropic (`claude-sonnet-5-5`), openrouter, groq, deepseek (`deepseek-flash`, new base URL), mistral, together (new `api.together.ai` host), fireworks, xai, opencode-zen and opencode-go (new endpoints), gemini (`gemini-3.8-flash`), cerebras, sambanova, nvidia, cohere (new compatibility URL) and deepinfra. Gemini also reads `GOOGLE_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`; DeepInfra also reads `DEEPINFRA_API_KEY`. OpenRouter requests carry app-attribution headers.
- **Removed the `perplexity` preset:** Perplexity replaced Sonar Chat Completions with its Agent API, so the preset no longer worked. A saved `provider: perplexity` now reports an unknown provider.
- Finish reasons are reported honestly: an answer cut off by the output token limit is flagged as truncated, and a tool call cut off mid-arguments is not run; the model is told to split the work.
- The system prompt says `run_command` does not use a shell (no `&&`, pipes or redirects), ends with an environment block (OS, shell, Node version, date), and labels the git status as a snapshot from session start.
- Approval prompts ignore keystrokes for 300 ms after they open, so type-ahead cannot answer them. Enter no longer approves a change, and "always allow" moved from `a` to Shift+A.
- Ctrl+C aborts the running agent turn (commands and pending writes) before exiting the UI.
- Only a keyword in first position selects a command: `hesdor fix the init script` is a prompt, not `init`. `--` ends option parsing.

### Fixed

- The TUI transcript no longer overlaps open pickers, approval prompts or forms.
- In the TUI, `/provider`, `/mode`, `/effort` and Tab respect values locked by managed settings.
- The TUI diff no longer freezes on large files: common lines are trimmed and the rest is diffed with a bounded Myers algorithm (a 20,000-line file now takes milliseconds instead of 30 seconds and 3.9 GB).
- An in-session `/provider` or `/model` choice now wins over `-p`/`-m`; switching provider uses that provider's saved model, ids are validated, and the model picker works for custom providers with `apiKeyCommand` or `authHeader`.
- Enter runs the highlighted palette entry; read-only slash commands work during a run and other commands say why they are unavailable; the palette updates after `/reload`.
- `hesdor setup`: Ctrl+C or Ctrl+D while typing a key saves nothing, and a stored key is kept when you press Enter.
- `/undo` and `/redo` restore binary files byte for byte.
- OpenAI-style providers report cached prompt tokens and OpenRouter's own cost, so cache reads are no longer priced as fresh input.
- A compacted headless run is saved as a new session linked to the old one, instead of overwriting the resumed transcript.
- The default model is remembered per provider, so switching provider never sends another provider's model id; `hesdor model <id>` saves for the current provider and rejects ids with spaces. Model listing has a timeout, follows Anthropic pagination and hides non-chat models. Anthropic-compatible gateways get no empty `x-api-key` header, and errors name the real provider.
- `apply_patch` falls back to a whitespace-tolerant match when exactly one location fits, quotes the nearest lines when nothing matches, and refuses to patch a file that changed on disk since the agent read it.
- `read_file` refuses huge files, recognizes binary files and slices by bytes, returning an offset to continue from.
- Search: ripgrep paths are repo-relative, invalid regexes fall back to literal search, `.hesdorignore` is honored by ripgrep, the ignore matcher handles anchored directories, `[!x]` and escapes, and the fallback search can no longer freeze on a catastrophic regex.
- The explore subagent obeys plugin denies, reports its token usage and progress, and keeps its own tool state.
- A prompt queued in the TUI runs with the mode and model current when it starts; `/compact` can be cancelled with Esc.
- OpenAI and Azure OpenAI requests send `max_completion_tokens`, which reasoning models require, instead of `max_tokens`.
- Windows line endings: `apply_patch` and `write_file` keep a file's CRLF line endings and UTF-8 BOM, so multi-line edits match and files are not rewritten line by line.
- A stream that ends without its terminator, or contains only unparseable data, is an error instead of a silent success.
- Agent loop: an empty assistant turn is no longer stored (it made every later request invalid), and cancelling during a batch of tool calls records a result for each skipped call so the session can be resumed.
- Anthropic provider: empty assistant turns from older sessions are skipped instead of sent as an empty text block.
- Commands: a grandchild process holding the output pipes no longer hangs a finished command; the process tree is killed even after the direct child exited; a command cancelled before it starts never spawns; stdin is closed for agent commands.
- MCP: server-initiated requests are answered with their own id (`ping`) or a "method not supported" error, instead of a reply with a fresh id.
- `apply_patch` inserts replacement text literally (`$&`, `$'`, `$$` are no longer expanded).
- `/reload` picks up edited plugins instead of the cached module.
- Undo, redo, reload and key-saving failures in the UI are shown as errors instead of crashing; a crash restores the terminal from the alternate screen.

### Added

- **TUI:** `/goal <condition>`, `/config` (effective settings and where each comes from), `/mcp` (servers, connection and login state, with login from the list), an MCP elicitation form with a review step, `@image.png` attachments, a "Using ChatGPT plan · Manage usage" header line, and status lines for model fallback and guardian decisions. `/compact` uses the `small` role when one is set.
- **Use your ChatGPT plan:** `hesdor login chatgpt` (or `hesdor setup` → Continue with ChatGPT) signs in through OpenAI's official ChatGPT plan usage for open-source apps; `--provider chatgpt` then bills your ChatGPT plan, never paid API usage. `hesdor logout chatgpt` revokes the tokens.
- **`qwen-coding-plan` preset**, interactive only as the plan's terms require (headless runs refuse it). The README lists which subscriptions are supported and why Claude Pro/Max and Google sign-in are not.
- **Config layers** (managed > flags > env > project > user), `hesdor config get|set|list`, managed settings for administrators, and a JSON Schema at `docs/config.schema.json`.
- **Goal mode:** `hesdor run --goal "<condition>"` repeats turns until an evaluator model judges the condition met (exit 0) or impossible or out of turns (exit 6, `--max-goal-turns`).
- **Model roles:** `roles: { small, subagent, oracle, fallback }` in config.json, each a `provider/model` using that provider's own key. `small` writes compaction summaries, `subagent` runs explore and task agents, `oracle` adds a read-only second-opinion tool, and `fallback` models take over for the rest of a turn when the main model is overloaded, rate limited after retries, out of quota or unreachable. Every role is priced and counts toward the budget; `hesdor doctor` checks them.
- **Guardian auto-review (opt-in):** `guardian: { enabled: true, model? }` lets a cheap model approve commands and edits no permission rule settles. A deny, error or timeout asks you instead, deny rules are never overridden, and it turns off after 3 denials in a row or 10 in 50. Headless runs use it only with `--guardian`.
- **`web_fetch` and `web_search`:** pages become readable text framed as untrusted content; fetch asks per URL unless a `{ "fetch": "host-glob" }` allow rule matches; search uses Brave, Tavily, Exa or SearXNG when configured.
- **Image input:** `--image <file>` and `@image.png` mentions in headless prompts; `read_file` shows images to vision models; Anthropic, Chat Completions and Responses wire formats are supported, and text-only models get a note instead of a failed request.
- **Remote MCP with OAuth** (2026-07-28 spec: protected resource metadata, PKCE, resource indicators, issuer check), `hesdor mcp list|add|login|logout`, MCP prompts as `/mcp__<server>__<prompt>`, the read-only `mcp_read_resource` tool, and elicitation forms (declined in headless runs).
- **`hesdor review`:** a read-only review of a branch or of uncommitted changes with P0–P3 findings, Markdown or JSON output, and exit code 5 for findings at or above `--severity`. A composite GitHub Action (`action.yml`) posts and updates one PR comment, with the provider key and comment permission in separate jobs.
- **`--worktree[=name]`** for run, plan and ask: works in `.hesdor/worktrees/<name>` on branch `hesdor/<name>`.
- **`hesdor export`** (md, html, json, `--redact`) and **`hesdor import claude|codex`**. Imported calls to tools Hesdor lacks become plain text so the session can be resumed with any provider.
- **Update check:** notify-only, at most daily, interactive runs only, with no identifying data; off with `HESDOR_NO_UPDATE_CHECK=1`, `updateCheck: false` or in CI. `hesdor upgrade` prints the right upgrade command, and `hesdor doctor` reports "Telemetry: none".
- **TUI:** `/rewind` (files, chat or both, with an undo of the last rewind), `/effort low|medium|high|default`, `/status`, a footer with context use, session cost and cache hit rate, and `--max-budget-usd` in interactive mode. Hook notices, skipped checkpoints and compactions are shown as status lines.
- Shift+A on a command approval saves a permanent allow rule for exactly that command.
- **Automatic compaction:** old tool outputs are pruned, then older turns are summarized, before the context window overflows; a context-overflow error triggers one compaction and a retry.
- **Turn checkpoints and `/rewind`:** each turn snapshots the workspace into a shadow Git repository in your config directory, covering shell-command edits and binary files. Rewind restores files, the conversation or both, and warns about files you edited by hand since.
- **Command hooks** in the Claude Code format (`.hesdor/hooks.json`, which needs workspace trust, and `hooks.json` in the user config dir): PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop and SessionStart. JS plugin hooks share the same dispatcher, and both apply inside subagents.
- **Markdown subagents** in `.hesdor/agents/`, `.claude/agents/` and the user config `agents/` dir, run by a new `task` tool. Plan and ask modes cannot escalate through an agent with write or execute tools.
- **`hesdor acp`:** an Agent Client Protocol (v1) server on stdio for Zed, JetBrains, Neovim and Emacs. It streams messages, reasoning, tool calls and diffs, asks for approvals in the editor, and supports build/plan/ask modes, cancel and session loading.
- **Model catalog and cost tracking:** a bundled models.dev snapshot (context limits, prices including cache tokens, capabilities). Every request is priced, subagents included, and headless results carry `cost_usd`. **`--max-budget-usd <n>`** stops a run at the budget (exit code 4).
- **Regression evals:** replayed cassettes run the real loop and tools in `pnpm test`, SSE fixtures are re-split at random byte boundaries, `evals/` has a Harbor adapter for Terminal-Bench runs, and `pnpm bench` measures cold start and diff speed.
- **OpenAI Responses API** (`openai-responses` wire) with encrypted reasoning replay. The `openai` preset now uses it with `gpt-6.1-sol`, and `xai` with `grok-4.7`, because their current models only call tools over Responses. Custom providers and `hesdor setup` can choose it.
- **`--effort low|medium|high`** mapped per wire, **`--max-tokens <n>`** and a `maxTokens` config value; custom providers accept `extraBody`, `authHeader` (`x-api-key` or `bearer`), `apiKeyCommand` (an argv array run without a shell, cached about 50 minutes) and `includeUsage`.
- **New presets:** moonshot, kimi-code, zai, qwen, minimax, stepfun, vercel, requesty, nebius, novita, baseten, chutes, bedrock, azure-claude, azure-openai, and local litellm, llamacpp, vllm and jan.
- **Proxy support:** `HTTPS_PROXY`/`HTTP_PROXY` are honored on Node 24.14+ (Node 22.21+ needs `NODE_USE_ENV_PROXY=1`); `NODE_EXTRA_CA_CERTS` and `NODE_USE_SYSTEM_CA` are documented and shown by `hesdor doctor`.
- **`hesdor auth list`** and **`hesdor auth logout <provider>`**.
- **Headless scripting:** `--output-format text|json|stream-json` (stream-json emits an init event, every run event and a result; json emits one result object), prompt from stdin (`-` or piped input), `-o/--output <file>`, and documented exit codes: 0 completed, 1 failed, 2 max steps, 3 provider error, 130 cancelled.
- **Sessions:** headless runs are saved too; `-c/--continue` resumes the latest session and `-r/--resume <id>` a specific one (unique prefixes work), in both headless and interactive mode. `/clear` and `/compact` start a new session linked to the previous one instead of overwriting it, and a per-repository index makes the session list fast.
- **Runs outside a Git repository:** the current directory becomes the workspace and git features are skipped. The home directory, a filesystem root or a dotfiles repository at `~/.git` is refused unless `--allow-home` is passed.
- **Background jobs:** `run_command` with `background: true` starts dev servers and watchers; `job_output`, `job_list` and `job_stop` read and stop them, and every job's process tree is killed when Hesdor exits. `stop_command` is removed.
- **`find_files`** tool for glob patterns such as `src/**/*.test.ts`.
- **MCP** now uses the official TypeScript SDK client with protocol version negotiation (2026-07-28 and earlier servers), Streamable HTTP servers (`url` + `headers`), project `.mcp.json` (Claude Code format, behind the workspace trust gate), `${VAR}` expansion, `disabled: true`, per-server timeouts, parallel start and automatic reconnect after a server dies. Image, resource and structured results are no longer dropped.
- **Skills** are also discovered in `.agents/skills` and `.claude/skills` (project and user scope), follow the Agent Skills frontmatter rules, can be run as `/skill-name`, and `read_skill` can read a skill's bundled files.
- **Reasoning round-trip:** reasoning and thinking state (DeepSeek/GLM/Kimi `reasoning_content`, vLLM/OpenRouter `reasoning`, Gemini `extra_content`, Claude thinking blocks with signatures) is stored and sent back to the endpoint that produced it, which these models require during tool use. The UI shows a "thinking…" line.
- **Anthropic prompt caching:** cache breakpoints on the system prompt and the newest message; cache read and write tokens are counted in usage.
- **Retries:** rate limits, overloads, 5xx and dropped connections are retried up to 4 times with backoff that honors `Retry-After`, only before any output arrived. Provider errors are classified (auth, rate limit, quota, overloaded, context overflow, model not found, ...) and end with a hint on how to fix them.
- Project instructions fall back to `AGENTS.md`, then `CLAUDE.md`, when there is no `HESDOR.md` (cap raised to 32 KB).
- Weekly workflow that checks every preset's default model against models.dev.
- CI on Linux, Windows and macOS with Node 22 and 24: typecheck, lint, tests, build and a smoke test of the bundled CLI.
- Release workflow that publishes the CLI to npm through trusted publishing with provenance.
- MIT `LICENSE` file, also shipped in the npm package.
- `hesdor --version` reports the version from `packages/cli/package.json`, injected at build time.
- The npm tarball now contains only `bin/`, `dist/bundle.js`, `LICENSE` and `README.md`, and `prepack` builds every workspace package first.

## [0.1.0] - 2026-08-24

First public release of the Hesdor CLI (`@dean_overlord/hesdor`).

- Interactive Ink terminal UI plus headless `run`, `plan` and `ask` commands, with `plan`/`ask` enforced read-only by the runtime.
- Tools for listing, reading, searching, writing, patching and deleting files, running and stopping commands, git status/diff/log, and a read-only `explore` subagent.
- Diff review before writes, with undo and redo.
- OpenAI-compatible and native Anthropic providers with presets for many hosted and local endpoints, `hesdor setup` for saved providers and keys, and `hesdor doctor`.
- Project context from `HESDOR.md`, `.hesdorignore` and repository metadata.
- Extensions: custom slash commands, skills, plugins and MCP servers.

[Unreleased]: https://github.com/ksjxixi-gif/Hesdor/compare/9a4221a...HEAD
[0.1.0]: https://www.npmjs.com/package/@dean_overlord/hesdor/v/0.1.0
