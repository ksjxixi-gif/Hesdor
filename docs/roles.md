# Model roles and the guardian

## Roles

`roles` in your user `config.json` sends internal work to other models, from any vendor:

```json
{ "roles": { "small": "groq/openai/gpt-oss-120b", "subagent": "deepseek/deepseek-flash", "oracle": "openai/gpt-6.1-sol", "fallback": ["openrouter/anthropic/claude-sonnet-5.5"] },
  "guardian": { "enabled": true } }
```

- `small` writes compaction summaries, judges `--goal` and `/goal` conditions, and runs the guardian.
- `subagent` runs explore and task agents, unless an agent names its own model.
- `oracle` adds a read-only `oracle` tool that asks a second model for an opinion.
- `fallback` takes over for the rest of a turn when the main model is overloaded, rate limited after retries, out of quota or unreachable.

Each role is a `provider/model` and uses its own provider's key from the environment or `hesdor setup`; a role without a key is skipped with a warning. Their costs count toward `--max-budget-usd`. `hesdor doctor` checks them.

## Guardian

The guardian lets a cheap model approve commands and edits that no permission rule settles, so you are asked less often. Turn it on with `guardian: { enabled: true, model? }`; without `model` it uses `roles.small`.

- A deny, error or timeout asks you instead. In headless runs, where nobody can be asked, it refuses.
- Deny rules are never overridden.
- It turns itself off after 3 denials in a row or 10 in 50.
- Headless runs use it only with `--guardian`.
- Administrators can disable it through managed settings.

The oracle and guardian send what they review to their model's vendor.
