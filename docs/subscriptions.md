# Use your subscription

Hesdor uses a subscription only where the vendor allows third-party, locally run tools to use it.

| Subscription | Supported | How |
|---|---|---|
| ChatGPT (Plus, Pro, Business, …) | Yes, through OpenAI's official "ChatGPT plan usage" for open-source apps | `hesdor login chatgpt` (or `hesdor setup` → Continue with ChatGPT), then `--provider chatgpt`. Requests count against your ChatGPT plan, never paid API billing; at the plan limit Hesdor stops or uses your fallback role. Manage usage at https://chatgpt.com/settings/usage |
| Qwen Coding Plan | Interactive only | `--provider qwen-coding-plan` with your `sk-sp-` key in `ALIBABA_CODING_PLAN_API_KEY`. The plan's terms forbid automated use, so `hesdor run/ask/plan/review` refuse it; the TUI and editors (ACP) work. |
| MiniMax Coding Plan | Yes | `--provider minimax --model MiniMax-M3.1-Flash` with your `sk-cp-` plan key in `MINIMAX_API_KEY`. |
| Kimi Code, OpenCode Go, Chutes, Cerebras Code | Yes, with the plan's API key | `--provider kimi-code`, `opencode-go`, `chutes` or `cerebras`. |
| Claude Pro / Max (claude.ai login) | No | Anthropic does not allow claude.ai sign-in in third-party apps. Max, Ultra and Team plans include monthly API credits that work with a normal API key: see https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| Google sign-in (Gemini, AI Pro/Ultra, Antigravity) | No | Google does not allow its consumer sign-in in third-party tools. Use a Gemini API key with `--provider gemini`. |

Tokens from `hesdor login chatgpt` are stored owner-only in your user config directory, never in a repository, and `hesdor logout chatgpt` revokes them. They are only ever sent to api.openai.com: other base URLs are refused, redirects are not followed with a token, and the ID token is validated (signature, issuer, audience, nonce).
