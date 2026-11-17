# Use Hesdor from an editor (ACP)

`hesdor acp` speaks the Agent Client Protocol (v1) on stdio, so VS Code, Zed, JetBrains, Neovim and Emacs clients can drive Hesdor. It streams messages, reasoning, tool calls and diffs, asks for approvals in the editor, and supports build/plan/ask modes, cancel, and listing (`session/list`, newest 50) and loading saved sessions.

When the editor offers file access (ACP `fs/read_text_file` and `fs/write_text_file`), Hesdor's file tools use it: they read open files with your unsaved changes and write into the editor buffer, so its undo covers Hesdor's edits. Binary files, deletes and post-edit checks still use the disk.

## VS Code

The Hesdor extension (`packages/vscode`, see its [README](../packages/vscode/README.md)) adds a Hesdor view to the activity bar. It starts `hesdor acp` (from `hesdor.path`, PATH, or the install script's default folder, and offers to install the CLI when none is found), streams the conversation, opens proposed changes in VS Code's diff editor with Allow and Reject in the chat, writes edits through the editor so Undo works, attaches the editor selection with **Hesdor: Add Selection to Chat**, and runs `hesdor setup` in a terminal when no key is configured. Extra CLI flags go in `hesdor.args`. It is not on the Marketplace yet: build it with `pnpm --filter hesdor-vscode package` and install the `.vsix` with **Extensions: Install from VSIX…**.

Any ACP client works too, for example the community [ACP Client extension](https://github.com/formulahendry/vscode-acp): add a custom agent with the command `hesdor` and the argument `acp`.

## Zed and other editors

Run `hesdor setup` once, then add it as a custom agent. In Zed's `settings.json`:

```json
{ "agent_servers": { "Hesdor": { "type": "custom", "command": "npx", "args": ["-y", "@dean_overlord/hesdor", "acp"] } } }
```

ACP sessions use the same [roles](roles.md) as the TUI: profiles, `fallback`, `escalation`, `small`, `subagent` and the guardian (on with `guardian.enabled`, as in interactive use: what it declines is asked in the editor). Model switches, guardian decisions, stuck runs and compactions arrive as notices, and the agent's todo list as an ACP plan. A compaction keeps the full transcript saved under a linked session id.

Add `"-p", "<provider>"`, `"-m", "<model>"` or `"--trust-workspace"` to `args` as needed. Plans that forbid automated use, such as the Qwen Coding Plan, work through ACP because you drive each turn (see [subscriptions.md](subscriptions.md)).
