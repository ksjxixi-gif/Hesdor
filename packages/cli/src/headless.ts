import {
  buildSystemPrompt,
  findGitRoot,
  runAgentLoop,
} from '@hesdor/agent-core'
import type { ToolContext } from '@hesdor/agent-core'
import type { AgentMode, RunEvent } from '@hesdor/protocol'
import type { CliFlags } from './args.js'
import { loadConfig } from './config.js'
import { createSelectedProvider, resolveSelection } from './provider-setup.js'
import { createSession } from './session.js'

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const TOOL_VERBS: Record<string, string> = {
  list_files: 'Listing',
  read_file: 'Reading',
  read_files: 'Reading',
  search_files: 'Searching',
  write_file: 'Writing',
  apply_patch: 'Updating',
  delete_file: 'Deleting',
  run_command: 'Running',
  stop_command: 'Stopping',
  git_status: 'Status',
  git_diff: 'Diffing',
  git_log: 'History',
  explore: 'Exploring',
}

const SUBAGENT_SYSTEM =
  'You are Hesdor\'s exploratory subagent. Investigate the given task using ONLY read tools (list_files, search_files, read_file, read_files, git_status, git_log). ' +
  'Answer the task precisely in your final message and nothing else. Keep the answer under 800 words. If you cannot answer, say so. You have no write or execute permissions.'

/** "read_file src/auth.ts" -> "Reading src/auth.ts" */
function prettySummary(summary: string): string {
  const spaceIdx = summary.indexOf(' ')
  const name = spaceIdx < 0 ? summary : summary.slice(0, spaceIdx)
  const rest = spaceIdx < 0 ? '' : summary.slice(spaceIdx + 1)
  const verb = TOOL_VERBS[name] ?? name
  return rest ? `${verb} ${rest}` : verb
}

/**
 * Non-interactive execution of one prompt (run / ask / plan).
 * Assistant text goes to stdout; activity goes to stderr so pipes stay clean.
 */
export async function runHeadless(mode: AgentMode, prompt: string, flags: CliFlags): Promise<number> {
  const root = findGitRoot(process.cwd())
  if (!root) {
    console.error(`✗ not inside a Git repository. cd into a project or run \`git init\` first.`)
    return 1
  }

  const session = await createSession({ root, warn: (m) => console.error(`${DIM}• ${m}${RESET}`) })
  const info = session.info

  let provider
  try {
    const cfg = await loadConfig()
    const sel = await resolveSelection(flags, cfg)
    if (sel.keySource === 'none') {
      throw new Error(
        `no API credential found — run \`hesdor setup\` to save a key${sel.envKey ? ` or export ${sel.envKey}` : ''}`,
      )
    }
    provider = createSelectedProvider(sel)
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const registry = session.registry
  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.on('SIGINT', onSigint)

  let printedOutputLines = 0

  const emit = (event: RunEvent): void => {
    if (flags.debug) console.error(`${DIM}[debug] ${JSON.stringify(event)}${RESET}`)
    switch (event.type) {
      case 'assistant.delta':
        process.stdout.write(event.text)
        break
      case 'tool.started':
        console.error(`${DIM}${YELLOW}●${RESET}${DIM} ${prettySummary(event.summary)}${RESET}`)
        break
      case 'tool.failed':
        console.error(`${RED}  ✗ ${event.name}: ${event.error}${RESET}`)
        break
      case 'command.output':
        if (printedOutputLines < 100) {
          printedOutputLines++
          console.error(`${DIM}  │ ${event.line}${RESET}`)
        } else if (printedOutputLines === 100) {
          printedOutputLines++
          console.error(`${DIM}  │ … (further output hidden)${RESET}`)
        }
        break
      case 'run.failed':
        console.error(`${RED}✗ run failed: ${event.error}${RESET}`)
        break
      default:
        break
    }
  }

  const ctx: ToolContext = {
    root,
    mode,
    model: provider.model,
    signal: controller.signal,
    emit,
    // Headless runs either auto-approve (--yes) or are denied before this is called.
    requestApproval: () => Promise.resolve(flags.yes),
    approvalsEnabled: flags.yes,
    state: { activeChild: null, snapshots: [], redo: [] },
    subagent: async (task, subMaxSteps = 5) => {
      const subCtx: ToolContext = {
        root,
        mode: 'ask',
        model: provider.model,
        signal: controller.signal,
        emit: () => {},
        requestApproval: () => Promise.resolve(false),
        approvalsEnabled: false,
        state: { activeChild: null, snapshots: [], redo: [] },
      }
      const subResult = await runAgentLoop({
        provider,
        registry: registry.readOnly(),
        ctx: subCtx,
        systemPrompt: SUBAGENT_SYSTEM,
        userPrompt: task,
        history: [],
        maxSteps: Math.min(subMaxSteps, 10),
      })
      const lastText =
        [...subResult.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim() !== '')?.content ?? ''
      return lastText ? lastText.slice(0, 6000) : (subResult.error ?? 'subagent produced no answer')
    },
  }

  try {
    const system = session.skillsSection
      ? `${buildSystemPrompt(info, mode)}\n\n${session.skillsSection}`
      : buildSystemPrompt(info, mode)
    const result = await runAgentLoop({
      provider,
      registry,
      ctx,
      systemPrompt: system,
      userPrompt: prompt,
      plugins: session.plugins,
      ...(flags.maxSteps ? { maxSteps: flags.maxSteps } : {}),
    })
    process.stdout.write('\n')
    switch (result.status) {
      case 'completed':
        return 0
      case 'cancelled':
        console.error(`${YELLOW}• run cancelled${RESET}`)
        return 130
      case 'max_steps':
        console.error(`${YELLOW}• stopped: tool-call step budget reached (raise with --max-steps)${RESET}`)
        return 2
      case 'failed':
        return 1
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    session.dispose()
  }
}
