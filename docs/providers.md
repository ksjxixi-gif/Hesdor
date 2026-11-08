# Providers and models

Hesdor speaks three wire formats: OpenAI Chat Completions, the OpenAI Responses API (stateless: `store: false`, encrypted reasoning replayed each turn) and the Anthropic Messages API. It ships 44 presets, and you can add any endpoint that speaks one of the three formats.

To use a subscription plan instead of an API key, see [subscriptions.md](subscriptions.md).

## Presets

| Wire | Presets (key variable) |
|---|---|
| Responses | `openai` (`OPENAI_API_KEY`), `xai` (`XAI_API_KEY`), `azure-openai` (`AZURE_OPENAI_API_KEY`; base URL `https://<resource>.openai.azure.com/openai/v1` via setup or `AZURE_OPENAI_BASE_URL`; the model is your deployment name), `chatgpt` (your ChatGPT plan, see [subscriptions.md](subscriptions.md)) |
| Anthropic | `anthropic` (`ANTHROPIC_API_KEY`), `minimax` (`MINIMAX_API_KEY`), `bedrock` (Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`; us-east-1 by default, other regions via `--base-url https://bedrock-runtime.<region>.amazonaws.com/anthropic`), `azure-claude` (Microsoft Foundry: `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_BASE_URL`), `anthropic-compatible` |
| Chat Completions | `hesdor` (Hesdor Cloud) · `openrouter` · `groq` · `deepseek` · `mistral` · `together` · `fireworks` · `opencode-zen` · `opencode-go` · `gemini` · `cerebras` · `sambanova` · `nvidia` · `huggingface` · `cohere` · `deepinfra` · `moonshot` (`MOONSHOT_API_KEY`) · `kimi-code` (`KIMI_API_KEY`) · `zai` (`ZAI_API_KEY`) · `qwen` (`DASHSCOPE_API_KEY`) · `qwen-coding-plan` (`ALIBABA_CODING_PLAN_API_KEY`, interactive only) · `stepfun` (`STEP_API_KEY`) · `vercel` (`AI_GATEWAY_API_KEY`) · `requesty` · `nebius` · `novita` · `baseten` · `chutes` (each `<NAME>_API_KEY`) · `openai-compatible` |
| Local, no key | `ollama` · `lmstudio` · `llamacpp` (`127.0.0.1:9931`, llama.cpp's default since v0.9; older builds use 8080) · `vllm` (start it with `--enable-auto-tool-choice --tool-call-parser <name>`) · `jan` · `litellm` (optional `LITELLM_API_KEY`) |

Gemini also reads `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`, and DeepInfra also reads `DEEPINFRA_API_KEY`. `hesdor --help` lists every key variable. `hesdor auth list` shows which providers have a saved key (never the value) and `hesdor auth logout <provider>` deletes one.

A weekly workflow checks every preset's default model against models.dev.

## Models, effort and limits

`hesdor model <id>` remembers a model per provider, so switching provider never sends another provider's model id. `--effort low|medium|high` sets reasoning effort (Responses `reasoning.effort`, Chat Completions `reasoning_effort`, Anthropic `output_config.effort`); without it the model's default applies. In the TUI, `/effort low|medium|high|default` changes it for the session. `--max-tokens <n>` or `"maxTokens"` in config.json raises the 8192 output-token default.

```bash
hesdor -p openrouter -m anthropic/claude-sonnet-5.5
hesdor -p ollama -m qwen2.5-coder:7b            # fully local
hesdor -p openai-compatible --base-url http://localhost:8080/v1
HESDOR_MY_GATEWAY_API_KEY=... hesdor -p my-gateway --base-url https://example.com/v1
```

Reasoning and thinking state (DeepSeek/GLM/Kimi `reasoning_content`, vLLM/OpenRouter `reasoning`, Gemini `extra_content`, Claude thinking blocks with signatures) is stored and sent back to the endpoint that produced it, which these models require during tool use.

Rate limits, overloads, 5xx and dropped connections are retried up to 4 times with backoff that honors `Retry-After`, only before any output arrived. Provider errors are classified (auth, rate limit, quota, overloaded, context overflow, model not found, ...) and end with a hint on how to fix them. To switch to another model when one fails, see `roles.fallback` in [roles.md](roles.md).

## Cost tracking

A bundled models.dev snapshot gives context limits, prices (including cache read and write tokens) and capabilities. Every request is priced, subagents and model roles included, or the provider's own reported cost is used when it sends one. Headless results carry `cost_usd`, the TUI footer shows session cost and cache hit rate, and `--max-budget-usd <n>` stops a run at the budget (exit code 4). Anthropic requests set prompt-cache breakpoints on the system prompt and the newest message.

## Verify your setup

`hesdor doctor` stays offline. `hesdor doctor --live` also sends three tiny real requests to each provider that has a usable credential (environment or saved key, `apiKeyCommand`, ChatGPT sign-in; local servers only when they answer), one provider at a time:

1. a streamed "reply with the word ok",
2. a call to a no-argument `get_time` tool,
3. the tool result sent back (with any reasoning or thinking state the model returned) and the final answer.

For each provider it reports ok or the failed step with the classified error kind and hint, first-token and total latency, tokens, whether usage and cache fields came back, whether reasoning state was replayed, the model, and the cost at catalog prices. Output is capped at 256 tokens per request (1024 for reasoning or unknown models) with a 60-second timeout. It prints a worst-case cost estimate first and asks before sending anything; pass `--yes` to skip the question.

```bash
hesdor doctor --live                     # every configured provider
hesdor doctor --live -p deepseek --yes   # one provider, no prompt
hesdor doctor --live --yes --output-format json
```

From a source checkout, `pnpm test:live` goes further for every keyed provider: the same check, a two-step `read_file` chain through the real agent loop (replaying reasoning state between steps), prompt-cache fields on a second identical ~5k-token request (Anthropic and Responses wires), and a generated PNG for vision models. Providers without a key are skipped; narrow the run with `pnpm test:live -t anthropic`. Results go to `evals/live/report-<date>.md` (gitignored). `pnpm test` never runs these files.

Expected cost: well under a cent per provider for `doctor --live` on default models, and a few cents per provider for `test:live` (the cache test sends about 10k input tokens). The ChatGPT plan and local servers cost nothing.

## Saved and custom providers

Run `hesdor setup` to save a preset or your own endpoint, format, model and API key in the user profile. Defaults persist in `%APPDATA%\hesdor\config.json` or `~/.config/hesdor/config.json`; credentials are kept separately in the profile and never inside a repository.

For an unknown endpoint, choose `custom` in setup and select `openai`, `openai-responses` or `anthropic` compatibility. For a one-off OpenAI-compatible endpoint, pass `-p <name> --base-url <url>` and set `HESDOR_<NAME>_API_KEY` (for example `HESDOR_MY_GATEWAY_API_KEY`) if it needs authentication; saved custom providers use the same per-name variable, so a key meant for one gateway is never sent to another. `HESDOR_CUSTOM_API_KEY` still works for one-off runs. Custom Anthropic endpoints should use an API root such as `https://gateway.example.com`; Hesdor adds `/v1/messages`.

A saved custom provider in `config.json` accepts a few optional fields:

```json
{
  "customProviders": {
    "my-gateway": {
      "kind": "anthropic",
      "baseUrl": "https://gateway.example.com",
      "authHeader": "bearer",
      "apiKeyCommand": ["op", "read", "op://dev/gateway/key"],
      "extraBody": { "metadata": { "team": "core" } },
      "includeUsage": false
    }
  }
}
```

`authHeader` sends the key as `Authorization: Bearer` instead of `x-api-key` (Anthropic wire). `apiKeyCommand` is an argv array run without a shell; its output is the key and is reused for about 50 minutes (on Windows, wrap batch files as `["cmd", "/c", "get-key.cmd"]`). `extraBody` is merged into every request. `includeUsage: false` stops asking a Chat Completions endpoint for token usage, for servers that reject `stream_options`.

## Proxies and corporate CAs

Set `HTTPS_PROXY`/`HTTP_PROXY` (and `NO_PROXY`); Hesdor applies them on Node 24.14 or newer. On Node 22.21+ also set `NODE_USE_ENV_PROXY=1`. For a TLS-inspecting proxy, point `NODE_EXTRA_CA_CERTS` at your CA's PEM file or set `NODE_USE_SYSTEM_CA=1` (Node 22.19+) to trust the OS store. `hesdor doctor` reports whether the proxy is in effect.

## Hesdor Cloud

Hesdor Cloud pricing is available with `hesdor pricing`: Free ($0, hard limit), Starter ($5/month), Pro ($7/month), and Max ($10/month). Account billing and quota enforcement belong to the Hesdor API service, not the local CLI.
