# Benchmarks

Hesdor's claim is about cost as much as quality: a routing profile should solve about as many tasks as a
frontier agent for fewer dollars. This page is how we measure that against Claude Code and Codex CLI on
the same tasks, and where the results go.

## What we measure

For every contender (an agent plus a model or routing profile) on the same task set:

| Number | Meaning |
|---|---|
| pass@1 | Mean over tasks of solved / valid trials. The headline pass rate. |
| pass@k | Chance that at least one of k tries solves the task (capability), unbiased estimator averaged over tasks. |
| pass^k | Chance that all k tries solve it (reliability, what a user feels). |
| 95% CI | Percentile bootstrap over tasks (2,000 resamples, fixed seed). `summary.json` also has a Wilson interval on pooled trials, which is narrower because it ignores that trials of one task are correlated. |
| $ total, $/task | Everything the contender spent, including trials lost to infra errors. |
| $/solved | Cost of valid trials divided by solved trials, with a bootstrap CI. ∞ when nothing was solved. |
| Tokens | Mean input (including cached), cached and output tokens per trial. |
| Infra errors | Trials Harbor marks `reward_valid: false`: provider and API errors (Hesdor exit 3), auth failures, sandbox failures. Counted and shown by type, but left out of every rate. |
| Per-task outcomes | `solved/valid +infra` per task and contender, to find the tasks one agent solves and another fails. |

Contenders:

- Hesdor routing profiles: `economy`, `balanced`, `frontier` (`hesdor run --profile <name>`), plus Hesdor with
  an explicit model (`-m <provider>/<model>`). The trial metadata records the profile and the number of
  escalations the router made.
  A profile picks the first model in its ranked list (`packages/cli/src/profiles.ts`) whose provider has a
  key, and the Harbor adapter forwards the `*_API_KEY` variables of your shell. So the keys you export
  decide the models: for the example spec export `DEEPSEEK_API_KEY` (economy: `deepseek/deepseek-flash`)
  and `ANTHROPIC_API_KEY` (balanced: `claude-sonnet-5-5`, frontier and escalations: `claude-opus-5-5`), and
  record which keys were set.
- Claude Code on the balanced profile's model (`anthropic/claude-sonnet-5-5`) is the like-for-like harness
  comparison; Codex runs on OpenAI's comparable tier (`openai/gpt-6.1-terra`).
- Claude Code and Codex CLI through Harbor's built-in `claude-code` and `codex` agents.
- [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) on the same model as a floor: if Hesdor
  scores below a bash-only scaffold, the harness is costing performance (see [evals/README.md](../evals/README.md)).

## Method

- **Terminal-Bench 2.1, not SWE-bench Verified.** SWE-bench Verified is contaminated and no longer
  reported by the labs. Terminal-Bench 2.1 (`terminal-bench/terminal-bench-2-1`, 89 tasks, a fixed
  revision of 2.0) is the cheap, stable comparison and the dataset Claude Code and Codex are already
  measured on. Terminal-Bench 4.0 (`terminal-bench/terminal-bench@4.0.0`) is the frontier comparison, but
  it has GPU and multi-container tasks and 8-hour agent timeouts, so it needs a cloud sandbox (Modal or
  Daytona). Pin and report the dataset ref.
- **k ≥ 3** trials per task and contender (`-k 3`; the Terminal-Bench leaderboard asks for 5). Report
  pass@k and pass^k, not only pass@1.
- **Same tasks, same machine, same resources.** Each Terminal-Bench task pins its CPUs and memory in
  `task.toml`; do not change them between contenders (`resources` in the spec overrides them for all
  tasks, so use it only when a host cannot meet the pinned values, and say so). Resource settings alone
  moved Terminal-Bench 2 scores by about 6 points in Anthropic's measurements. Run all contenders on the
  same host or the same sandbox provider, and rerun on another day before publishing.
- **Gaps under about 3 points are noise**, and so are overlapping intervals. With 20 tasks the intervals
  are wide (often ±15 points); use the full 89 tasks for anything you publish.
- **Infra failures are not task failures.** We use Harbor's own `reward_valid` flag, so the rule is the
  same for every agent: provider/API errors, auth errors and sandbox failures are excluded and counted;
  agent timeouts, context-window overflows and crashes of the agent itself count as failures. Retry infra
  errors with `-r 2`. A contender with many infra errors is a provider finding, not a score.
- **Cost is list-price API cost.** Hesdor reports `cost_usd` from its models.dev price snapshot or the
  provider's reported cost. Claude Code reports `total_cost_usd` from its stream-json output (Harbor
  falls back to a LiteLLM estimate). Codex reports cost from its token-count events, else Harbor prices
  the tokens with LiteLLM, else it is missing; the matrix then prices the tokens with Hesdor's catalog and
  marks the total `*`. Subscriptions (Claude Max, ChatGPT plans) are not modeled.
- **Read transcripts.** Before publishing, run Harbor's `oracle` agent (should score ~100%) and `nop`
  (~0%) on the same tasks, and read the transcripts of tasks where contenders disagree
  (`harbor view evals/jobs`). Grader bugs hide real ability.

## How to run

Prerequisites: Docker (Linux, macOS, or Windows with WSL 2; run Harbor from inside WSL), Python 3.12+,
Harbor (`uv tool install harbor`), Node 22+ for `scripts/bench/matrix.mjs`, and the keys each contender
needs in your shell: `ANTHROPIC_API_KEY` for Claude Code and Anthropic models, `OPENAI_API_KEY` for Codex,
and whatever providers your Hesdor profiles route to (the adapter forwards common `*_API_KEY` variables;
pass others with `--ae NAME=value` in `extraArgs`).

**Every trial is a paid model run.** The default mode only prints commands.

