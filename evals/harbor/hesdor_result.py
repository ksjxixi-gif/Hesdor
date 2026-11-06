"""Parse `hesdor run --output-format json` output. No Harbor import, so it is testable on its own.

Exit codes (packages/cli/src/headless.ts): 0 completed, 1 failed, 2 step budget reached,
3 provider error, 4 cost budget reached, 130 cancelled.
"""

import json
from dataclasses import dataclass, field
from typing import Any

EXIT_MARKER = "HESDOR_EXIT="

# Exit code -> outcome. Only "provider_error" is an infrastructure failure: it must not count
# against the agent in pass-rate math (report section 9).
OUTCOMES = {0: "completed", 1: "failed", 2: "max_steps", 3: "provider_error", 4: "budget_exceeded", 130: "cancelled"}


@dataclass
class HesdorRun:
    exit_code: int | None
    outcome: str
    status: str | None = None
    error: str | None = None
    error_category: str | None = None
    steps: int | None = None
    n_input_tokens: int | None = None
    n_output_tokens: int | None = None
    n_cache_tokens: int | None = None
    cost_usd: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_provider_error(self) -> bool:
        return self.outcome == "provider_error"


def parse_run(stdout: str) -> HesdorRun:
    """`stdout` is the JSON result object followed by a `HESDOR_EXIT=<code>` line."""
    exit_code: int | None = None
    result: dict[str, Any] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith(EXIT_MARKER):
            try:
                exit_code = int(line[len(EXIT_MARKER):])
            except ValueError:
                pass
        elif line.startswith("{"):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and obj.get("type") == "result":
                result = obj

    usage = result.get("usage") or {}
    cost = result.get("cost_usd")
    if cost is None:
        cost = usage.get("costUsd")
    outcome = OUTCOMES.get(exit_code, "failed") if exit_code is not None else "failed"
    # A run that died before printing a result (crash, OOM, missing binary) is an infra failure too.
    if not result and exit_code not in (0, None):
        outcome = "provider_error" if exit_code == 3 else "crashed"
    return HesdorRun(
        exit_code=exit_code,
        outcome=outcome,
        status=result.get("status"),
        error=result.get("error"),
        error_category=result.get("error_category"),
        steps=result.get("steps"),
        n_input_tokens=usage.get("inputTokens"),
        n_output_tokens=usage.get("outputTokens"),
        n_cache_tokens=usage.get("cacheReadTokens"),
        cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
        raw=result,
    )
