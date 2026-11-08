"""Self-check for the result parser: python evals/harbor/test_hesdor_result.py (no Harbor needed)."""

import json

from hesdor_result import parse_run


def out(result: dict | None, code: int) -> str:
    return (json.dumps(result) if result else "") + f"\nHESDOR_EXIT={code}\n"


def result(**over):
    base = {"type": "result", "status": "completed", "result": "done", "session_id": "s", "steps": 4,
            "usage": {"inputTokens": 1000, "outputTokens": 50, "cacheReadTokens": 800, "ready": True},
            "cost_usd": 0.012, "error": None, "error_category": None}
    return {**base, **over}


ok = parse_run(out(result(), 0))
assert (ok.outcome, ok.steps, ok.n_input_tokens, ok.n_cache_tokens, ok.cost_usd) == ("completed", 4, 1000, 800, 0.012)
assert not ok.is_provider_error

steps = parse_run(out(result(status="max_steps"), 2))
assert steps.outcome == "max_steps" and not steps.is_provider_error

failed = parse_run(out(result(status="failed", error="boom", error_category="agent"), 1))
assert failed.outcome == "failed" and not failed.is_provider_error

prov = parse_run(out(result(status="failed", error="429", error_category="rate_limit", cost_usd=None), 3))
assert prov.is_provider_error and prov.error_category == "rate_limit" and prov.cost_usd is None

# cost reported only inside usage (provider-reported costUsd)
inner = parse_run(out(result(cost_usd=None, usage={"inputTokens": 1, "costUsd": 0.5}), 0))
assert inner.cost_usd == 0.5

# no JSON at all: crashed (an infra failure, not a task failure)
crash = parse_run("Segmentation fault\nHESDOR_EXIT=139\n")
assert crash.outcome == "crashed" and crash.exit_code == 139

# stderr noise or a trailing log line around the JSON is tolerated
noisy = parse_run("warning: something\n" + out(result(), 0))
assert noisy.outcome == "completed"

# routing profile and escalations (a count or a list of escalation records)
prof = parse_run(out(result(profile="economy", escalations=2), 0))
assert (prof.profile, prof.escalations) == ("economy", 2)
listed = parse_run(out(result(profile="balanced", escalations=[{"from": "a", "to": "b"}]), 0))
assert listed.escalations == 1
assert (ok.profile, ok.escalations) == (None, None)

print("ok")
