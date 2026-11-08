# Tools

The model works through these tools. Every call is validated against the tool's schema and checked against the current mode and your permission rules before it runs (see [permissions.md](permissions.md)).

- Files: `list_files`, `find_files` (glob patterns such as `src/**/*.test.ts`), `read_file`, `read_files`, `search_files` (ripgrep when installed, Node fallback otherwise), `write_file`, `apply_patch`, `delete_file`
- Commands: `run_command` (with `background: true` for dev servers and watchers), `job_output`, `job_list`, `job_stop`, `run_tests`
- Git: `git_status`, `git_diff`, `git_log`
- `explore`: hands a repository-wide investigation to a read-only subagent
- `task`: runs one of your markdown subagents (see [hooks-and-agents.md](hooks-and-agents.md))
- `oracle`: asks a second model for a read-only opinion, when `roles.oracle` is set (see [roles.md](roles.md))
- `read_skill`: loads a skill's instructions (registered when skills exist)
- `todo_write`: the model's short plan for a multi-step task (below)
- `web_fetch` and `web_search` (below)
- MCP server tools, named `mcp_<server>_<tool>`, and `mcp_read_resource` (see [mcp.md](mcp.md))

## Editing

`apply_patch` edits by exact text replacement. It falls back to a whitespace-tolerant match when exactly one location fits, quotes the nearest lines when nothing matches, and refuses to patch a file that changed on disk since the agent read it. `apply_patch` and `write_file` keep a file's CRLF line endings and UTF-8 BOM.

OpenAI GPT-5 and later and Codex models (model ids starting with `gpt-5`, `gpt-6`, ... or containing `codex`, on any provider) get `apply_patch` in the V4A patch format they are trained on instead: one `input` string from `*** Begin Patch` to `*** End Patch` with `*** Add File:`, `*** Update File:` (optionally `*** Move to:`), `*** Delete File:`, `@@` context lines and ` `/`-`/`+` lines. The same rules apply: no writes inside `.git` or outside the repository, your write rules, a review per file, the stale-file check, CRLF/BOM kept, and an `/undo` step per file. A patch is all or nothing: if one hunk does not match or you reject one file, no file is written. After two failed patches in a row on the same file, the model is told to rewrite it with `write_file`. The choice depends only on the model, so the tool list stays identical for the whole time a model is in use.

## Planning

`todo_write` keeps the model's plan for a multi-step task: a short list of steps, each `pending`, `in_progress` or `done`. Every call sends the whole list and gets it back as text. It runs in every mode, is not given to subagents, and survives compaction: when the history is summarized, the latest list is attached to the summary. Hosts receive a `todo.updated` event with the full list.

In the TUI every write opens a diff review first: full height and scrollable (arrows, PgUp/PgDn, Home/End), with old and new line numbers, `@@` hunk headers, and visible tabs and trailing spaces on changed lines. `/undo` and `/redo` revert or re-apply the last change, binary files included.

![The diff review](assets/screens/tui-diff-review.svg)

## Reading and output

`read_file` shows line numbers, refuses huge files, recognizes binary files and slices by bytes, returning an offset to continue from. Tool results are plain text; long outputs keep the first 40% and last 60%, with the full text saved to `.hesdor/out/`. Search honors `.hesdorignore`, and an invalid regex is searched as plain text.

## Commands

`run_command` runs one command without a shell (no `&&`, pipes or redirects). Background jobs' process trees are killed when Hesdor exits, and a cancelled command never leaves its children running.

## Checks after edits

After `write_file` or `apply_patch` (both formats) writes a file, Hesdor formats it and runs lint and typecheck, and appends only the problems the edit added to the tool result (at most 30 lines). Per-file lint output is compared with a run just before the first edit to that file; a project-wide check is compared with its previous run. When the formatter changes the file, the result says so; `/undo` still restores the file as it was before the edit, and a CRLF file stays CRLF.

Without configuration, checks come from tools already installed and configured in the repository: prettier (with a prettier config) or biome (with `biome.json`) to format; eslint (with an eslint config), else oxlint, else biome to lint, all from `node_modules/.bin`; `tsc --noEmit -p tsconfig.json` when `tsconfig.json` and TypeScript are present; ruff (format and lint) or black for Python when on `PATH` and configured in `pyproject.toml`. Nothing is installed or downloaded. `hesdor doctor` shows what was found.

Set your own in config.json (or in a trusted repository's `.hesdor/config.json`, which overrides per kind):

```json
"checks": {
  "format": ["node_modules/.bin/prettier", "--write", "{file}"],
  "lint": ["ruff", "check", "{file}"],
  "typecheck": ["npx", "tsc", "--noEmit"],
  "test": ["pnpm", "test"],
  "timeoutMs": 30000
}
```

Each entry is an argv run without a shell; `{file}` is the edited file. An entry without `{file}` checks the whole project and runs at most once per turn. `[]` turns a kind off. A check that times out or cannot start is off for the rest of the session. Checks run through your permission rules and the sandbox: a deny rule (or an ask rule) matching the command turns it off, and checks never prompt.

## Tests

`run_tests` runs the project's tests and returns the failures as `file:line test name: message` lines (vitest, jest, pytest, go test, cargo test and `node --test` are parsed; other output comes back as its last 40 lines). The runner is `checks.test`, else the `package.json` `test` script (through pnpm, yarn, bun or npm by lockfile), else pytest, `go test ./...` or `cargo test`. `path` and `name` narrow the run in the runner's own syntax. It is approved like `run_command`. When files changed in a run and no tests ran yet, one tool result suggests `run_tests`.

## Web tools

`web_fetch` reads an http(s) page as text in build mode. It asks before every fetch unless a user rule allows the host, for example `"permissions": { "allow": [{ "fetch": "docs.python.org" }] }`. Local, private and cloud-metadata addresses are always refused (loopback, private, CGNAT, link-local, multicast and reserved, IPv4 and IPv6), DNS is re-checked on every redirect, and `web_fetch` does not use `HTTPS_PROXY`. Zero-width, bidi and Unicode tag characters are stripped. `web_search` appears when `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY` or `SEARXNG_URL` is set. Web and MCP output is framed as untrusted, and later approval prompts say so.

## Images

`--image <file>` (repeatable) or `@path/to/shot.png` in a prompt attaches PNG, JPEG, GIF or WebP images up to 3.75 MB. Models with vision also see images they open with `read_file`. A model the catalog marks as text-only gets a short note instead. The Anthropic, Chat Completions and Responses wire formats all carry images.
