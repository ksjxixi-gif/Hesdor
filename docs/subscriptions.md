# Use your subscription

Hesdor uses a subscription only where the vendor allows third-party, locally run tools to use it.

| Subscription | Supported | How |
|---|---|---|
| ChatGPT (Plus, Pro, Business, …) | Yes, through OpenAI's official "ChatGPT plan usage" for open-source apps | `hesdor login chatgpt` (or `hesdor setup` → Continue with ChatGPT), then `--provider chatgpt`. Requests count against your ChatGPT plan, never paid API billing; at the plan limit Hesdor stops or uses your fallback role. Manage usage at https://chatgpt.com/settings/usage |
| Qwen Coding Plan | Interactive only | `--provider qwen-coding-plan` with your `sk-sp-` key in `ALIBABA_CODING_PLAN_API_KEY`. The plan's terms forbid automated use, so `hesdor run/ask/plan/review` refuse it; the TUI and editors (ACP) work. |
| Qwen Coding Plan (China) | Interactive only | `--provider qwen-coding-plan-cn`, same key variable and terms as above. |
| MiniMax Token Plan | Yes | `--provider minimax` (or `minimax-cn`) `--model MiniMax-M3.1-Flash` with your `sk-cp-` plan key in `MINIMAX_API_KEY`. |
| Z.ai GLM Coding Plan | Yes, with the plan's API key | `--provider zai-coding-plan` with `ZAI_API_KEY`; China accounts: `zhipu-coding-plan` with `ZHIPU_API_KEY`. |
| Kimi Code, OpenCode Go, Chutes, Cerebras Code, Synthetic, Ollama Cloud | Yes, with the plan's API key | `--provider kimi-code` (China: `kimi-code-cn`), `opencode-go` (also `opencode-go-anthropic` and `opencode-go-responses` for models on those APIs), `chutes`, `cerebras`, `synthetic` or `ollama-cloud`. |
| Claude Pro / Max / Team (claude.ai login) | Through your own Claude Code | Install Claude Code, sign in with `claude auth login`, then `--provider claude-code`. Hesdor runs your Claude Code and shows its work; see [Claude Code](#claude-code) below. Hesdor's own agent cannot use the plan: Anthropic does not allow claude.ai sign-in in third-party apps. Max, Ultra and Team plans also include monthly API credits that work with a normal API key: see https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers |
| Google sign-in (Gemini, AI Pro/Ultra, Antigravity) | No | Google does not allow its consumer sign-in in third-party tools. Use a Gemini API key with `--provider gemini`. |

## Claude Code

With `--provider claude-code` (or `hesdor setup` → Claude Code, or `/provider claude-code`), each turn runs your installed, signed-in `claude` in headless mode (`claude -p`) in the workspace, and Hesdor shows its answer, tool calls, file changes and plan in the TUI, headless output and editors. Hesdor never reads or stores a Claude credential; usage counts against the plan you signed in to Claude Code with. Later turns of the same Hesdor session continue the same Claude Code conversation.

- Models: `default` (Claude Code's choice), `opus`, `sonnet`, `haiku`.
- Modes: build lets Claude Code edit files; plan and ask are read-only. Commands run only when your Claude Code permission settings allow them, because nobody is there to approve them; Hesdor reports what was denied.
- Claude Code's own tools, settings, hooks, MCP servers and memory apply. Hesdor's tools, permission rules, checkpoints, guardian, model roles and cost budget do not.
- An API key in `ANTHROPIC_API_KEY` is not passed to Claude Code, so it uses your Claude login. No cost is shown on a plan.
- Not yet: images, and continuing a Claude Code conversation after Hesdor restarts (a resumed Hesdor session starts a new one).

Tokens from `hesdor login chatgpt` are stored owner-only in your user config directory, never in a repository, and `hesdor logout chatgpt` revokes them. They are only ever sent to api.openai.com: other base URLs are refused, redirects are not followed with a token, and the ID token is validated (signature, issuer, audience, nonce).
