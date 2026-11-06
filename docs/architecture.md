# Architecture

Hesdor is a pnpm monorepo with four packages. The published CLI (`@dean_overlord/hesdor`) bundles the other three.

| Package | Role |
|---|---|
| `packages/protocol` | Stable shared types: events, messages, tools, modes. |
| `packages/providers` | The `ModelProvider` abstraction, clients for Chat Completions, Responses and Anthropic Messages, presets, the models.dev catalog and ChatGPT sign-in. |
| `packages/agent-core` | The agent loop, tools, permission policy, repo discovery, hooks and plugins, MCP client, checkpoints. No UI dependencies. |
| `packages/cli` | Command dispatch, the Ink TUI, headless runs, review, ACP server, config layers, sessions, workspace trust, model roles, guardian and goal mode. |

```mermaid
flowchart TB
  subgraph cli["packages/cli"]
    direction LR
    tui["Ink TUI"]
    headless["run · plan · ask · review"]
    acp["hesdor acp"]
    turn["runTurn: hooks, checkpoint,<br/>roles, guardian, budget"]
    sessions[("sessions")]
    trust["workspace trust"]
  end
  subgraph core["packages/agent-core"]
    direction LR
    loop["agent loop<br/>compaction, loop guard"]
    tools["tools: files, search,<br/>commands, git, web,<br/>explore, task, oracle"]
    policy["modes and<br/>permission rules"]
    hooks["hooks and plugins"]
    mcp["MCP client"]
    ckpt[("shadow-git<br/>checkpoints")]
  end
  subgraph prov["packages/providers"]
    direction LR
    wires["Chat Completions · Responses ·<br/>Anthropic Messages"]
    catalog["models.dev catalog<br/>prices and limits"]
  end
  protocol["packages/protocol: shared types"]

  tui & headless & acp --> turn
  turn --> loop
  turn --> sessions
  trust -.->|gates project code| hooks & mcp
  loop --> tools --> policy
  loop --> hooks
  turn --> ckpt
  loop --> wires
  mcp <--> servers["MCP servers<br/>stdio / HTTP"]
  wires <--> apis["model APIs and<br/>local servers"]
  protocol -.- cli & core & prov
```

## One turn

What happens between pressing Enter and seeing the answer. Code: `runTurn` in [`packages/cli/src/run.ts`](../packages/cli/src/run.ts) and `runAgentLoop` in [`packages/agent-core/src/loop.ts`](../packages/agent-core/src/loop.ts).

```mermaid
sequenceDiagram
  autonumber
  actor U as You
  participant T as runTurn (cli)
  participant H as Hooks and plugins
  participant S as Shadow git
  participant M as Model
  participant L as Agent loop
  participant P as Permission policy
  participant G as Guardian (opt-in)

  Note over T,H: At session start, workspace trust decides whether<br/>project plugins, hooks and MCP servers load.
  U->>T: prompt
  T->>H: UserPromptSubmit (may block or add context)
  T->>S: checkpoint the workspace
  loop until the model answers without tool calls (step budget, default 100)
    L->>L: compact history if near the context window
    L->>M: system prompt, history, tools
    Note right of M: on overload, quota or network errors<br/>roles.fallback takes over
    M-->>L: text and tool calls
    L->>L: validate arguments, mode gate (plan/ask refuse write and execute)
    L->>H: PreToolUse (block, rewrite or ask)
    L->>P: command, write or fetch rule: allow, ask or deny
    alt ask
      P->>G: guardian reviews first, if enabled
      G-->>U: deny, error or timeout: approval prompt or diff review
    end
    L->>L: run the tool, PostToolUse
    L-->>M: tool result
  end
  L->>H: Stop (may send the model back once)
  T->>S: end-of-turn checkpoint
  T-->>U: answer, usage and cost (budget checked on every request)
```
