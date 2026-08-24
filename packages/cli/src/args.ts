export interface CliFlags {
  model?: string
  provider?: string
  baseUrl?: string
  mode?: string
  yes: boolean
  debug: boolean
  force: boolean
  maxSteps?: number
  version: boolean
  help: boolean
}

export const VERSION = '0.1.0'

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
  /** For run/ask/plan: the prompt. For model/provider/setup: an optional value. */
  prompt: string
  flags: CliFlags
}

const HELP = `Hesdor — local-first AI software engineering agent

Usage:
  hesdor                       Start interactive mode in the current repository
  hesdor "<prompt>"            Start interactive and immediately run the prompt
  hesdor run "<prompt>"        Agent with write+execute access (build mode)
  hesdor plan "<task>"         Read-only implementation planning
  hesdor ask "<question>"      Read-only question answering about the repo

Setup:
  hesdor setup                 Choose provider, store API key, set default model
  hesdor pricing               Show Hesdor Cloud plans
  hesdor provider [<id>]       Show or set the default provider
  hesdor model [<id>]          Show or set the default model
  hesdor init                  Create HESDOR.md and .hesdorignore starters
  hesdor doctor                Check environment, tools and credentials

Options:
  -p, --provider <name>        Provider preset (openai, anthropic, openrouter,
                               groq, deepseek, mistral, together, fireworks,
                               hesdor, xai, opencode-zen, opencode-go, gemini,
                               cerebras, sambanova, perplexity,
                               nvidia, huggingface, cohere, deepinfra, ollama,
                               lmstudio,
                               openai-compatible, anthropic-compatible, or any
                               custom provider saved by \`hesdor setup\`
  -m, --model <model>          Model id for the provider
      --base-url <url>         Override the provider endpoint
      --mode <mode>            Interactive default mode: build | plan | ask
      --max-steps <n>          Tool-call step budget per run (default 30)
  -y, --yes                    Approve risky commands without prompting
  -f, --force                  hesdor init: overwrite existing files
  -d, --debug                  Verbose event logging
  -h, --help                   Show this help
  -v, --version                Show version

Environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
  DEEPSEEK_API_KEY, MISTRAL_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY,
  XAI_API_KEY, OPENCODE_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY,
  SAMBANOVA_API_KEY,
  PERPLEXITY_API_KEY, NVIDIA_API_KEY, HF_TOKEN, COHERE_API_KEY,
  DEEPINFRA_TOKEN, OPENAI_COMPATIBLE_API_KEY, ANTHROPIC_COMPATIBLE_API_KEY,
  HESDOR_API_KEY, HESDOR_BASE_URL, HESDOR_CUSTOM_API_KEY — or save keys once
  with \`hesdor setup\`.
  Keys are never stored inside repositories.

Extensions (project .hesdor/ dir, global config dir):
  commands/<name>.md   custom slash commands; $ARGUMENTS in the template
  skills/<name>/SKILL.md  workflows the model loads via read_skill
  plugins/*.js         hooks: tool.execute.before/after, event
  mcp.json             MCP servers: { "mcp": { "name": { "command": "...", "args": [] } } }

Docs: https://github.com/hesdor/hesdor`

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
        // Only the first keyword selects the command; later ones are prompt text
        // (so `hesdor ask plan a refactor` works).
        if (command === 'interactive') command = arg
        else positional.push(arg)
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
        if (arg.startsWith('-')) throw new Error(`unknown flag "${arg}" (see hesdor --help)`)
        positional.push(arg)
    }
  }

  const prompt = positional.join(' ')
  if ((command === 'run' || command === 'ask' || command === 'plan') && prompt.trim() === '') {
    throw new Error(`"hesdor ${command}" needs a prompt, e.g. hesdor ${command} "explain the auth flow"`)
  }
  return { command, prompt: prompt.trim(), flags }
}

export function helpText(): string {
  return HELP
}
