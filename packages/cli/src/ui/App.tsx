import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, measureElement, Text, useApp, useInput } from 'ink'
import type { DOMElement } from 'ink'
import TextInput from 'ink-text-input'
import type { ApprovalRequest, Checkpoint, McpElicitRequest, McpElicitResult, RepoContextInfo, ToolContext } from '@hesdor/agent-core'
import { listCheckpoints, loginMcpServer, mcpAuthStatus, redoLastChange, renderTodos, rewindFiles, undoLastChange } from '@hesdor/agent-core'
import type { AgentMode, ChatMessage, RunEvent } from '@hesdor/protocol'
import { chatgptSignedIn, fetchModels, getModelInfo, getPreset, PROVIDER_PRESETS, readChatGPTAuth } from '@hesdor/providers'
import { loadConfig, modelIdError, PROVIDER_ID_RE, saveConfig } from '../config.js'
import type { HesdorConfig } from '../config.js'
import { listRows, loadEffectiveConfig, projectConfigTrusted } from '../config-layers.js'
import type { ManagedSettings } from '../config-layers.js'
import { chatgptPlanNotice, chooseChatGPTModel, loginChatGPT } from '../chatgpt-login.js'
import { runGoal } from '../goal.js'
import { promptImages } from '../images.js'
import { resolveRoles } from '../roles.js'
import type { Roles } from '../roles.js'
import type { ProviderSelection } from '../provider-setup.js'
import { createSelectedProvider, presetEnvKeys, resolveSelection } from '../provider-setup.js'
import { loadAuth, saveCredential } from '../auth.js'
import type { Session } from '../session.js'
import { listSessions, loadSession, newSessionId, saveSession, titleFrom } from '../sessions.js'
import type { StoredSession } from '../sessions.js'
import { agentProviderFor, prettySummary, runTurn, systemPromptFor } from '../run.js'
import { addUserAllowRule } from '../policy-cmd.js'
import { formatStatus } from '../status.js'
import type { CliFlags } from '../args.js'
import { VERSION } from '../args.js'
import { DiffReview, useArmed, type DiffReviewRequest } from './DiffReview.js'
import { ElicitForm } from './ElicitForm.js'
import { ListPicker, PromptBox } from './pickers.js'
import {
  addTurn,
  continuingTurn,
  displayWidth,
  expandCommand,
  goalNotice,
  imageNotices,
  managedLock,
  modelForProvider,
  paletteTarget,
  providerRefusal,
  READ_ONLY_COMMANDS,
  rewindChat,
  runFlags,
  selectionProblem,
  turnNotice,
  wrapText,
} from './logic.js'
import type { SessionStats } from './logic.js'

type Item =
  | { key: number; kind: 'user'; text: string }
  | { key: number; kind: 'assistant'; text: string; live: boolean }
  /** nested: a call made by the explore subagent. */
  | { key: number; kind: 'tool'; callId: string; label: string; state: 'run' | 'ok' | 'fail'; nested?: boolean }
  | { key: number; kind: 'status'; text: string; tone: 'info' | 'error' | 'warn' | 'success' }

type NewItem = DistributiveOmit<Item, 'key'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

interface CommandInfo {
  name: string
  description: string
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: 'help', description: 'list commands' },
  { name: 'model', description: 'pick a model (searchable)' },
  { name: 'provider', description: 'switch AI provider' },
  { name: 'mode', description: 'build | plan | ask' },
  { name: 'effort', description: 'reasoning effort low | medium | high' },
  { name: 'status', description: 'session, model and cost' },
  { name: 'goal', description: 'work until a condition holds' },
  { name: 'config', description: 'effective settings and their source' },
  { name: 'mcp', description: 'mcp servers and login' },
  { name: 'rewind', description: 'restore files/chat to a checkpoint' },
  { name: 'tools', description: 'registered tools' },
  { name: 'skills', description: 'available skills' },
  { name: 'plugins', description: 'plugins & mcp servers' },
  { name: 'undo', description: 'revert last file change' },
  { name: 'redo', description: 're-apply last undo' },
  { name: 'sessions', description: 'recent conversations' },
  { name: 'resume', description: 'continue session #n' },
  { name: 'compact', description: 'summarize context' },
  { name: 'reload', description: 'rescan extensions' },
  { name: 'new', description: 'fresh session' },
  { name: 'clear', description: 'clear transcript' },
  { name: 'exit', description: 'quit hesdor' },
]

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 30,
  })
  useEffect(() => {
    const onResize = (): void =>
      setSize({ columns: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 })
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off?.('resize', onResize)
    }
  }, [])
  return size
}

function itemPrefix(item: Item): string {
  if (item.kind === 'user') return '❯ '
  if (item.kind === 'assistant') return '◆ '
  if (item.kind === 'tool') return `${item.nested ? '    ↳ ' : ''}${item.state === 'run' ? '● ' : item.state === 'ok' ? '✓ ' : '✗ '}`
  return ''
}

/** One terminal row of the transcript: the transcript scrolls by rows, not items (CLI-15). */
interface Row {
  key: string
  item: Item
  /** Prefix on the item's first row, blank indent on the rest. */
  lead: string
  text: string
}

function TranscriptRow({ row }: { row: Row }): React.ReactElement {
  const { item, lead, text } = row
  if (item.kind === 'user') {
    return (
      <Text color="cyan" bold wrap="truncate">
        {lead}
        {text}
      </Text>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <Text color={item.live ? 'gray' : undefined} wrap="truncate">
        <Text color="cyan">{lead}</Text>
        {text}
      </Text>
    )
  }
  if (item.kind === 'tool') {
    return (
      <Text
        dimColor={item.nested || item.state !== 'fail'}
        color={item.nested ? undefined : item.state === 'fail' ? 'red' : item.state === 'ok' ? 'green' : 'yellow'}
        wrap="truncate"
      >
        {lead}
        {text}
      </Text>
    )
  }
  return (
    <Text
      dimColor={item.tone === 'info'}
      color={item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : item.tone === 'success' ? 'green' : undefined}
      wrap="truncate"
    >
      {text}
    </Text>
  )
}

/** Transcript items for a stored conversation. */
function historyItems(messages: ChatMessage[]): NewItem[] {
  return messages.flatMap<NewItem>((m) => {
    if (m.role === 'user') return [{ kind: 'user', text: m.content }]
    if (m.role === 'assistant' && m.content.trim() !== '') return [{ kind: 'assistant', text: m.content, live: false }]
    return []
  })
}

export interface AppProps {
  info: RepoContextInfo
  flags: CliFlags
  providerId: string
  initialModel: string
  session: Session
  /** Prompt from `hesdor "<prompt>"` — auto-submitted once on mount. */
  initialPrompt?: string
  keySource?: string
  /** Session from `--continue`/`--resume`, restored on mount. */
  resumed?: StoredSession
  /** Startup warnings shown in the transcript (the terminal is hidden behind the UI). */
  notices?: string[]
}

type PickerState =
  | { kind: 'provider'; customProviders: string[] }
  | { kind: 'model'; providerId: string; loading: boolean; error?: string; models: string[] }
  | { kind: 'rewind'; loading: boolean; error?: string; checkpoints: Checkpoint[] }
  | { kind: 'rewindMode'; checkpoint: Checkpoint }
  | { kind: 'mcp'; loading: boolean; error?: string; servers: Array<{ value: string; label: string; hint: string }> }
  | null

interface Elicit {
  id: number
  server: string
  request: McpElicitRequest
  resolve: (result: McpElicitResult) => void
}

const NO_ROLES: Roles = { fallback: [], status: [], warnings: [] }

type Effort = NonNullable<CliFlags['effort']>

type SetupState = { kind: 'url'; provider: string } | { kind: 'key'; provider: string } | null

