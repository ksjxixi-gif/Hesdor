# Code review and worktrees

## hesdor review

```bash
hesdor review                                  # review HEAD against its merge base with the default branch
hesdor review --uncommitted --severity P2      # review uncommitted changes, fail on P2 or worse
hesdor review --base origin/dev --output-format json
hesdor review "focus on error handling"        # optional focus for the reviewer
```

`hesdor review` is read-only and reports P0–P3 findings with file, line, explanation and a suggested fix, as Markdown (default) or JSON. `-o <file>` also writes the Markdown report to a file. It exits 5 when a finding is at or above `--severity` (default P1); other exit codes are as for headless runs (see [headless.md](headless.md#exit-codes)).

`--base <ref>` compares HEAD with its merge base with `<ref>` (default `origin/HEAD`, `origin/main`, `main`, ...). `--uncommitted` reviews staged, unstaged and untracked changes.

## On pull requests

The repository's `action.yml` is a composite GitHub Action that runs `hesdor review` on pull requests and keeps one PR comment up to date, with the provider key and the comment permission in separate jobs. See [github-action.md](github-action.md).

## Worktrees

```bash
hesdor run --worktree=fix-auth "fix the login bug"   # work in .hesdor/worktrees/fix-auth on branch hesdor/fix-auth
```

`--worktree[=name]` works for `run`, `plan` and `ask`. The name is generated when omitted. Hesdor removes the worktree when nothing changed and otherwise prints how to review and merge the branch.
