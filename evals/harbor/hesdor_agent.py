"""Harbor installed-agent adapter for Hesdor.

    PYTHONPATH=evals/harbor harbor run -d terminal-bench@2.1 -a hesdor_agent:Hesdor \
        -m anthropic/claude-sonnet-4-5 --ak max_steps=50 --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

The model is `<hesdor provider id>/<model id>` (e.g. openrouter/qwen/qwen3-coder); the part
before the first "/" is passed as --provider. Provider keys reach the container through
`--ae` or are forwarded from the host environment (KEY_VARS).
See evals/README.md.
"""

import os
import shlex

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiOverloadedError,
    ApiRateLimitError,
    ApiUsageLimitError,
    BaseInstalledAgent,
    ContextWindowExceededError,
    ModelNotFoundError,
    NetworkConnectionError,
    UnknownApiError,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from hesdor_result import EXIT_MARKER, parse_run

PACKAGE = "@dean_overlord/hesdor"

# Forwarded from the host when set (never logged by Harbor: it redacts *_KEY / *_TOKEN values).
KEY_VARS = (
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY",
    "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY",
    "CEREBRAS_API_KEY", "HESDOR_API_KEY", "HESDOR_BASE_URL",
)

# Hesdor error_category -> Harbor exception, so provider failures are recorded as infra errors
# (retryable with --retry-include) instead of a task failure with reward 0.
PROVIDER_ERRORS = {
    "rate_limit": ApiRateLimitError,
    "quota_exhausted": ApiUsageLimitError,
    "overloaded": ApiOverloadedError,
    "context_overflow": ContextWindowExceededError,
    "auth": AgentAuthenticationError,
    "model_not_found": ModelNotFoundError,
    "network": NetworkConnectionError,
}

LOG = "/logs/agent"


class Hesdor(BaseInstalledAgent):
    def __init__(
        self, *args, max_steps: int | str = 30, profile: str | None = None,
        max_budget_usd: float | str | None = None, **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._max_steps = int(max_steps)
        self._profile = profile or None
        self._max_budget_usd = float(max_budget_usd) if max_budget_usd not in (None, "") else None

    @staticmethod
    def name() -> str:
        return "hesdor"

    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; hesdor --version"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=f"set -euo pipefail; {nvm_node_install_snippet()} && npm install -g {PACKAGE}{spec} && hesdor --version",
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model_flags = ""
        if self.model_name:
            provider, _, model = self.model_name.partition("/")
            model_flags = f"--provider {shlex.quote(provider)} " + (f"--model {shlex.quote(model)} " if model else "")
        if self._profile:
            model_flags += f"--profile {shlex.quote(self._profile)} "
        if self._max_budget_usd is not None:
            model_flags += f"--max-budget-usd {self._max_budget_usd} "
        env = {k: os.environ[k] for k in KEY_VARS if k in os.environ}

        # Hesdor's exit code carries the outcome; capture it instead of letting a non-zero exit raise.
        command = (
            f"mkdir -p {LOG}; . ~/.nvm/nvm.sh; "
            f"hesdor run --output-format json --yes --max-steps {self._max_steps} {model_flags}"
            f"{shlex.quote(instruction)} > {LOG}/hesdor.json 2> {LOG}/hesdor.stderr; "
            f"code=$?; cat {LOG}/hesdor.json; echo; echo {EXIT_MARKER}$code"
        )
        result = await self.exec_as_agent(environment, command=command, env=env)
        run = parse_run(result.stdout or "")

        context.n_input_tokens = run.n_input_tokens
        context.n_output_tokens = run.n_output_tokens
        context.n_cache_tokens = run.n_cache_tokens
        context.cost_usd = run.cost_usd
        context.metadata = {
            "hesdor_exit_code": run.exit_code,
            "hesdor_outcome": run.outcome,
            "hesdor_status": run.status,
            "hesdor_steps": run.steps,
            "hesdor_error": run.error,
            "hesdor_error_category": run.error_category,
            # The profile Hesdor reports (falls back to the requested one) and its escalations.
            "hesdor_profile": run.profile or self._profile,
            "hesdor_escalations": run.escalations,
        }

        # Task failures (1 failed, 2 step budget, 4 cost budget) are left to the verifier.
        if run.is_provider_error:
            raise PROVIDER_ERRORS.get(run.error_category or "", UnknownApiError)(
                f"hesdor provider error ({run.error_category}): {run.error}"
            )
        if run.outcome == "crashed":
            raise RuntimeError(f"hesdor exited {run.exit_code} without a result; see {LOG}/hesdor.stderr")
