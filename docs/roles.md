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

- `escalation` lists stronger models, in order, that take over when a run is stuck (see Escalation below).

Each role is a `provider/model` and uses its own provider's key from the environment or `hesdor setup`; a role without a key is skipped with a warning. Their costs count toward `--max-budget-usd`. `hesdor doctor` checks them.

## Profiles

A profile picks the main model and the roles for you, from the keys you already have:

```sh
hesdor --profile economy            # or HESDOR_PROFILE=economy, or "profile": "economy" in config.json
```

| Profile | Main model | small | oracle | Escalates to |
| --- | --- | --- | --- | --- |
| `economy` | strong cheap models (DeepSeek, GLM, MiniMax and Qwen flash tiers, gpt-oss-120b on fast hosts) | cheapest tool-capable model | a frontier model, through the oracle tool only | balanced, then frontier |
| `balanced` | mid-tier frontier (Sonnet, Terra class) | cheapest tool-capable model | a frontier model | frontier |
| `frontier` | top models (Opus, Fable, Astra class) | cheapest tool-capable model | none | nothing |

Each tier is a ranked list in [`packages/cli/src/profiles.ts`](../packages/cli/src/profiles.ts). Hesdor uses the first candidate whose provider has a key (environment variable, `hesdor setup`, or ChatGPT sign-in for `chatgpt/...`) and is allowed by managed settings. The profile also sets one `fallback`: the next candidate with a key from another vendor. The lists are a starting point and will be tuned by benchmark results.

- `-p`/`-m` (or `HESDOR_PROVIDER`/`HESDOR_MODEL`) choose the main model yourself; the profile still fills the roles. A provider and model saved in `config.json` do not override a profile, so a model picked with `/model` lasts for that session. `hesdor config set profile none` removes a saved profile.
- A role you set in `roles` is kept; the profile fills only the unset ones.
- A project's `.hesdor/config.json` cannot set a profile. Managed settings can lock it with `"profile"`, and `allowedProviders` or a locked `provider` limit the candidates.
- When no candidate of a tier has a key, `hesdor doctor` and `/status` say which variables would enable one; without a main candidate the configured provider is used, with a warning.

`hesdor doctor` and `/status` show the active profile, what each tier resolved to and which key made it usable.

## Escalation

With the `economy` and `balanced` profiles (or your own `roles.escalation`), a run that is clearly stuck switches to the next stronger model for the rest of the turn:

- loop detection refused a call (the 3rd identical call, or the 5th edit to one file),
- `run_tests` failed 3 times in a row without fewer failures, or
- the model sent cut-off or invalid tool calls 2 turns in a row.

At most 2 escalations happen per turn, the run never steps back down, and the new model gets two steps before it can count as stuck itself. Only models with a key that managed settings allow are used. Each model is priced at its own catalog price and counts toward `--max-budget-usd`. Each switch emits a `provider.escalated` event (`from`, `to`, `reason`), preceded by `run.stuck` (`reason`, `detail`); headless JSON results list them in `escalations` with the step, next to `profile`. Turn it off with `"escalate": false`.

A model that takes over mid-turn (escalation or fallback) keeps the tool list the turn started with: a switch from another model to a GPT-5+/Codex model keeps the find/replace `apply_patch` rather than the V4A patch format, which those models handle fine.

## Guardian

The guardian lets a cheap model approve commands and edits that no permission rule settles, so you are asked less often. Turn it on with `guardian: { enabled: true, model? }`; without `model` it uses `roles.small`.

- A deny, error or timeout asks you instead. In headless runs, where nobody can be asked, it refuses.
- Deny rules are never overridden.
- It turns itself off after 3 denials in a row or 10 in 50.
- Headless runs use it only with `--guardian`.
- Administrators can disable it through managed settings.

The oracle and guardian send what they review to their model's vendor.
