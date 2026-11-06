# Hesdor review on pull requests (GitHub Action)

`action.yml` at the root of this repository runs `hesdor review` on a pull request and
posts the findings as one PR comment, which is updated (not duplicated) on every push.
The review job fails when there is a finding at or above `severity`, so it can be a
required check.

## Workflow

Save as `.github/workflows/hesdor-review.yml` and add your provider key as a repository
secret (here `ANTHROPIC_API_KEY`):

```yaml
name: Hesdor review

on:
  pull_request: # never pull_request_target, see below

permissions: {} # each job asks for what it needs

jobs:
  review:
    # Fork pull requests get no secrets and a read-only token, so they are skipped.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # the merge base with the target branch must be present
          persist-credentials: false # the reviewing model can read files; keep the token out
      - uses: ksjxixi-gif/Hesdor@main # pin a release tag or commit SHA
        with:
          mode: review
          provider: anthropic
          model: '' # preset default
          severity: P1
          base: '' # default origin/<target branch>
          version: latest # pin a CLI version, e.g. 0.2.0
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} # this step only

  comment:
    needs: review
    # Post the report even when the review failed the check; not when it was skipped.
    if: ${{ !cancelled() && needs.review.result != 'skipped' }}
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: ksjxixi-gif/Hesdor@main
        with:
          mode: comment
```

Inputs: `mode` (`review` | `comment`), `provider`, `model`, `severity` (`P0`–`P3`,
default `P1`), `base`, `version` (CLI version, default `latest`), `github-token` (comment
mode, default `github.token`). Output: `exit-code` of `hesdor review`.

The report is also added to the job summary, and the JSON result (`review.json`, schema in
`hesdor review --output-format json`) is in the `hesdor-review` artifact.

## Security design

- **Key and write access never share a job.** The `review` job has the provider key and a
  `contents: read` token. The `comment` job can write PR comments and has no key. A
  prompt-injected review can at worst write a misleading report; it cannot push, approve,
  or leak the key through the comment job.
- **The key is set with `env:` on the Hesdor step only**, not at job or workflow level.
  Hesdor strips provider keys from the environment of commands it starts, and `hesdor review`
  is read-only (ask mode: no write or execute tools).
- **`pull_request`, not `pull_request_target`.** `pull_request_target` runs with the base
  repository's secrets and a write token while the pull request's code is untrusted ("pwn
  request"). On `pull_request`, secrets are not passed to workflows from forks and the
  token is read-only, so fork pull requests are skipped by the `if:` above (a maintainer can
  re-run the review on a branch in the main repository). Hesdor prints a warning when it
  runs under `pull_request_target`.
- **`persist-credentials: false`.** Otherwise `actions/checkout` keeps the token on disk for
  later git commands (in `.git/config` before checkout v6), which the review does not need.
- **Project code from the pull request never runs.** The action does not pass
  `--trust-workspace`, so `.hesdor/plugins`, hooks and MCP servers in the pull request are
  not loaded. Its `HESDOR.md`/`AGENTS.md` are still read as instructions: treat the review
  as advice, not as a gate that a pull request cannot influence.
- **The artifact is untrusted data.** The comment job downloads it outside the workspace,
  never executes it, and passes the report to the GitHub API as a file, never through
  `${{ }}` expressions in a shell script.
- **Pin actions.** Third-party actions are pinned to full commit SHAs; pin this action to a
  release tag or SHA and `version` to a CLI version.
- **No self-hosted runners for public repositories** (fork pull requests can run code on
  them).

Sources (checked 2026-11-06):

- GitHub Docs, Secure use reference: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub Docs, Events that trigger workflows (`pull_request`, `pull_request_target`, `workflow_run`): https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- GitHub Security Lab, Preventing pwn requests: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- actions/checkout (`persist-credentials`): https://github.com/actions/checkout
