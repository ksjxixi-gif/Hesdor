# Hesdor for VS Code

Chat with the [Hesdor](https://github.com/ksjxixi-gif/Hesdor) coding agent from the VS Code sidebar. The extension starts `hesdor acp` and talks to it over the Agent Client Protocol, so it uses the same providers, roles, permission rules and sessions as the CLI.

## What you get

- A **Hesdor** view in the activity bar: streamed markdown answers (code blocks with Copy), collapsible reasoning, every tool call with its status, output and changed files, and the agent's plan with its progress.
- **Build, plan and ask** modes and the **model** from the menus under the message box; the send button turns into **Stop** while a turn runs.
- **New** starts a fresh session; **Open Session…** (the history icon, or the welcome screen) continues a saved one of this workspace, including sessions started in the terminal.
- **File changes are reviewed in VS Code's diff editor.** When Hesdor wants to edit a file, the proposed change opens side by side and the chat shows Allow, Allow for this session and Reject.
- **Edits go through the editor.** Hesdor reads open files as you see them, unsaved changes included, and writes into the editor buffer and saves, so **Undo** works on its changes.
- **Hesdor: Add Selection to Chat** (editor context menu) attaches the selected code to your next message.
- **Hesdor: Run Setup** opens a terminal running `hesdor setup` to choose a provider and save a key. The chat offers it when no key is configured.

## Requirements

Install the CLI (`npm install -g @dean_overlord/hesdor`, or a standalone binary from the releases page) and run `hesdor setup` once. If `hesdor` is not on your PATH the extension falls back to `npx -y @dean_overlord/hesdor`, which needs Node.js 22 or newer.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `hesdor.path` | `hesdor` | The CLI to start: a name on PATH or a full path. |
| `hesdor.args` | `[]` | Extra arguments for `hesdor acp`, e.g. `["-p", "anthropic", "-m", "claude-sonnet-5-5"]` or `["--trust-workspace"]`. |

The agent's stderr goes to the **Hesdor** output channel.

## Security

The extension only answers file requests for paths inside your open workspace folders. Repository plugins, hooks and MCP servers stay off until the workspace is trusted (`hesdor` in a terminal asks once, or add `--trust-workspace` to `hesdor.args`). See [docs/acp.md](https://github.com/ksjxixi-gif/Hesdor/blob/main/docs/acp.md).

## Develop

```bash
pnpm install
pnpm --filter hesdor-vscode build      # bundles dist/extension.cjs and dist/webview.js
pnpm --filter hesdor-vscode package    # writes hesdor-vscode.vsix
```

Open the repository in VS Code and press F5 (**Run Hesdor VS Code extension**), or install the `.vsix` with **Extensions: Install from VSIX…**.
