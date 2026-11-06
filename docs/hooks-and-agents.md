# Hooks, agents and extensions

Project extensions live in `.hesdor/` in the repository; your own live in the Hesdor config directory (`%APPDATA%\hesdor` or `~/.config/hesdor`). Project hooks, plugins and MCP servers load only in a trusted workspace (see [permissions.md](permissions.md#workspace-trust)).

## Hooks

Hooks use the Claude Code format, in `.hesdor/hooks.json` (project, needs workspace trust) or `hooks.json` in your config directory:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "run_command|write_file", "hooks": [ { "type": "command", "command": "node .hesdor/hooks/guard.mjs", "timeout": 30 } ] } ] } }
```

Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop and SessionStart. A hook gets JSON on stdin; exit code 2 blocks the action and feeds stderr back to the model; JSON output can set `permissionDecision`, `updatedInput` and `additionalContext`. Input rewritten by a hook is validated against the tool schema again. Matchers use Hesdor tool names (`run_command`, `write_file`, `apply_patch`, ...). A Stop hook can send the model back to work once per run. JS plugin hooks share the same dispatcher, and both apply inside subagents.

## Subagents

The built-in `explore` tool hands a repository-wide investigation to a read-only subagent. Your own subagents are markdown files in `.hesdor/agents/`, `.claude/agents/` or `agents/` in your config directory, run through the `task` tool:

```md
---
name: reviewer
description: Reviews diffs for bugs
tools: Read, Grep, run_command
model: anthropic/claude-sonnet-5-5
---
You review the current diff and report bugs.
```

A `provider/model` value uses that provider's own key. Without `model:`, `roles.subagent` runs the agent if set (see [roles.md](roles.md)), else the main model. Task agents act under the turn's mode and approvals and cannot start further subagents. Plan and ask modes cannot run an agent whose tools could write or execute.

## Custom commands, skills and plugins

| Where | What |
|---|---|
| `commands/<name>.md` | A custom slash command; `$ARGUMENTS` in the template is replaced by what you type after it. |
| `skills/<name>/SKILL.md` | A skill the model loads with `read_skill`. Also discovered in `.agents/skills` and `.claude/skills` (project and user scope). Skills follow the Agent Skills frontmatter rules, can be run as `/skill-name`, and `read_skill` can read a skill's bundled files. |
| `plugins/*.js` | JS plugins with `tool.execute.before`/`after` and `event` hooks. Project plugins need workspace trust. |
| `mcp.json` | MCP servers, see [mcp.md](mcp.md). |

In the TUI, `/tools`, `/skills` and `/plugins` list what is loaded and `/reload` rescans extensions (it picks up edited plugins too).
