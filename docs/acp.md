# Use Hesdor from an editor (ACP)

`hesdor acp` speaks the Agent Client Protocol (v1) on stdio, so Zed, JetBrains, Neovim and Emacs clients can drive Hesdor. It streams messages, reasoning, tool calls and diffs, asks for approvals in the editor, and supports build/plan/ask modes, cancel and session loading.

Run `hesdor setup` once, then add it as a custom agent. In Zed's `settings.json`:

```json
{ "agent_servers": { "Hesdor": { "type": "custom", "command": "npx", "args": ["-y", "@dean_overlord/hesdor", "acp"] } } }
```

ACP sessions use the same [roles](roles.md) as the TUI: profiles, `fallback`, `escalation`, `small`, `subagent` and the guardian (on with `guardian.enabled`, as in interactive use: what it declines is asked in the editor). Model switches, guardian decisions, stuck runs and compactions arrive as notices, and the agent's todo list as an ACP plan. A compaction keeps the full transcript saved under a linked session id.

Add `"-p", "<provider>"`, `"-m", "<model>"` or `"--trust-workspace"` to `args` as needed. Plans that forbid automated use, such as the Qwen Coding Plan, work through ACP because you drive each turn (see [subscriptions.md](subscriptions.md)).