export function App({
  info,
  flags,
  providerId: initialProviderId,
  initialModel,
  session,
  initialPrompt,
  keySource,
  resumed,
  notices,
}: AppProps): React.ReactElement {
  const { exit } = useApp()
  const size = useTerminalSize()

  const [mode, setMode] = useState<AgentMode>(flags.mode === 'plan' || flags.mode === 'ask' ? flags.mode : 'build')
  const [providerId, setProviderId] = useState(initialProviderId)
  const [model, setModel] = useState(initialModel)
  const [items, setItems] = useState<Item[]>([])
  const [running, setRunning] = useState(false)
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve: (yes: boolean) => void } | null>(null)
  const [review, setReview] = useState<{ request: DiffReviewRequest; resolve: (approved: boolean) => void } | null>(null)
  const [input, setInput] = useState('')
  // ink-text-input keeps its cursor offset when the value is replaced from outside; remounting puts it at the end.
  const [inputKey, setInputKey] = useState(0)
  const replaceInput = useCallback((value: string): void => {
    setInput(value)
    setInputKey((k) => k + 1)
  }, [])
  const [scrollOffset, setScrollOffset] = useState(0)
  const [paletteSel, setPaletteSel] = useState(0)
  const [picker, setPicker] = useState<PickerState>(null)
  const [setup, setSetup] = useState<SetupState>(null)
  const [effort, setEffort] = useState<Effort | undefined>(flags.effort)
  const [stats, setStats] = useState<SessionStats>({})
  // Bumped by /reload so the palette and prefix matching see new commands (CLI-21).
  const [reloadTick, setReloadTick] = useState(0)
  /** MCP elicitation forms waiting for the user; the first one is shown. */
  const [elicits, setElicits] = useState<Elicit[]>([])
  const elicit = elicits[0]

  const keyCounter = useRef(0)
  const runningRef = useRef(false)
  /** --image files, attached to the first prompt of the session. */
  const launchImagesRef = useRef(flags.images ?? [])
  /** Roles for the current provider/model; the same object across turns (the guardian's breaker lives in it). */
  const rolesRef = useRef<{ key: string; roles: Promise<Roles> } | undefined>(undefined)
  const shownWarningsRef = useRef(new Set<string>())
  const historyRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const queueRef = useRef<string[]>([])
  const sessionIdRef = useRef(newSessionId())
  const sessionCreatedRef = useRef(Date.now())
  /** Session this one continues (after /clear or /compact). */
  const parentIdRef = useRef<string | undefined>(undefined)
  // A queued prompt starts later: it must see the mode and model of that moment, not of the enqueueing render.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const modelRef = useRef(model)
  modelRef.current = model
  const providerIdRef = useRef(providerId)
  providerIdRef.current = providerId
  const effortRef = useRef(effort)
  effortRef.current = effort
  const statsRef = useRef(stats)
  statsRef.current = stats
  const subRunRef = useRef(0)
  const reviewAlwaysRef = useRef(false)
  /** Commands approved with Shift+A this session (argv joined by NUL); also saved as user allow rules. */
  const alwaysArgvRef = useRef(new Set<string>())
  const checkpointNoticeRef = useRef(false)
  /** Backup taken by the last file rewind; /rewind offers restoring it. */
  const rewindBackupRef = useRef<string | undefined>(undefined)
  const maxScrollRef = useRef(0)
  const pageRef = useRef(1)
  // Shared across runs so /undo can restore earlier file changes.
  const stateRef = useRef<ToolContext['state']>({ activeChild: null, snapshots: [], redo: [] })

  const SIDEBAR_W = 30
  const plan = chatgptPlanNotice(providerId)
  // header(3, +1 for the ChatGPT plan line) + input box(3) + footer(3) + safety margin(1)
  const chrome = 10 + (plan ? 1 : 0)
  // Rows taken by the dock under the transcript (palette, pickers, input, prompts, forms), measured after each render.
  const dockRef = useRef<DOMElement>(null)
  const [dockRows, setDockRows] = useState(3)
  const bodyHeight = Math.max(4, size.rows - chrome + 3 - dockRows)

  const pushItem = useCallback((item: NewItem): void => {
    setItems((prev) => [...prev, { ...item, key: ++keyCounter.current } as Item])
  }, [])

  /** Rejection handler for fire-and-forget actions: show the error instead of crashing Node. */
  const reportFailure = useCallback(
    (what: string) =>
      (err: unknown): void =>
        pushItem({ kind: 'status', text: `${what} failed: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
    [pushItem],
  )

  const spinner = useSpinner(running)

  // ── protocol events → transcript items ────────────────────────────────────
  const handleEvent = useCallback(
    (event: RunEvent): void => {
      switch (event.type) {
        case 'assistant.delta': {
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'assistant' && last.live) {
              const copy = prev.slice(0, -1)
              copy.push({ ...last, text: last.text + event.text })
              return copy
            }
            return [...prev, { key: ++keyCounter.current, kind: 'assistant', text: event.text, live: true }]
          })
          break
        }
        case 'assistant.reasoning': {
          // Reasoning text is kept in history, not shown; one dim marker per thinking stretch.
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'status' && last.text === 'thinking…') return prev
            return [...prev, { key: ++keyCounter.current, kind: 'status', text: 'thinking…', tone: 'info' }]
          })
          break
        }
        case 'assistant.message': {
          setItems((prev) => {
            const copy = [...prev]
            for (let i = copy.length - 1; i >= 0; i--) {
              const item = copy[i]
              if (item && item.kind === 'assistant' && item.live) {
                copy[i] = { ...item, text: event.content || item.text, live: false }
                break
              }
            }
            return copy
          })
          break
        }
        case 'tool.started': {
          setItems((prev) => [
            ...prev,
            {
              key: ++keyCounter.current,
              kind: 'tool',
              callId: event.callId,
              label: prettySummary(event.summary),
              state: 'run',
            },
          ])
          break
        }
        case 'tool.completed': {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.callId === event.callId
                ? { ...it, state: 'ok', label: prettySummary(event.summary) }
                : it,
            ),
          )
          break
        }
        case 'tool.failed': {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.callId === event.callId
                ? { ...it, state: 'fail', label: `${it.label} — ${event.error}` }
                : it,
            ),
          )
          break
        }
        case 'provider.retry':
          pushItem({
            kind: 'status',
            text: `retrying in ${Math.ceil(event.delayMs / 1000)}s (${event.reason}, attempt ${event.attempt + 1}/${event.maxAttempts})`,
            tone: 'warn',
          })
          break
        case 'hook.notice':
          pushItem({ kind: 'status', text: `hook ${event.event}: ${event.message}`, tone: 'warn' })
          break
        case 'provider.fallback':
          pushItem({ kind: 'status', text: `${event.from} unavailable (${event.reason}): ${event.to} takes over for the rest of this turn`, tone: 'warn' })
          break
        case 'provider.escalated':
          pushItem({ kind: 'status', text: `stuck (${event.reason.replace('_', ' ')}): escalating from ${event.from} to ${event.to} for the rest of this turn`, tone: 'warn' })
          break
        case 'approval.guardian':
          pushItem(
            event.decision === 'disabled'
              ? { kind: 'status', text: `guardian turned off for this session: ${event.reason}`, tone: 'warn' }
              : {
                  kind: 'status',
                  text: `guardian ${event.decision === 'allow' ? 'allowed' : 'declined, asking you'}: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
                  tone: 'info',
                },
          )
          break
        case 'goal.evaluated':
          pushItem({
            kind: 'status',
            text: `goal check ${event.turn}: ${event.verdict === 'not_yet' ? 'not yet' : event.verdict} · ${event.reason}`,
            tone: event.verdict === 'met' ? 'success' : event.verdict === 'impossible' ? 'warn' : 'info',
          })
          break
        case 'checkpoint.skipped':
          if (!checkpointNoticeRef.current) {
            checkpointNoticeRef.current = true
            pushItem({ kind: 'status', text: `${event.reason} (/rewind is unavailable)`, tone: 'warn' })
          }
          break
        case 'todo.updated':
          pushItem({ kind: 'status', text: `plan\n${renderTodos(event.todos)}`, tone: 'info' })
          break
        case 'context.compacted':
          pushItem({
            kind: 'status',
            text: `context compacted (${event.phase}): ~${event.beforeTokens} → ~${event.afterTokens} tokens`,
            tone: 'info',
          })
          break
        case 'run.completed':
          pushItem(
            event.truncated
              ? { kind: 'status', text: 'stopped: the answer was cut off by the max output token limit', tone: 'warn' }
              : { kind: 'status', text: `done (${event.steps} step${event.steps === 1 ? '' : 's'})`, tone: 'success' },
          )
          break
        case 'run.cancelled':
          pushItem({ kind: 'status', text: 'cancelled', tone: 'warn' })
          break
        case 'run.failed':
          pushItem({ kind: 'status', text: `failed: ${event.error}`, tone: 'error' })
          break
        default:
          break
      }
    },
    [pushItem],
  )

  /** Explore-subagent progress: dimmed, indented tool lines (ids prefixed per subagent run, so they never clash). */
  const handleSubEvent = useCallback((event: RunEvent): void => {
    if (event.type === 'run.started') subRunRef.current++
    const id = (callId: string): string => `sub${subRunRef.current}:${callId}`
    if (event.type === 'tool.started') {
      setItems((prev) => [
        ...prev,
        { key: ++keyCounter.current, kind: 'tool', callId: id(event.callId), label: prettySummary(event.summary), state: 'run', nested: true },
      ])
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      setItems((prev) =>
        prev.map((it) =>
          it.kind === 'tool' && it.callId === id(event.callId)
            ? event.type === 'tool.completed'
              ? { ...it, state: 'ok', label: prettySummary(event.summary) }
              : { ...it, state: 'fail', label: `${it.label} — ${event.error}` }
            : it,
        ),
      )
    }
  }, [])

  /** Save the current transcript (fire-and-forget; a failed save must not break the UI). */
  const persist = useCallback((): void => {
    void saveSession(info.root, {
      id: sessionIdRef.current,
      messages: historyRef.current,
      title: titleFrom(historyRef.current),
      createdAt: sessionCreatedRef.current,
      ...(parentIdRef.current ? { parentId: parentIdRef.current } : {}),
    }).catch(() => {})
  }, [info.root])

  /** Start a new session id that records the current one as its parent (/clear, /compact). */
  const forkSessionId = useCallback((): void => {
    parentIdRef.current = sessionIdRef.current
    sessionIdRef.current = newSessionId()
    sessionCreatedRef.current = Date.now()
  }, [])

  const updateStats = useCallback((next: SessionStats): void => {
    statsRef.current = next // a queued run starts before the re-render
    setStats(next)
  }, [])

  const restoreSession = useCallback(
    (stored: StoredSession): void => {
      historyRef.current = stored.messages
      sessionIdRef.current = stored.id
      sessionCreatedRef.current = stored.createdAt
      parentIdRef.current = stored.parentId
      const restored = historyItems(stored.messages)
      setItems((prev) => [...prev, ...restored.map((r) => ({ ...r, key: ++keyCounter.current }) as Item)])
      pushItem({
        kind: 'status',
        text: `resumed "${stored.title}" (${stored.messages.length} messages) — /new starts fresh`,
        tone: 'success',
      })
    },
    [pushItem],
  )

  /** Layered config (managed > flags > env > trusted project > user), as at startup. */
  const effective = useCallback(
    async () => loadEffectiveConfig(flags, { root: info.root, trusted: await projectConfigTrusted(info.root, flags.trustWorkspace) }),
    [flags, info.root],
  )

  // Managed settings, loaded once: /mode, /effort and Tab must not change values an admin locked.
  const managedRef = useRef<ManagedSettings | undefined>(undefined)
  useEffect(() => {
    void effective().then(
      (eff) => {
        managedRef.current = eff.managed
      },
      () => {},
    )
  }, [effective])

  /** The selection for the session's current provider and model, or why it cannot run. */
  const currentSelection = useCallback(async () => {
    const eff = await effective()
    const turnFlags = runFlags(flags, initialProviderId, providerIdRef.current, modelRef.current, effortRef.current)
    const selection = await resolveSelection(turnFlags, eff.config)
    const problem = selectionProblem(eff.managed, selection)
    if (problem) throw new Error(problem)
    return { cfg: eff.config, turnFlags, selection }
  }, [effective, flags, initialProviderId])

  /** resolveRoles once per provider/model; its warnings are shown once per session. */
  const rolesFor = useCallback(
    (turnFlags: CliFlags, cfg: HesdorConfig, selection: ProviderSelection): Promise<Roles> => {
      const key = `${selection.providerId}/${selection.model}`
      if (rolesRef.current?.key !== key) {
        const roles = resolveRoles(turnFlags, cfg, selection).then(
          (r) => {
            for (const w of r.warnings.filter((w) => !shownWarningsRef.current.has(w))) {
              shownWarningsRef.current.add(w)
              pushItem({ kind: 'status', text: w, tone: 'warn' })
            }
            return r
          },
          (err: unknown) => {
            rolesRef.current = undefined // retry on the next turn
            reportFailure('resolving model roles')(err)
            return NO_ROLES
          },
        )
        rolesRef.current = { key, roles }
      }
      return rolesRef.current.roles
    },
    [pushItem, reportFailure],
  )

  // ── one agent turn (or a /goal run of several) ────────────────────────────
  const startRun = useCallback(
    async (prompt: string, goal?: string): Promise<void> => {
      setScrollOffset(0)
      setItems((prev) => [...prev, { key: ++keyCounter.current, kind: 'user', text: goal !== undefined ? `/goal ${goal}` : prompt }])
      setRunning(true)
      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const mode = modeRef.current
        const { cfg, turnFlags, selection } = await currentSelection()
        const provider = createSelectedProvider(selection)
        const roles = await rolesFor(turnFlags, cfg, selection)
        const images = await promptImages(launchImagesRef.current, prompt, process.cwd(), info.root)
        launchImagesRef.current = []
        for (const n of imageNotices(images.length, selection.model, getModelInfo(selection.providerId, selection.model)?.imageInput)) {
          pushItem({ kind: 'status', ...n })
        }
        const turn = continuingTurn(
          (p, history, emit, first) =>
            runTurn({
              trustWorkspace: flags.trustWorkspace,
              provider,
              registry: session.registry,
              plugins: session.plugins,
              systemPrompt: systemPromptFor(session, mode),
              prompt: p,
              history,
              root: info.root,
              mode,
              signal: controller.signal,
              emit,
              emitSubagent: handleSubEvent,
              roles,
              ...(first && images.length > 0 ? { images } : {}),
              requestApproval: (request) =>
                // Shift+A earlier this session: the saved allow rule takes effect from the next turn's policy load.
                request.argv && alwaysArgvRef.current.has(request.argv.join('\0'))
                  ? Promise.resolve(true)
                  : new Promise<boolean>((resolve) => {
                      setApproval({ request, resolve })
                    }),
              approvalsEnabled: true,
              reviewChange: (request) => {
                if (reviewAlwaysRef.current) return Promise.resolve(true)
                return new Promise<boolean>((resolve) => setReview({ request, resolve }))
              },
              state: stateRef.current,
              sessionId: sessionIdRef.current,
              // Task agents with their own `model:` get that provider (and its key).
              providerFor: agentProviderFor(turnFlags, cfg, selection),
              ...(flags.maxSteps ? { maxSteps: flags.maxSteps } : {}),
              ...(flags.maxBudgetUsd !== undefined ? { budgetUsd: flags.maxBudgetUsd, spentUsd: statsRef.current.costUsd ?? 0 } : {}),
            }),
          historyRef,
          (result) => {
            // A compacted history no longer extends the saved transcript: keep that one and continue in a linked session.
            if (result.compacted) forkSessionId()
            // Includes the explore subagent's tokens.
            updateStats(addTurn(statsRef.current, result))
            persist()
            const notice = turnNotice(result, selection.providerId, flags.maxBudgetUsd)
            if (notice) pushItem({ kind: 'status', ...notice })
          },
        )
        if (goal === undefined) await turn(prompt, handleEvent)
        else {
          // The evaluator's cost joins the footer total, which the next turn's budget check reads.
          const onEvaluatorCost = (usd: number): void => updateStats({ ...statsRef.current, costUsd: (statsRef.current.costUsd ?? 0) + usd })
          const result = await runGoal({ condition: goal, prompt, turn, evaluator: roles.small ?? provider, emit: handleEvent, signal: controller.signal, onEvaluatorCost })
          pushItem({ kind: 'status', ...goalNotice(result) })
        }
      } catch (err) {
        pushItem({ kind: 'status', text: err instanceof Error ? err.message : String(err), tone: 'error' })
      } finally {
        abortRef.current = null
        runningRef.current = false
        setApproval(null)
        setRunning(false)
        const next = queueRef.current.shift()
        if (next) void startRun(next)
      }
    },
    [currentSelection, flags, forkSessionId, handleEvent, handleSubEvent, info.root, persist, pushItem, rolesFor, session, updateStats],
  )

  /** Run a prompt now, or queue it behind the running task. */
  const submitPrompt = useCallback(
    (prompt: string): void => {
      if (!runningRef.current) {
        void startRun(prompt)
        return
      }
      queueRef.current.push(prompt)
      pushItem({ kind: 'status', text: 'queued — runs after the current task', tone: 'info' })
    },
    [pushItem, startRun],
  )

  /** A custom or MCP prompt command: MCP prompts are fetched from their server first. */
  const runCommandPrompt = useCallback(
    (name: string, args: string): void => {
      const custom = session.commands.get(name)
      if (custom) void expandCommand(custom, args).then(submitPrompt, reportFailure(`/${name}`))
    },
    [reportFailure, session, submitPrompt],
  )

  // ── pickers ───────────────────────────────────────────────────────────────
  const openModelPicker = useCallback(
    (targetProviderId = providerId): void => {
      setPicker({ kind: 'model', providerId: targetProviderId, loading: true, models: [] })
      void (async () => {
        try {
          // Same resolution as a run: endpoint, key, and a custom provider's authHeader / apiKeyCommand.
          const sel = await resolveSelection(runFlags(flags, initialProviderId, targetProviderId, 'unused'), (await effective()).config)
          const models = await fetchModels({
            provider: sel.providerId,
            customKind: sel.kind,
            ...(sel.baseUrl ? { baseUrl: sel.baseUrl } : {}),
            ...(sel.apiKey ? { apiKey: sel.apiKey } : {}),
            ...(sel.custom?.apiKeyCommand ? { apiKeyCommand: sel.custom.apiKeyCommand } : {}),
            ...(sel.custom?.authHeader ? { authHeader: sel.custom.authHeader } : {}),
          })
          if (models.length === 0) throw new Error('provider returned an empty catalog')
          setPicker({ kind: 'model', providerId: targetProviderId, loading: false, models })
        } catch (err) {
          setPicker({
            kind: 'model',
            providerId: targetProviderId,
            loading: false,
            models: [],
            error: `${err instanceof Error ? err.message : String(err)} — check /provider setup`,
          })
        }
      })()
    },
    [effective, flags, initialProviderId, providerId],
  )

  /** Remember `m` as `id`'s model (per-provider memory, never the saved provider's slot). */
  const chooseModel = useCallback(
    (id: string, m: string): void => {
      const problem = modelIdError(m)
      if (problem) {
        pushItem({ kind: 'status', text: problem, tone: 'error' })
        return
      }
      if (id === providerIdRef.current) setModel(m)
      void saveConfig({ models: { [id]: m } }).catch(reportFailure('saving the model'))
      pushItem({ kind: 'status', text: `model → ${m} (saved for ${id})`, tone: 'info' })
    },
    [pushItem, reportFailure],
  )

  const openProviderPicker = useCallback((): void => {
    setPicker({ kind: 'provider', customProviders: [] })
    void loadConfig().then((cfg) => {
      setPicker((current) =>
        current?.kind === 'provider'
          ? { ...current, customProviders: Object.keys(cfg.customProviders ?? {}).sort() }
          : current,
      )
    })
  }, [])

  /** Switch to `id` with its own saved model (or preset default), never the previous provider's model. */
  const finishProviderSetup = useCallback(
    (id: string, pickModel = true): void => {
      void (async () => {
        const m = modelForProvider((await effective()).config, id)
        setProviderId(id)
        setModel(m)
        await saveConfig({ provider: id })
        pushItem({ kind: 'status', text: `provider → ${id} · model ${m} (saved)`, tone: 'info' })
        if (pickModel) openModelPicker(id)
      })().catch(reportFailure('switching provider'))
    },
    [effective, openModelPicker, pushItem, reportFailure],
  )

  /** Provider chosen → walk through URL/key steps only when missing. */
  const beginProviderSetup = useCallback(
    (id: string): void => {
      if (!PROVIDER_ID_RE.test(id)) {
        pushItem({ kind: 'status', text: `invalid provider id "${id}" (1-40 lowercase letters, digits, . _ -)`, tone: 'error' })
        return
      }
      void (async () => {
        const [eff, auth] = await Promise.all([effective(), loadAuth()])
        const cfg = eff.config
        const refused = providerRefusal(eff.managed, id)
        if (refused) {
          pushItem({ kind: 'status', text: refused, tone: 'error' })
          return
        }
        if (id === 'chatgpt' && !chatgptSignedIn(await readChatGPTAuth())) {
          // Continue with ChatGPT: browser sign-in, then the account's model (chooseChatGPTModel saves it).
          const { record, models } = await loginChatGPT({ print: (line) => pushItem({ kind: 'status', text: line, tone: 'info' }) })
          await chooseChatGPTModel(models)
          pushItem({ kind: 'status', text: `Signed in to ChatGPT${record.email ? ` as ${record.email}` : ''}: requests use your ChatGPT plan`, tone: 'success' })
          finishProviderSetup(id, false)
          return
        }
        const preset = getPreset(id)
        const custom = cfg.customProviders?.[id]
        if (!preset && !custom) {
          pushItem({ kind: 'status', text: `unknown provider "${id}" — /provider lists them; hesdor setup adds custom ones`, tone: 'error' })
          return
        }
        if (custom || !preset) {
          finishProviderSetup(id)
          return
        }
        const hasUrl = Boolean(preset.baseUrl ?? cfg.baseUrls?.[id] ?? (preset.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined))
        const hasKey = !preset.requiresApiKey || presetEnvKeys(preset).some((k) => process.env[k]) || Boolean(auth[id])
        if (!hasUrl) setSetup({ kind: 'url', provider: id })
        else if (!hasKey) setSetup({ kind: 'key', provider: id })
        else finishProviderSetup(id)
      })().catch(reportFailure('provider setup'))
    },
    [effective, finishProviderSetup, pushItem, reportFailure],
  )

  /** Restore files to a checkpoint (or a rewind's backup); returns the report lines to show. */
  const rewindWorkspace = useCallback(
    async (id: string): Promise<NewItem[]> => {
      const res = await rewindFiles(info.root, id)
      rewindBackupRef.current = res.backupId
      // Undo snapshots describe files as they were before the rewind.
      stateRef.current.snapshots = []
      stateRef.current.redo = []
      const notes: NewItem[] = [
        {
        kind: 'status',
        text: `files rewound: ${res.restored.length} restored · ${res.deleted.length} deleted · backup ${res.backupId.slice(0, 10)} (/rewind again to undo)`,
        tone: 'success',
        },
      ]
      if (res.drift.length > 0) {
        const list = res.drift.slice(0, 10).join(', ') + (res.drift.length > 10 ? ` … +${res.drift.length - 10}` : '')
        notes.push({ kind: 'status', text: `edited outside the agent since then, now replaced (kept in the backup): ${list}`, tone: 'warn' })
      }
      return notes
    },
    [info.root],
  )

  const rewindTo = useCallback(
    (checkpoint: Checkpoint, what: string): void => {
      void (async () => {
        const notes = what === 'files' || what === 'both' ? await rewindWorkspace(checkpoint.id) : []
        if (what === 'chat' || what === 'both') {
          const chat = rewindChat(historyRef.current, checkpoint)
          historyRef.current = chat.history
          persist()
          updateStats({ ...statsRef.current, contextTokens: undefined })
          setItems(historyItems(chat.history).map((r) => ({ ...r, key: ++keyCounter.current }) as Item))
          replaceInput(chat.prompt)
          pushItem({ kind: 'status', text: 'chat rewound — the prompt is back in the input box', tone: 'success' })
        }
        for (const note of notes) pushItem(note)
      })().catch(reportFailure('rewind'))
    },
    [persist, pushItem, replaceInput, reportFailure, rewindWorkspace, updateStats],
  )

  /** OAuth login for a url MCP server, then reconnect (the URL to open is shown as a status line). */
  const loginMcp = useCallback(
    (name: string): void => {
      const entry = session.mcpConfigs[name]
      if (!entry?.config.url) {
        pushItem({ kind: 'status', text: entry ? `"${name}" is a stdio server; only url servers log in` : `no MCP server named "${name}" (/mcp lists them)`, tone: 'warn' })
        return
      }
      pushItem({ kind: 'status', text: `logging in to "${name}"…`, tone: 'info' })
      void loginMcpServer(name, entry.config.url, {
        ...(entry.config.oauth ? { oauth: entry.config.oauth } : {}),
        print: (line) => pushItem({ kind: 'status', text: line, tone: 'info' }),
      })
        .then(async () => {
          // Reconnecting closes the servers a running turn may be using.
          if (runningRef.current) {
            pushItem({ kind: 'status', text: `logged in to "${name}" — /reload after this task to connect`, tone: 'success' })
            return
          }
          await session.reload()
          setReloadTick((t) => t + 1)
          pushItem({ kind: 'status', text: `logged in to "${name}" and reconnected`, tone: 'success' })
        })
        .catch(reportFailure(`mcp login for "${name}"`))
    },
    [pushItem, reportFailure, session],
  )

  const openMcpPicker = useCallback((): void => {
    setPicker({ kind: 'mcp', loading: true, servers: [] })
    void Promise.all(
      Object.entries(session.mcpConfigs).map(async ([name, { config, scope }]) => {
        const s = session.mcpServers.find((x) => x.name === name)
        const transport = config.url ? `http ${config.url}` : `stdio ${config.command ?? '?'}`
        const state = s ? (s.client.alive ? `${s.tools.length} tools · ${s.prompts.length} prompts · ${s.resources.length} resources` : 'disconnected') : 'not connected'
        const auth = config.url ? ` · ${await mcpAuthStatus(name, config.url)}` : ''
        return { value: name, label: name, hint: `${scope} · ${transport} · ${state}${auth}` }
      }),
    ).then(
      (servers) =>
        setPicker((current) =>
          current?.kind === 'mcp'
            ? { kind: 'mcp', loading: false, servers, ...(servers.length === 0 ? { error: 'no MCP servers (hesdor mcp add <name> ...)' } : {}) }
            : current,
        ),
      (err: unknown) => {
        setPicker(null)
        reportFailure('listing mcp servers')(err)
      },
    )
  }, [reportFailure, session])

  const commandNames = useMemo<string[]>(
    () => [...BUILTIN_COMMANDS.map((c) => c.name), ...session.commands.keys()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, reloadTick],
  )

  const paletteItems = useMemo<CommandInfo[]>(() => {
    const custom: CommandInfo[] = [...session.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
    }))
    return [...custom, ...BUILTIN_COMMANDS]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reloadTick])

  const paletteQuery = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : null
  const paletteFiltered = useMemo<CommandInfo[]>(() => {
    if (paletteQuery === null) return []
    // An exact name wins, so `/mcp` + Enter opens /mcp rather than an `mcp__…` prompt listed earlier.
    const starts = paletteItems
      .filter((c) => c.name.startsWith(paletteQuery))
      .sort((a, b) => Number(b.name === paletteQuery) - Number(a.name === paletteQuery))
    const includes = paletteItems.filter((c) => !c.name.startsWith(paletteQuery) && c.name.includes(paletteQuery))
    const merged = [...starts, ...includes]
    return merged.slice(0, 6)
  }, [paletteItems, paletteQuery])

  useEffect(() => {
    setPaletteSel((s) => Math.min(s, Math.max(0, paletteFiltered.length - 1)))
  }, [paletteFiltered.length])

  const executeCommand = useCallback(
    (cmd: string, argText: string): void => {
      switch (cmd) {
        case 'exit':
        case 'quit':
          exit()
          return
        case 'mode': {
          const target = argText.split(/\s+/)[0]?.toLowerCase()
          const modeLock = managedLock(managedRef.current, 'mode')
          if (modeLock && target) {
            pushItem({ kind: 'status', text: modeLock, tone: 'warn' })
          } else if (target === 'build' || target === 'plan' || target === 'ask') {
            setMode(target)
            pushItem({ kind: 'status', text: `mode → ${target}`, tone: 'info' })
          } else {
            pushItem({ kind: 'status', text: `current mode: ${mode} (usage: /mode build|plan|ask)`, tone: 'info' })
          }
          return
        }
        case 'model': {
          if (argText !== '') chooseModel(providerId, argText)
          else openModelPicker()
          return
        }
        case 'provider': {
          const target = argText.split(/\s+/)[0]?.toLowerCase()
          if (target) beginProviderSetup(target)
          else openProviderPicker()
          return
        }
        case 'effort': {
          const target = argText.toLowerCase()
          const effortLock = managedLock(managedRef.current, 'effort')
          if (effortLock && target) {
            pushItem({ kind: 'status', text: effortLock, tone: 'warn' })
          } else if (target === 'low' || target === 'medium' || target === 'high') {
            setEffort(target)
            pushItem({ kind: 'status', text: `effort → ${target} (this session)`, tone: 'info' })
          } else if (target === 'default') {
            setEffort(undefined)
            pushItem({ kind: 'status', text: 'effort → provider default', tone: 'info' })
          } else {
            pushItem({ kind: 'status', text: `effort: ${effort ?? 'provider default'} (usage: /effort low|medium|high|default)`, tone: 'info' })
          }
          return
        }
        case 'status': {
          const line = formatStatus({ ...stats, info: getModelInfo(providerId, model) })
          pushItem({
            kind: 'status',
            text: [
              `session ${sessionIdRef.current}${parentIdRef.current ? ` (continues ${parentIdRef.current})` : ''}`,
              `${providerId}/${model} · ${mode}${effort ? ` · effort ${effort}` : ''}`,
              [line, stats.usage?.totalTokens !== undefined ? `${stats.usage.totalTokens} tokens` : ''].filter(Boolean).join(' · ') || 'no usage yet',
            ].join('\n'),
            tone: 'info',
          })
          void effective().then((eff) => {
            if (eff.profile) pushItem({ kind: 'status', text: eff.profile.lines.join('\n'), tone: 'info' })
          }, reportFailure('reading the profile'))
          return
        }
        case 'rewind': {
          setPicker({ kind: 'rewind', loading: true, checkpoints: [] })
          void listCheckpoints(info.root, { sessionId: sessionIdRef.current }).then(
            (checkpoints) =>
              setPicker((current) =>
                current?.kind === 'rewind'
                  ? {
                      kind: 'rewind',
                      loading: false,
                      checkpoints,
                      ...(checkpoints.length === 0 && !rewindBackupRef.current ? { error: 'no checkpoints in this session yet' } : {}),
                    }
                  : current,
              ),
            (err: unknown) => {
              setPicker(null)
              reportFailure('listing checkpoints')(err)
            },
          )
          return
        }
        case 'tools': {
          const tools = session.registry.list()
          pushItem({
            kind: 'status',
            text: `${tools.length} tools:\n${tools.map((t) => `  ${t.name} [${t.risk}]`).join('\n')}`,
            tone: 'info',
          })
          return
        }
        case 'skills': {
          if (session.skills.length === 0) {
            pushItem({ kind: 'status', text: 'no skills found (.hesdor/skills/<name>/SKILL.md)', tone: 'info' })
          } else {
            pushItem({
              kind: 'status',
              text: `${session.skills.length} skills:\n${session.skills.map((s) => `  ${s.name} — ${s.description}`).join('\n')}`,
              tone: 'info',
            })
          }
          return
        }
        case 'plugins': {
          const parts: string[] = []
          parts.push(session.plugins.length > 0 ? `plugins: ${session.plugins.map((p) => p.name).join(', ')}` : 'no plugins (.hesdor/plugins/*.js)')
          parts.push(session.mcpServerNames.length > 0 ? `mcp: ${session.mcpServerNames.join(', ')}` : 'no mcp servers (.hesdor/mcp.json)')
          pushItem({ kind: 'status', text: parts.join('\n'), tone: 'info' })
          return
        }
        case 'undo': {
          const undoCtx: ToolContext = {
            root: info.root,
            mode,
            model,
            signal: new AbortController().signal,
            emit: handleEvent,
            requestApproval: () => Promise.resolve(true),
            approvalsEnabled: true,
            state: stateRef.current,
          }
          void undoLastChange(undoCtx).then((res) => {
            pushItem({
              kind: 'status',
              text: res.undone ? `undid ${res.path}` : 'nothing to undo',
              tone: res.undone ? 'success' : 'warn',
            })
          }, reportFailure('undo'))
          return
        }
        case 'redo': {
          const redoCtx: ToolContext = {
            root: info.root,
            mode,
            model,
            signal: new AbortController().signal,
            emit: handleEvent,
            requestApproval: () => Promise.resolve(true),
            approvalsEnabled: true,
            state: stateRef.current,
          }
          void redoLastChange(redoCtx).then((res) => {
            pushItem({
              kind: 'status',
              text: res.redone ? `redid ${res.path}` : 'nothing to redo',
              tone: res.redone ? 'success' : 'warn',
            })
          }, reportFailure('redo'))
          return
        }
        case 'reload': {
          void session.reload().then(() => {
            setReloadTick((t) => t + 1)
            pushItem({
              kind: 'status',
              text: `reloaded: ${session.commands.size} commands · ${session.skills.length} skills · ${session.plugins.length} plugins · mcp ${session.mcpServerNames.length}`,
              tone: 'success',
            })
          }, reportFailure('reload'))
          return
        }
        case 'sessions': {
          void listSessions(info.root).then((metas) => {
            if (metas.length === 0) {
              pushItem({ kind: 'status', text: 'no saved sessions yet', tone: 'info' })
              return
            }
            pushItem({
              kind: 'status',
              text: `recent sessions (/resume <number>, hesdor -r <id>):\n${metas
                .map((m, i) => `  ${i + 1}. ${m.id} · ${new Date(m.updatedAt).toLocaleString()} · ${m.messageCount} msgs · ${m.title}`)
                .join('\n')}`,
              tone: 'info',
            })
          }, reportFailure('listing sessions'))
          return
        }
        case 'resume': {
          const index = Number(argText) || 1
          void listSessions(info.root).then(async (metas) => {
            const meta = metas[index - 1]
            if (!meta) {
              pushItem({ kind: 'status', text: `no session #${argText || 1} — try /sessions`, tone: 'warn' })
              return
            }
            const stored = await loadSession(meta.file)
            if (!stored) {
              pushItem({ kind: 'status', text: 'could not read session file', tone: 'error' })
              return
            }
            restoreSession(stored)
          }, reportFailure('resume'))
          return
        }
        case 'compact': {
          if (historyRef.current.length === 0) {
            pushItem({ kind: 'status', text: 'nothing to compact yet', tone: 'warn' })
            return
          }
          // Runs like an agent turn: prompts typed meanwhile are queued, and Esc cancels it.
          setRunning(true)
          const controller = new AbortController()
          abortRef.current = controller
          pushItem({ kind: 'status', text: 'compacting… (esc cancels)', tone: 'info' })
          void (async () => {
            try {
              const { cfg, turnFlags, selection } = await currentSelection()
              const provider = (await rolesFor(turnFlags, cfg, selection)).small ?? createSelectedProvider(selection)
              let summary = ''
              for await (const chunk of provider.stream(
                [
                  {
                    role: 'system',
                    content:
                      'You summarize coding-agent conversations into a terse handoff: decisions made, files changed, current task, open questions. Bullet points only.',
                  },
                  {
                    role: 'user',
                    content: historyRef.current
                      .map((m) => `${m.role}: ${m.content.slice(0, 2000)}`)
                      .join('\n\n')
                      .slice(0, 60000),
                  },
                ],
                [],
                controller.signal,
              )) {
                if (chunk.type === 'text') summary += chunk.text
              }
              if (controller.signal.aborted) throw new Error('cancelled')
              if (summary.trim() === '') throw new Error('model returned an empty summary')
              // The full transcript stays saved under the old id; the summary continues as a linked session.
              forkSessionId()
              historyRef.current = [{ role: 'user', content: `[earlier conversation summary]\n${summary.trim()}` }]
              updateStats({ ...statsRef.current, contextTokens: undefined })
              persist()
              pushItem({ kind: 'status', text: `context compacted to a summary (session ${sessionIdRef.current})`, tone: 'success' })
            } catch (err) {
              pushItem(
                controller.signal.aborted
                  ? { kind: 'status', text: 'compact cancelled', tone: 'warn' }
                  : { kind: 'status', text: `compact failed: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' },
              )
            } finally {
              abortRef.current = null
              setRunning(false)
              const next = queueRef.current.shift()
              if (next) void startRun(next)
            }
          })()
          return
        }
        case 'new':
          setItems([])
          historyRef.current = []
          stateRef.current.snapshots = []
          stateRef.current.redo = []
          reviewAlwaysRef.current = false
          sessionIdRef.current = newSessionId()
          sessionCreatedRef.current = Date.now()
          parentIdRef.current = undefined
          rewindBackupRef.current = undefined
          updateStats({})
          pushItem({ kind: 'status', text: `new session ${sessionIdRef.current}`, tone: 'info' })
          return
        case 'clear':
          // New linked id, so the next save cannot overwrite the full transcript.
          if (historyRef.current.length > 0) forkSessionId()
          setItems([])
          historyRef.current = []
          stateRef.current.snapshots = []
          stateRef.current.redo = []
          updateStats({ ...statsRef.current, contextTokens: undefined })
          return
        case 'help':
          pushItem({
            kind: 'status',
            text: `commands: ${commandNames.map((n) => `/${n}`).join(' · ')}\nkeys: tab mode · ↑↓ line scroll · pgup/pgdn page · esc cancel/stop · ctrl+c exit\nwhile the agent runs: ${[...READ_ONLY_COMMANDS].map((n) => `/${n}`).join(' ')}`,
            tone: 'info',
          })
          return
        case 'goal': {
          if (argText === '') pushItem({ kind: 'status', text: 'usage: /goal <condition> — repeats turns until an evaluator judges it met (esc stops)', tone: 'info' })
          else void startRun(argText, argText)
          return
        }
        case 'config': {
          void effective().then((eff) => {
            const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
            const rows = listRows(eff).map((r) => `  ${r.key} = ${show(r.value)}  (${r.source})`)
            pushItem({ kind: 'status', text: `effective config (hesdor config set <key> <value> to change):\n${rows.join('\n')}`, tone: 'info' })
          }, reportFailure('reading the config'))
          return
        }
        case 'mcp': {
          const [sub, name] = argText.split(/\s+/)
          if (sub === 'login' && name) loginMcp(name)
          else openMcpPicker()
          return
        }
        default: {
          if (session.commands.has(cmd)) {
            runCommandPrompt(cmd, argText)
            return
          }
          // Unique-prefix fallback: "/too" runs "/tools".
          const matches = commandNames.filter((n) => n.startsWith(cmd))
          if (matches.length === 1) {
            executeCommand(matches[0]!, argText)
            return
          }
          pushItem({
            kind: 'status',
            text: matches.length > 0 ? `"/${cmd}" ambiguous: ${matches.map((m) => `/${m}`).join(', ')}` : `unknown command "/${cmd}"`,
            tone: 'warn',
          })
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [beginProviderSetup, chooseModel, commandNames, currentSelection, effective, effort, exit, forkSessionId, handleEvent, info.root, loginMcp, mode, model, openMcpPicker, openModelPicker, openProviderPicker, persist, providerId, pushItem, reportFailure, restoreSession, rolesFor, runCommandPrompt, running, session, startRun, stats, updateStats],
  )

  const handleSubmit = useCallback(
    (value: string): void => {
      const trimmed = value.trim()
      if (trimmed === '') return
      setInput('')

      if (trimmed.startsWith('/')) {
        // A bare "/prefix" runs the highlighted palette entry (CLI-12).
        const picked = paletteTarget(trimmed, paletteFiltered, paletteSel)
        const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
        const name = picked ?? rawName?.toLowerCase() ?? ''
        const args = picked ? '' : rest.join(' ').trim()
        if (running) {
          // CLI-18: read-only commands run now, custom prompt commands queue, the rest say why not.
          const matches = commandNames.filter((n) => n.startsWith(name))
          const resolved = commandNames.includes(name) ? name : matches.length === 1 ? matches[0]! : name
          if (READ_ONLY_COMMANDS.has(resolved)) executeCommand(resolved, args)
          else if (session.commands.has(resolved)) runCommandPrompt(resolved, args)
          else pushItem({ kind: 'status', text: `/${resolved} is not available while the agent is running (esc stops it)`, tone: 'warn' })
          return
        }
        executeCommand(name, args)
        return
      }

      submitPrompt(trimmed)
    },
    [commandNames, executeCommand, paletteFiltered, paletteSel, pushItem, running, runCommandPrompt, session, submitPrompt],
  )

  // ── global keys ───────────────────────────────────────────────────────────
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      // Stop the run first: exiting alone left commands and writes running behind a closed UI.
      abortRef.current?.abort()
      exit()
      return
    }
    if (approval || picker || review || setup || elicit) return

    const paletteOpen = input.startsWith('/')

    if (key.escape) {
      if (input !== '') setInput('')
      else abortRef.current?.abort()
      return
    }

    if (paletteOpen) {
      if (key.upArrow) setPaletteSel((s) => Math.max(0, s - 1))
      else if (key.downArrow) setPaletteSel((s) => Math.min(Math.max(0, paletteFiltered.length - 1), s + 1))
      else if (key.tab) {
        const c = paletteFiltered[paletteSel]
        if (c) replaceInput(`/${c.name} `)
      }
      return
    }

    if (key.tab) {
      const modeLock = managedLock(managedRef.current, 'mode')
      if (modeLock) {
        pushItem({ kind: 'status', text: modeLock, tone: 'warn' })
        return
      }
      const next = mode === 'build' ? 'plan' : mode === 'plan' ? 'ask' : 'build'
      setMode(next)
      pushItem({ kind: 'status', text: `mode → ${next}`, tone: 'info' })
      return
    }

    const step = key.pageUp || key.pageDown ? pageRef.current : 1
    if (key.upArrow || key.pageUp) setScrollOffset((o) => Math.min(maxScrollRef.current, o + step))
    else if (key.downArrow || key.pageDown) setScrollOffset((o) => Math.max(0, o - step))
  })

  // MCP servers asking for input get a form; answers resolve in order.
  useEffect(() => {
    let id = 0
    session.onElicit = (server, request) => new Promise<McpElicitResult>((resolve) => setElicits((q) => [...q, { id: ++id, server, request, resolve }]))
    return () => {
      session.onElicit = undefined
    }
  }, [session])

  // Resolve model roles at start and after a provider/model switch, so their warnings show before the first turn.
  useEffect(() => {
    void currentSelection().then(({ cfg, turnFlags, selection }) => rolesFor(turnFlags, cfg, selection), () => {})
  }, [currentSelection, rolesFor, providerId, model])

  // Startup notices and --continue/--resume, once; declared first so the initial prompt sees the restored history.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    for (const text of notices ?? []) pushItem({ kind: 'status', text, tone: 'warn' })
    if (resumed) restoreSession(resumed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `hesdor "<prompt>"`: submit the initial prompt once after mount.
  const submittedRef = useRef(false)
  useEffect(() => {
    if (submittedRef.current || !initialPrompt || running) return
    submittedRef.current = true
    handleSubmit(initialPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, running, handleSubmit])

  // ── layout math ───────────────────────────────────────────────────────────
  const paletteVisible = paletteFiltered.length > 0 && input.startsWith('/') && !review && !approval && !elicit
  useEffect(() => {
    const h = dockRef.current ? measureElement(dockRef.current).height : 0
    if (h !== dockRows) setDockRows(h)
  })
  const showSidebar = size.columns >= 96 && !picker
  const paneWidth = showSidebar ? Math.max(30, size.columns - SIDEBAR_W) : Math.max(20, size.columns)
  // Pane border (2) and the ACTIVITY line (1); one more row for the "earlier" marker when needed.
  const budget = Math.max(3, bodyHeight - 2)
  const contentWidth = Math.max(10, paneWidth - 4)

  // Wrapped rows per item, cached by identity: items are immutable, so only changed ones re-wrap.
  const rowCache = useRef(new WeakMap<Item, { width: number; rows: Row[] }>())
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const item of items) {
      let cached = rowCache.current.get(item)
      if (!cached || cached.width !== contentWidth) {
        const prefix = itemPrefix(item)
        const indent = ' '.repeat(displayWidth(prefix))
        const text = item.kind === 'tool' ? item.label : item.text
        cached = {
          width: contentWidth,
          rows: wrapText(text, contentWidth - indent.length).map((t, i) => ({ key: `${item.key}:${i}`, item, lead: i === 0 ? prefix : indent, text: t })),
        }
        rowCache.current.set(item, cached)
      }
      out.push(...cached.rows)
    }
    return out
  }, [items, contentWidth])
  const view = rows.length > budget ? budget - 1 : budget
  const maxScroll = Math.max(0, rows.length - view)
  maxScrollRef.current = maxScroll
  pageRef.current = Math.max(1, view - 1)
  const offset = Math.min(scrollOffset, maxScroll)
  const windowEnd = rows.length - offset
  const windowStart = Math.max(0, windowEnd - view)
  const shown = rows.slice(windowStart, windowEnd)
  const statusLine = formatStatus({ ...stats, info: getModelInfo(providerId, model) })

  const modeColor = mode === 'build' ? 'green' : mode === 'plan' ? 'yellow' : 'blue'
  const accent = approval ? 'red' : review ? 'magenta' : picker ? 'cyan' : running ? 'cyan' : modeColor

  const sidebarRows: Array<[string, string] | null> = [
    ['session', sessionIdRef.current.slice(0, 10)],
    ['messages', String(historyRef.current.length)],
    ['tokens', stats.usage?.totalTokens != null ? String(stats.usage.totalTokens) : '—'],
    ['undo depth', String(stateRef.current.snapshots.length)],
    null,
    ['branch', info.branch ?? '—'],
    ['changes', info.git === false ? 'no git' : info.statusLines.length > 0 ? String(info.statusLines.length) : 'clean'],
    null,
    ['tools', String(session.registry.list().length)],
    ['skills', String(session.skills.length)],
    ['plugins', String(session.plugins.length)],
  ]
  if (session.mcpServerNames.length > 0) {
    sidebarRows.push(['mcp', session.mcpServerNames.join(',')])
  }

  return (
    <Box flexDirection="column" height={size.rows}>
      {/* header */}
      <Box borderStyle="round" borderColor={accent} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text>
            <Text color="cyan" bold>
              ◆ hesdor
            </Text>{' '}
            <Text dimColor>v{VERSION}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {info.name}:{info.branch ?? '—'} ·{' '}
            <Text color={modeColor}>{mode}</Text> · {providerId}/{model}
            {keySource === 'stored' ? ' 🔒' : ''}
          </Text>
        </Box>
        {plan && (
          <Text wrap="truncate-end">
            <Text color="green">{plan.label}</Text>
            <Text dimColor>
              {' · '}
              {plan.linkText}: {plan.url}
            </Text>
          </Text>
        )}
      </Box>

      {/* body (the diff review takes its place, full height) */}
      {!review && (
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={paneWidth} borderStyle="round" borderColor={running ? 'cyan' : 'gray'} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="cyan">
              ACTIVITY
            </Text>
            <Text dimColor>
              {offset > 0 ? `↓ ${offset} lines below · ` : ''}
              {running ? `${spinner} working` : `${items.length} events`}
            </Text>
          </Box>
          {shown.length === 0 && (
            <Box flexDirection="column" paddingY={1}>
              <Text color="cyan" bold>
                Ready when you are.
              </Text>
              <Text dimColor>Ask Hesdor to inspect, plan, or change this repository.</Text>
              <Text dimColor>Try: find the failing tests</Text>
            </Box>
          )}
          {windowStart > 0 && <Text dimColor>··· ↑ {windowStart} earlier lines (↑/pgup) ···</Text>}
          {shown.map((row) => (
            <TranscriptRow key={row.key} row={row} />
          ))}
        </Box>

        {showSidebar && (
          <Box flexDirection="column" width={SIDEBAR_W} borderStyle="round" borderColor="gray" paddingX={1}>
            <Text bold color="cyan">
              SESSION
            </Text>
            {sidebarRows.slice(-Math.max(3, bodyHeight - 1)).map((row, i) =>
              row === null ? (
                <Text key={`gap-${i}`}> </Text>
              ) : (
                <Text key={`${row[0]}-${i}`}>
                  <Text dimColor>{row[0].padEnd(11)}</Text>
                  {row[1]}
                </Text>
              ),
            )}
          </Box>
        )}
      </Box>
      )}

      <Box ref={dockRef} flexDirection="column" flexShrink={0}>
      {/* command palette */}
      {paletteVisible && !picker && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          {paletteFiltered.map((c, i) =>
            i === paletteSel ? (
              <Text key={c.name} color="cyan" bold>
                › /{c.name}
                <Text dimColor> {c.description}</Text>
              </Text>
            ) : (
              <Text key={c.name}>
                {'  '}
                /{c.name}
                <Text dimColor> {c.description}</Text>
              </Text>
            ),
          )}
          <Text dimColor>[↑↓] move · [tab] complete · [enter] run</Text>
        </Box>
      )}

      {/* picker dialog */}
      {picker?.kind === 'provider' && (
        <ListPicker
          title="Switch provider"
          items={[
            ...PROVIDER_PRESETS.map((p) => ({
              value: p.id,
              label: p.id,
              hint:
                p.id === 'openai-compatible' || p.id === 'anthropic-compatible'
                  ? 'custom endpoint — will ask for URL + key'
                  : p.requiresApiKey
                    ? (p.envKey ?? '')
                    : 'local · no key',
            })),
            ...picker.customProviders.map((id) => ({ value: id, label: id, hint: 'saved custom endpoint' })),
          ]}
          onPick={(id) => {
            setPicker(null)
            beginProviderSetup(id)
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'model' && (
        <ListPicker
          title={`Models · ${picker.providerId}`}
          items={picker.models.map((m) => ({ value: m, label: m }))}
          loading={picker.loading}
          error={picker.error}
          onPick={(m) => {
            setPicker(null)
            setInput('')
            chooseModel(picker.providerId, m)
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'rewind' && (
        <ListPicker
          title="Rewind to before…"
          items={[
            ...(rewindBackupRef.current
              ? [{ value: 'undo', label: 'undo the last rewind', hint: `restore files from backup ${rewindBackupRef.current.slice(0, 10)}` }]
              : []),
            ...picker.checkpoints.map((c) => ({
              value: c.id,
              label: c.prompt.replace(/\s+/g, ' ').slice(0, 60) || '(empty prompt)',
              hint: `${new Date(c.createdAt).toLocaleTimeString()} · turn ${c.turnIndex}`,
            })),
          ]}
          loading={picker.loading}
          error={picker.error}
          onPick={(id) => {
            const backup = rewindBackupRef.current
            if (id === 'undo' && backup) {
              setPicker(null)
              void rewindWorkspace(backup).then((notes) => notes.forEach(pushItem), reportFailure('undoing the rewind'))
              return
            }
            const checkpoint = picker.checkpoints.find((c) => c.id === id)
            setPicker(checkpoint ? { kind: 'rewindMode', checkpoint } : null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'mcp' && (
        <ListPicker
          title="MCP servers · enter logs in to a url server"
          items={picker.servers}
          loading={picker.loading}
          error={picker.error}
          onPick={(name) => {
            setPicker(null)
            loginMcp(name)
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker?.kind === 'rewindMode' && (
        <ListPicker
          title={`Rewind to before "${picker.checkpoint.prompt.replace(/\s+/g, ' ').slice(0, 40)}"`}
          items={[
            { value: 'both', label: 'files and chat', hint: 'restore files, drop later messages, put the prompt back' },
            { value: 'files', label: 'files only', hint: 'keep the conversation' },
            { value: 'chat', label: 'chat only', hint: 'keep the files as they are' },
          ]}
          onPick={(what) => {
            const { checkpoint } = picker
            setPicker(null)
            rewindTo(checkpoint, what)
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {setup?.kind === 'url' && (
        <PromptBox
          title={`Base URL for ${setup.provider}`}
          placeholder={getPreset(setup.provider)?.kind === 'anthropic' ? 'https://your-endpoint' : 'https://your-endpoint/v1'}
          onCancel={() => setSetup(null)}
          onSubmit={(url) => {
            const id = setup.provider
            void (async () => {
              const cfg = await loadConfig()
              await saveConfig({ baseUrls: { ...cfg.baseUrls, [id]: url } })
              setSetup(null)
              const preset = getPreset(id)
              const hasEnvKey = preset ? presetEnvKeys(preset).some((k) => process.env[k]) : false
              const auth = await loadAuth()
              if (preset?.requiresApiKey && !hasEnvKey && !auth[id]) {
                setSetup({ kind: 'key', provider: id })
              } else {
                finishProviderSetup(id)
              }
            })().catch((err: unknown) => {
              setSetup(null)
              reportFailure('saving the URL')(err)
            })
          }}
        />
      )}
      {setup?.kind === 'key' && (
        <PromptBox
          title={`API key for ${setup.provider}`}
          placeholder="paste key — stored in your user profile, never in a repo"
          password
          onCancel={() => setSetup(null)}
          onSubmit={(key) => {
            const id = setup.provider
            void saveCredential(id, key).then(() => {
              pushItem({ kind: 'status', text: 'key saved to your Hesdor profile', tone: 'success' })
              setSetup(null)
              finishProviderSetup(id)
            }, reportFailure('saving the key'))
          }}
        />
      )}

      {/* input dock */}
      {!picker && !approval && !review && !setup && !elicit && (
        <Box borderStyle="round" borderColor={accent} paddingX={1}>
          <Text color="green" bold>
            {'› '}
          </Text>
          <TextInput
            key={inputKey}
            value={input}
            onChange={(v) => {
              setInput(v)
              if (!v.startsWith('/')) setScrollOffset(0)
            }}
            onSubmit={handleSubmit}
            placeholder={running ? 'agent working — type to queue… ("/" commands)' : 'Describe a task… ("/" commands)'}
          />
        </Box>
      )}

      {/* approval */}
      {approval && (
        <ApprovalPrompt
          request={approval.request}
          onResolve={(yes) => {
            approval.resolve(yes)
            setApproval(null)
          }}
          {...(approval.request.argv
            ? {
                onAlways: (argv: string[]) => {
                  alwaysArgvRef.current.add(argv.join('\0'))
                  void addUserAllowRule(argv).then(
                    () => pushItem({ kind: 'status', text: `always allowed: ${argv.join(' ')} (saved to your config)`, tone: 'info' }),
                    reportFailure('saving the allow rule'),
                  )
                  approval.resolve(true)
                  setApproval(null)
                },
              }
            : {})}
        />
      )}

      {elicit && !approval && !review && (
        <ElicitForm
          key={elicit.id}
          server={elicit.server}
          request={elicit.request}
          onDone={(result) => {
            elicit.resolve(result)
            setElicits((q) => q.slice(1))
            if (result.action !== 'accept') pushItem({ kind: 'status', text: `mcp "${elicit.server}": request ${result.action}ed`, tone: 'info' })
          }}
        />
      )}
      </Box>

      {review && (
        <DiffReview
          request={review.request}
          // Header (3), footer (3) and the review's border, title and key hint (4).
          maxLines={size.rows - chrome}
          tainted={stateRef.current.tainted === true}
          onResolve={(decision) => {
            if (decision === 'always') reviewAlwaysRef.current = true
            review.resolve(decision !== 'reject')
            setReview(null)
          }}
        />
      )}

      {/* footer */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text>
          <Text color={modeColor}>{running ? spinner : '●'} {mode}</Text>
          <Text dimColor>
            {' · '}
            {providerId}/{model}
            {effort ? ` · effort ${effort}` : ''}
            {statusLine ? ` · ${statusLine}` : ''}
            {queueRef.current.length > 0 ? ` · ${queueRef.current.length} queued` : ''}
            {running ? ' · esc cancel' : ''}
            {keySource === 'stored' ? ' · saved key' : keySource === 'local' ? ' · local' : ''}
          </Text>
        </Text>
        <Text dimColor>/help · ctrl+c exit</Text>
      </Box>
    </Box>
  )
}

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER_FRAMES[frame]!
}

function ApprovalPrompt({
  request,
  onResolve,
  onAlways,
}: {
  request: ApprovalRequest
  onResolve: (yes: boolean) => void
  /** Commands only (they have argv): approve and save a user allow rule for this exact argv. */
  onAlways?: (argv: string[]) => void
}): React.ReactElement {
  const armed = useArmed()
  useInput((value, key) => {
    if (!armed.current) return
    if (value === 'y' || value === 'Y') onResolve(true)
    else if (value === 'A' && onAlways && request.argv) onAlways(request.argv)
    else if (value === 'n' || value === 'N' || key.escape) onResolve(false)
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red">⚠ {request.title}</Text>
      {request.detail && <Text>{request.detail}</Text>}
      <Text dimColor>[y] approve · [n] deny · [esc] deny{onAlways ? ' · [shift+a] always allow this exact command (saved)' : ''}</Text>
    </Box>
  )
}