```sh
# 1. Dry run: the exact harbor commands and a cost estimate from catalog prices. Spends nothing.
node scripts/bench/matrix.mjs evals/matrix/tb21-smoke.json

# 2. Check the harness on the same tasks without a model: oracle ~100%, nop ~0%.
harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5
harbor run -d terminal-bench/terminal-bench-2-1 -a nop -l 5

# 3. Run the matrix (one harbor job per contender, one after another), then aggregate.
node scripts/bench/matrix.mjs evals/matrix/tb21-smoke.json --execute

# Re-aggregate existing job folders at any time (no model calls):
node scripts/bench/matrix.mjs evals/matrix/tb21-smoke.json --aggregate
```

Rerunning `--execute` resumes: Harbor keeps finished trials in an existing job folder. Jobs land in
`evals/jobs/<name>-<contender id>/` (git-ignored) and the report in `evals/jobs/<name>-report/`:
`results.md`, `summary.json`, `chart-light.svg` and `chart-dark.svg`.

### Matrix spec

[`evals/matrix/tb21-smoke.json`](../evals/matrix/tb21-smoke.json):

```json
{
  "name": "tb21-smoke",
  "dataset": "terminal-bench/terminal-bench-2-1",
  "sample": { "n": 20, "seed": 2026, "pool": "terminal-bench-2-1.tasks.txt" },
  "k": 3,
  "concurrency": 4,
  "jobsDir": "../jobs",
  "extraArgs": ["-r", "2"],
  "estimate": { "inputTokensPerTrial": 1500000, "outputTokensPerTrial": 50000, "cacheHit": 0.9 },
  "contenders": [
    { "id": "hesdor-economy", "agent": "hesdor", "profile": "economy", "priceAs": "deepseek/deepseek-flash" },
    { "id": "hesdor-balanced", "agent": "hesdor", "profile": "balanced", "priceAs": "anthropic/claude-sonnet-5-5" },
    { "id": "hesdor-frontier", "agent": "hesdor", "profile": "frontier", "priceAs": "anthropic/claude-opus-5-5" },
    { "id": "claude-code-sonnet-5.5", "agent": "claude-code", "model": "anthropic/claude-sonnet-5-5" },
    { "id": "codex-gpt-6.1-terra", "agent": "codex", "model": "openai/gpt-6.1-terra" }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Prefix of the job folders (`<name>-<contender id>`). |
| `dataset` | Harbor dataset ref (`-d`). |
| `tasks` or `sample` | Explicit task names (`-i`), or a seeded sample: `n` tasks from `pool` (an array, a file with one task name per line, or a downloaded dataset folder). Without either, the whole dataset runs. Hub task names include the org: `terminal-bench/<task>`. `evals/matrix/terminal-bench-2-1.tasks.txt` lists all 89. |
| `k`, `concurrency` | `-k` trials per task, `-n` concurrent trials. |
| `jobsDir` | Harbor `-o`, relative to the spec file. |
| `resources` | `{ "cpus", "memoryMb" }`: `--override-cpus` / `--override-memory-mb` for every task. Leave unset to keep each task's pinned values. |
| `extraArgs` | Passed to every `harbor run` (for example `-e daytona`, `-r 2`, `--ae KEY=value`). |
| `estimate` | Token assumptions for the dry-run cost estimate. `datasetSize` (top level) is needed only to estimate a whole-dataset run. |
| `contenders[]` | `id`, `agent` (`hesdor`, or any Harbor agent name such as `claude-code`, `codex`, `mini-swe-agent`), `model` (`<provider>/<model>`; for Hesdor the part before the first `/` is the Hesdor provider id), `profile` (Hesdor only), `ak` (extra `--ak` agent kwargs, for example `{ "max_budget_usd": 2 }` to hard-cap each Hesdor trial or `{ "max_steps": 150 }`; Hesdor defaults to 100 steps, the CLI default), `extraArgs`, and `priceAs` (the catalog model used to price a profile in the dry run: the main model it picks with your keys, see below). |

The dry-run estimate multiplies the token assumptions by Hesdor's bundled models.dev prices: "typical"
assumes 90% of input is read from cache, "upper" assumes none is. It is an estimate under those
assumptions, not a bound: a run that loops can spend more. For a hard cap on Hesdor trials set
`max_budget_usd`; Claude Code and Codex have no per-trial cap in Harbor, so watch the first job.

### Publishing

Copy `results.md` into the results section below, and the two charts to `docs/assets/benchmarks/`,
shown with a `<picture>` element like the README banner:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/benchmarks/tb21-chart-dark.svg">
  <img alt="pass@1 vs dollars per solved task" src="assets/benchmarks/tb21-chart-light.svg">
</picture>
```

State the dataset ref, the date, the Hesdor, Claude Code and Codex versions, the host or sandbox, and
link the Harbor jobs if you upload them (`harbor upload evals/jobs/<job>`).

## Results

**No results yet.** Nothing on this page is a measurement until a run's table and chart are pasted here.

## References

- Harbor: [running jobs](https://docs.harborframework.com/jobs/run-a-job.md),
  [error classification](https://docs.harborframework.com/jobs/error-classification.md),
  [pre-integrated agents](https://docs.harborframework.com/agents/pre-integrated-agents.md).
- Terminal-Bench 2.1: [tasks and leaderboard rules](https://github.com/harbor-framework/terminal-bench-2-1),
  [release notes](https://tbench.ai/news/terminal-bench-2-1); 4.0:
  [release notes](https://www.tbench.ai/news/terminal-bench-4-0).
- pass@k estimator: Chen et al., [Evaluating Large Language Models Trained on Code](https://arxiv.org/abs/2107.03374) (2021).
