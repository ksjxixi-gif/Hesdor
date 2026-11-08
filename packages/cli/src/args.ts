export interface CliFlags {
  model?: string
  provider?: string
  baseUrl?: string
  mode?: string
  yes: boolean
  debug: boolean
  force: boolean
  maxSteps?: number
  /** Headless: stop the run once its cost reaches this many USD. */
  maxBudgetUsd?: number
  /** Reasoning effort sent to the model. */
  effort?: 'low' | 'medium' | 'high'
  /** Model profile: picks the main model and roles by which keys are set (profiles.ts). */
  profile?: 'economy' | 'balanced' | 'frontier'
  /** Output token ceiling per model call. */
  maxTokens?: number
  /** Load this repository's plugins and MCP servers without asking. */
  trustWorkspace?: boolean
  /** Headless output: text (default), json (one result object) or stream-json (one event per line). */
  outputFormat?: 'text' | 'json' | 'stream-json'
  /** Headless: also write the final answer to this file. */
  outputFile?: string
  /** Resume the newest session for this workspace. */
  continue?: boolean
  /** Resume this session id (or unique prefix). */
  resume?: string
  /** Allow the home directory or a filesystem root as the workspace. */
  allowHome?: boolean
  /** Headless: allow running as root (uid 0). */
  allowRoot?: boolean
  /** Headless: let the guardian model approve risky commands that would otherwise be refused. */
  guardian?: boolean
  /** run: keep starting turns until the goal evaluator says this condition is met (see goal.ts). */
  goal?: string
  /** run --goal: most turns before giving up (default 10). */
  maxGoalTurns?: number
  /** run/ask/plan: image files attached to the prompt (`--image`, repeatable). */
  images?: string[]
  /** run/ask/plan: run in a new git worktree; '' picks a name. */
  worktree?: string
  /** review: compare HEAD with the merge base of this ref. */
  base?: string
  /** review: review staged, unstaged and untracked changes instead of commits. */
  uncommitted?: boolean
  /** review: lowest priority that makes the exit code 5 (default P1). */
  severity?: 'P0' | 'P1' | 'P2' | 'P3'
  /** export: output format. */
  format?: 'md' | 'html' | 'json'
  /** export: replace likely secrets with [REDACTED]. */
  redact?: boolean
  /** export/import: use the newest session. */
  latest?: boolean
  version: boolean
  help: boolean
}

/** Set by esbuild --define from package.json at build time; absent under tsc and vitest. */
declare const __HESDOR_VERSION__: string | undefined
export const VERSION = typeof __HESDOR_VERSION__ === 'string' ? __HESDOR_VERSION__ : '0.0.0-dev'

export interface ParsedArgs {
  command:
    | 'interactive'
    | 'run'
    | 'ask'
    | 'plan'
    | 'init'
    | 'doctor'
    | 'setup'
    | 'pricing'
    | 'model'
    | 'provider'
    | 'auth'
    | 'login'
    | 'logout'
    | 'acp'
    | 'policy'
    | 'mcp'
    | 'export'
    | 'import'
    | 'upgrade'
    | 'review'
    | 'config'
  /** For run/ask/plan: the prompt. For review: optional extra focus. For model/provider/setup: an optional value. */
  prompt: string
  flags: CliFlags
  /** policy, mcp: the words after the keyword, verbatim (a command's own flags are not parsed as Hesdor's). */
  args?: string[]
}

