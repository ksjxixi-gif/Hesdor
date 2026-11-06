# Hesdor evals

Two suites, following the evaluation methodology in the study report (section 9):

| Suite | What | Where | When |
|---|---|---|---|
| Regression | Hand-authored cassettes replayed through the real agent loop and real tools. No network, no cost. Should stay at 100%. | `packages/agent-core/src/testing/cases/` | Every `pnpm test`, gates PRs |
| Capability | Real models on Terminal-Bench (and later Aider polyglot, SWE-rebench) through [Harbor](https://harborframework.com). Starts low, runs nightly. | `evals/harbor/` | Manually or nightly; costs money |

Tasks the capability suite saturates move into the regression suite.

## Regression suite (cassettes)

```sh
npx vitest run packages/agent-core/src/testing
```

`packages/agent-core/src/testing/replay.ts` has:

- `ReplayProvider`: replays a cassette, one interaction per model request. Each interaction can carry a
  `match` block (role, tool call id, `contains` / `notContains` substrings of the request's last
  message). A request past the end of the cassette, or one that does not match, throws a
  non-retryable `ReplayError`; `assertDone()` also fails when interactions were left unused.
- `RecordingProvider`: wraps a real provider and records its chunks and errors into a cassette
  (`save(file)`). Recorded tool results are not matched on content, since they hold paths and timings.

To add a case from a real failure: record it with `RecordingProvider` (or write the JSON by hand),
trim it to the turns that matter, add `contains` matches for what the loop must send back, and add an
`it(...)` in `cases.test.ts` that sets up the repo and checks the files and result.

## Capability suite (Harbor)

`evals/harbor/hesdor_agent.py` is a Harbor *installed agent*: Harbor starts the task container,
the adapter installs Node 22 (nvm) and the published CLI (`npm install -g @dean_overlord/hesdor`),
then runs, in the task's working directory:

```sh
hesdor run --output-format json --yes --max-steps N --provider P --model M "<task instruction>"
```

The JSON result and the exit code are mapped as follows:

| Exit | Meaning | Harbor outcome |
|---|---|---|
| 0 | completed | verifier decides the reward |
| 1 | agent failed | verifier decides (usually 0) |
| 2 | step budget reached | verifier decides |
| 3 | provider error (auth, rate limit after retries, quota, network, ...) | raises the matching Harbor `ApiError` / `AgentAuthenticationError` / `NetworkConnectionError`, so it is an **infra error**, not a task failure |
| 4 | cost budget reached | verifier decides |
| no JSON | crash | `RuntimeError` (infra) |

Tokens (`n_input_tokens`, `n_output_tokens`, `n_cache_tokens`) and `cost_usd` go to Harbor's
`AgentContext`; status, steps and `error_category` go to `context.metadata`. Raw output is in the
trial's `agent/hesdor.json` and `agent/hesdor.stderr`.

### Running a small Terminal-Bench subset locally

Prerequisites: Docker, Python 3.12+, `uv tool install harbor` (or `pip install harbor`), and a
provider key. **Every trial is a paid model run**; start with a handful of tasks.

```sh
# 1. Check the harness and the tasks without any model: the oracle must score ~100%, nop ~0%.
harbor run -d terminal-bench@2.0 -a oracle -l 5
harbor run -d terminal-bench@2.0 -a nop -l 5

# 2. Hesdor on 10 tasks, 3 attempts each (k=3), 4 trials at a time.
export ANTHROPIC_API_KEY=...
PYTHONPATH=evals/harbor harbor run -d terminal-bench@2.0 \
  -a hesdor_agent:Hesdor -m anthropic/claude-sonnet-4-5 \
  --ak max_steps=50 -l 10 -k 3 -n 4 -o evals/jobs --job-name hesdor-tb-smoke

# 3. Baseline: mini-swe-agent (a bash-only scaffold) on the same tasks and model.
harbor run -d terminal-bench@2.0 -a mini-swe-agent -m anthropic/claude-sonnet-4-5 \
  -l 10 -k 3 -n 4 -o evals/jobs --job-name mini-tb-smoke
```

Notes:

- `-m` is `<hesdor provider id>/<model id>`; everything after the first `/` is the model id, so
  `-m openrouter/qwen/qwen3-coder` runs `--provider openrouter --model qwen/qwen3-coder`.
- Keys: the adapter forwards common `*_API_KEY` variables from your shell; any other variable can be
  passed with `--ae NAME=value`.
- Use `-i '<glob>'` / `-x '<name>'` to pick tasks, `--ak version=0.1.0` to pin the CLI version, and
  `-r 2 --retry-include ApiRateLimitError` to retry rate-limited trials.
- `harbor datasets list` shows the available dataset refs (Terminal-Bench 2.1, Aider polyglot,
  SWE-bench variants). Pin the ref you report.
- Pin CPU and memory (`--override-memory-mb`, task `task.toml`) and rerun on different days:
  resource settings alone moved TB2 scores by about 6 points in Anthropic's measurements.
- `evals/jobs/` holds transcripts. Read them: grader bugs hide real ability.

Self-check of the result parser (no Harbor or Docker needed):

```sh
python -I -c "import sys; sys.path.insert(0, 'evals/harbor'); exec(open('evals/harbor/test_hesdor_result.py').read())"
```

### Scoring: pass@k and pass^k

Run every task `n >= 3` times (`-k 3`). For a task with `c` successes out of `n` trials:

- **pass@k** = 1 - C(n-c, k) / C(n, k): the chance that at least one of k tries succeeds. Measures
  capability ("can it ever do this?").
- **pass^k** = C(c, k) / C(n, k): the chance that all k tries succeed. Measures reliability ("will it
  do this every time?"), which is what a user feels. With n = k = 3, pass^3 is 1 only for tasks
  solved 3 out of 3 times.

Average over tasks and report both, with a confidence interval (bootstrap over tasks). Treat gaps
under about 3 points, or overlapping intervals, as noise.

**Provider errors are not task failures.** Trials that ended in an infra error (exit 3, crashes,
Harbor `ApiError`s) are excluded from both numerator and denominator, and rerun; report their count
separately per provider. A provider with many infra errors is a provider-matrix finding, not a
Hesdor score.

### Baseline against mini-swe-agent

Run [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (about 100 lines, bash only) on the
same tasks, model, k and resources. It is the floor: if Hesdor scores below a bash-only scaffold
on the same model, its harness (prompt, tools, loop) is costing performance, and that is the first
thing to fix. Compare per task, not only the averages: tasks mini solves and Hesdor fails are the
best source of new regression cassettes.

### Benchmarks to use

Don't headline SWE-bench Verified (contaminated). Use Terminal-Bench 2.x for a cheap, stable
comparison, Terminal-Bench 3/4 for frontier comparisons, SWE-bench Pro public and monthly SWE-rebench
for contamination-resistant SWE tasks, and Aider polyglot for the edit path.