const HELP = `Hesdor — local-first AI software engineering agent

Usage:
  hesdor                       Start interactive mode in the current repository
  hesdor "<prompt>"            Start interactive and immediately run the prompt
  hesdor run "<prompt>"        Agent with write+execute access (build mode)
  hesdor plan "<task>"         Read-only implementation planning
  hesdor ask "<question>"      Read-only question answering about the repo
  hesdor review ["<focus>"]    Read-only review of HEAD against the merge base
                               with the default branch: P0-P3 findings

Setup:
  hesdor setup                 Choose provider, store API key, set default model
  hesdor login chatgpt         Continue with ChatGPT: use your ChatGPT plan
                               (browser sign-in, no API key)
  hesdor logout chatgpt        Sign out of ChatGPT and revoke the session
  hesdor pricing               Show Hesdor Cloud plans
  hesdor provider [<id>]       Show or set the default provider
  hesdor model [<id>]          Show or set the default model (per provider)
  hesdor auth list             Providers with a saved key (values hidden)
  hesdor auth logout <id>      Delete a provider's saved key
  hesdor init                  Create HESDOR.md and .hesdorignore starters
  hesdor doctor                Check environment, tools and credentials
  hesdor policy check <cmd...> Show whether run_command would allow, ask or
                               deny a command, and which rule decides
  hesdor mcp list              MCP servers: scope, transport, status, login
  hesdor mcp add <name> <command...> | --url <url>
                               Add a server to your user mcp.json
  hesdor mcp login|logout <name>
                               OAuth login (browser) or forget tokens
  hesdor acp                   Serve the Agent Client Protocol on stdio (Zed,
                               JetBrains, Neovim); flags as for run
  hesdor export [<id>|--latest] [--format md|html|json] [-o <file>] [--redact]
                               Export a saved session (default: newest, md);
                               --redact replaces likely secrets
  hesdor import claude|codex [<path or id>] [--latest]
                               Import a Claude Code or Codex session for this
                               workspace (source files are only read)
  hesdor upgrade               Print the upgrade command for this install
  hesdor config list           Effective settings and the layer that set each
                               (managed, flag, env, project, user, default)
  hesdor config get <key>      One effective value, e.g. config get maxTokens
  hesdor config set <key> <value>
                               Save a validated value in your user config.json

Options:
  -p, --provider <name>        Provider preset (openai, anthropic, openrouter,
                               groq, deepseek, mistral, together, fireworks,
                               hesdor, xai, opencode-zen, opencode-go, gemini,
                               cerebras, sambanova, nvidia, huggingface,
                               cohere, deepinfra, moonshot, kimi-code, zai,
                               qwen, qwen-coding-plan, minimax, stepfun,
                               vercel, requesty, chatgpt, nebius, novita,
                               baseten, chutes, bedrock, azure-claude,
                               azure-openai, ollama, lmstudio, litellm,
                               llamacpp, vllm, jan, openai-compatible,
                               anthropic-compatible, or any
                               custom provider saved by \`hesdor setup\`
  -m, --model <model>          Model id for the provider
      --base-url <url>         Override the provider endpoint
      --effort <level>         Reasoning effort: low | medium | high
      --profile <name>         economy | balanced | frontier: pick the model
                               and roles from the keys you have (docs/roles.md)
      --max-tokens <n>         Output token limit per model call (default 8192,
                               or maxTokens in config.json)
      --mode <mode>            Interactive default mode: build | plan | ask
      --max-steps <n>          Tool-call step budget per run (default 100)
  -y, --yes                    Approve risky commands without prompting
      --trust-workspace        Load this repo's .hesdor plugins and MCP servers
                               without asking (they run code on your machine)
  -c, --continue               Resume the latest session for this workspace
  -r, --resume <id>            Resume a session by id (see /sessions)
      --allow-home             Allow your home directory or a filesystem root
                               as the workspace (outside a Git repository the
                               current directory is used)
      --allow-root             Allow headless runs as root (refused by default)
  -f, --force                  hesdor init: overwrite existing files
  -d, --debug                  Verbose event logging
  -h, --help                   Show this help
  -v, --version                Show version

Environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
  DEEPSEEK_API_KEY, MISTRAL_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY,
  XAI_API_KEY, OPENCODE_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY), CEREBRAS_API_KEY, SAMBANOVA_API_KEY,
  NVIDIA_API_KEY, HF_TOKEN, COHERE_API_KEY, DEEPINFRA_TOKEN (or
  DEEPINFRA_API_KEY), OPENAI_COMPATIBLE_API_KEY, ANTHROPIC_COMPATIBLE_API_KEY,
  HESDOR_API_KEY, HESDOR_BASE_URL, HESDOR_<PROVIDER_ID>_API_KEY for a custom
  provider (HESDOR_CUSTOM_API_KEY for one-off --base-url runs) — or save keys
  once with \`hesdor setup\`.
  Keys are never stored inside repositories.
  Each preset reads its own key variable (see the README's Providers section).
  Proxy: HTTPS_PROXY / HTTP_PROXY / NO_PROXY (Node 24.14+, or set
  NODE_USE_ENV_PROXY=1 on Node 22.21+). Corporate CA: NODE_EXTRA_CA_CERTS=<pem>
  or NODE_USE_SYSTEM_CA=1.

Headless (run/ask/plan):
      --output-format <fmt>    text (default) | json (one result object) |
                               stream-json (init event, every run event, result)
  -o, --output <file>          Also write the final answer to <file>
      --image <file>           Attach a PNG, JPEG, GIF or WebP image (up to
                               3.75 MB) to the prompt; repeatable. @path.png
                               in the prompt attaches workspace images too
      --max-budget-usd <n>     Stop once the run's cost reaches $n (catalog
                               prices; the model must have known prices)
      --guardian               Let the guardian model (config guardian.model or
                               roles.small) approve risky commands; a deny or
                               error refuses them
      --goal "<condition>"     run: after each turn an evaluator model
                               (roles.small or the main model) checks the
                               condition; keeps going until met. Exit 0 met,
                               6 impossible or out of turns
      --max-goal-turns <n>     Turn limit for --goal (default 10)
      --worktree[=name]        Run in a new git worktree
                               .hesdor/worktrees/<name> on branch
                               hesdor/<name> (name generated if omitted);
                               kept when it has changes
  A prompt of "-" (or none, with piped stdin) is read from stdin.
  Exit codes: 0 completed, 1 failed, 2 step budget reached, 3 provider error
  (auth, network, rate limit after retries, quota), 4 cost budget reached,
  130 cancelled.

Review (hesdor review):
      --base <ref>             Compare HEAD with its merge base with <ref>
                               (default origin/HEAD, origin/main, main, ...)
      --uncommitted            Review staged, unstaged and untracked changes
      --severity <P0-P3>       Lowest priority that fails the review
                               (default P1)
      --output-format <fmt>    text (default, Markdown) | json
  -o, --output <file>          Also write the Markdown report to <file>
  Exit code 5: at least one finding at or above --severity; others as headless.

Extensions (project .hesdor/ dir, global config dir):
  commands/<name>.md           Custom slash commands; $ARGUMENTS in the template
  skills/<name>/SKILL.md       Workflows the model loads via read_skill
  plugins/*.js                 Hooks: tool.execute.before/after, event
  mcp.json                     MCP servers:
                               { "mcp": { "<name>": { "command": "...",
                                 "args": [] } } }

Docs: https://github.com/ksjxixi-gif/Hesdor`

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = { yes: false, debug: false, force: false, version: false, help: false }
  const positional: string[] = []
  let command: ParsedArgs['command'] = 'interactive'

  const needValue = (flag: string): string => {
    const value = argv.shift()
    if (value === undefined) {
      throw new Error(`flag ${flag} requires a value`)
    }
    return value
  }

  while (argv.length > 0) {
    const arg = argv.shift()!
    switch (arg) {
      case 'run':
      case 'ask':
      case 'plan':
      case 'init':
      case 'doctor':
      case 'setup':
      case 'pricing':
      case 'model':
      case 'provider':
      case 'auth':
      case 'login':
      case 'logout':
      case 'acp':
      case 'export':
      case 'import':
      case 'upgrade':
      case 'review':
        // Only a keyword in first position selects the command; anywhere else it is
        // prompt text (`hesdor fix the init script` must not run `init`).
        if (command === 'interactive' && positional.length === 0) command = arg
        else positional.push(arg)
        break
      case 'policy':
      case 'mcp':
      case 'config':
        // `hesdor policy check git push -f`, `hesdor mcp add fs npx -y pkg`: the rest is verbatim.
        if (command === 'interactive' && positional.length === 0) {
          return { command: arg, prompt: argv.join(' '), flags, args: argv.splice(0) }
        }
        positional.push(arg)
        break
      case '--':
        positional.push(...argv.splice(0))
        break
      case '--trust-workspace':
        flags.trustWorkspace = true
        break
      case '--worktree':
        // Takes no value (a following word is the prompt, so `--worktree cleanup` means prompt "cleanup"); name it with --worktree=<name>.
        flags.worktree = ''
        break
      case '--base': {
        const base = needValue(arg)
        if (base.startsWith('-')) throw new Error(`invalid --base "${base}"`) // would be read as a git option
        flags.base = base
        break
      }
      case '--uncommitted':
        flags.uncommitted = true
        break
      case '--severity': {
        const severity = needValue(arg).toUpperCase()
        if (severity !== 'P0' && severity !== 'P1' && severity !== 'P2' && severity !== 'P3') throw new Error(`invalid --severity "${severity}" (P0 | P1 | P2 | P3)`)
        flags.severity = severity
        break
      }
      case '--output-format': {
        const format = needValue(arg)
        if (format !== 'text' && format !== 'json' && format !== 'stream-json') {
          throw new Error(`invalid --output-format "${format}" (text | json | stream-json)`)
        }
        flags.outputFormat = format
        break
      }
      case '-o':
      case '--output':
        flags.outputFile = needValue(arg)
        break
      case '-c':
      case '--continue':
        flags.continue = true
        break
      case '-r':
      case '--resume':
        flags.resume = needValue(arg)
        break
      case '--allow-home':
        flags.allowHome = true
        break
      case '--format': {
        const format = needValue(arg)
        if (format !== 'md' && format !== 'html' && format !== 'json') throw new Error(`invalid --format "${format}" (md | html | json)`)
        flags.format = format
        break
      }
      case '--redact':
        flags.redact = true
        break
      case '--latest':
        flags.latest = true
        break
      case '--allow-root':
        flags.allowRoot = true
        break
      case '--goal': {
        const goal = needValue(arg).trim()
        if (goal === '') throw new Error('--goal needs a condition')
        flags.goal = goal
        break
      }
      case '--max-goal-turns': {
        const n = Number(needValue(arg))
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--max-goal-turns must be an integer between 1 and 100')
        flags.maxGoalTurns = n
        break
      }
      case '--guardian':
        flags.guardian = true
        break
      case '--image':
        ;(flags.images ??= []).push(needValue(arg))
        break
      case '-':
        // "read the prompt from stdin"
        positional.push(arg)
        break
      case '-p':
      case '--provider':
        flags.provider = needValue(arg)
        break
      case '-m':
      case '--model':
        flags.model = needValue(arg)
        break
      case '--base-url':
        flags.baseUrl = needValue(arg)
        break
      case '--mode': {
        const mode = needValue(arg)
        if (!['build', 'plan', 'ask'].includes(mode)) throw new Error(`invalid mode "${mode}"`)
        flags.mode = mode
        break
      }
      case '--effort': {
        const effort = needValue(arg)
        if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error(`invalid --effort "${effort}" (low | medium | high)`)
        flags.effort = effort
        break
      }
      case '--profile': {
        const profile = needValue(arg)
        if (profile !== 'economy' && profile !== 'balanced' && profile !== 'frontier') throw new Error(`invalid --profile "${profile}" (economy | balanced | frontier)`)
        flags.profile = profile
        break
      }
      case '--max-tokens': {
        const n = Number(needValue(arg))
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new Error('--max-tokens must be a positive integer')
        flags.maxTokens = n
        break
      }
      case '--max-budget-usd': {
        const n = Number(needValue(arg))
        if (!Number.isFinite(n) || n <= 0) throw new Error('--max-budget-usd must be a positive number')
        flags.maxBudgetUsd = n
        break
      }
      case '--max-steps': {
        const n = Number(needValue(arg))
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('--max-steps must be an integer between 1 and 200')
        flags.maxSteps = n
        break
      }
      case '-y':
      case '--yes':
        flags.yes = true
        break
      case '-d':
      case '--debug':
        flags.debug = true
        break
      case '-f':
      case '--force':
        flags.force = true
        break
      case '-h':
      case '--help':
        flags.help = true
        break
      case '-v':
      case '--version':
        flags.version = true
        break
      default:
        if (arg.startsWith('--worktree=')) {
          const name = arg.slice('--worktree='.length)
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`invalid worktree name "${name}" (letters, digits, . _ -)`)
          flags.worktree = name
          break
        }
        if (arg.startsWith('-')) throw new Error(`unknown flag "${arg}" (see hesdor --help)`)
        positional.push(arg)
    }
  }

  const prompt = positional.join(' ')
  if ((flags.goal !== undefined || flags.maxGoalTurns !== undefined) && command !== 'run') throw new Error('--goal works with run')
  if (flags.worktree !== undefined && command !== 'run' && command !== 'ask' && command !== 'plan') {
    throw new Error('--worktree works with run, ask and plan')
  }
  // With piped stdin an empty prompt is fine: headless reads it from there.
  if ((command === 'run' || command === 'ask' || command === 'plan') && prompt.trim() === '' && process.stdin.isTTY) {
    throw new Error(`"hesdor ${command}" needs a prompt, e.g. hesdor ${command} "explain the auth flow"`)
  }
  return { command, prompt: prompt.trim(), flags }
}

export function helpText(): string {
  return HELP
}
