import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { buildSystemPrompt, runAgentLoop } from '@hesdor/agent-core'
import type { ApprovalRequest, RepoContextInfo, ToolContext } from '@hesdor/agent-core'
import { redoLastChange, undoLastChange } from '@hesdor/agent-core'
import type { AgentMode, ChatMessage, RunEvent } from '@hesdor/protocol'
import { fetchModels, getPreset, PROVIDER_PRESETS } from '@hesdor/providers'
import { loadConfig, saveConfig } from '../config.js'
import { createSelectedProvider, resolveSelection } from '../provider-setup.js'
import { loadAuth, saveCredential } from '../auth.js'
import type { Session } from '../session.js'
import { listSessions, loadSession, newSessionId, saveSession, titleFrom } from '../sessions.js'
import type { CliFlags } from '../args.js'
import { VERSION } from '../args.js'
import { DiffReview, type DiffReviewRequest } from './DiffReview.js'
import { ListPicker, PromptBox } from './pickers.js'

type Item =
  | { key: number; kind: 'user'; text: string }
  | { key: number; kind: 'assistant'; text: string; live: boolean }
  | { key: number; kind: 'tool'; callId: string; label: string; state: 'run' | 'ok' | 'fail' }
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

function prettySummary(summary: string): string {
  const spaceIdx = summary.indexOf(' ')
  const name = spaceIdx < 0 ? summary : summary.slice(0, spaceIdx)
  const rest = spaceIdx < 0 ? '' : summary.slice(spaceIdx + 1)
  const verb = TOOL_VERBS[name] ?? name
  return rest ? `${verb} ${rest}` : verb
}

function buildSystem(session: Session, info: RepoContextInfo, mode: AgentMode): string {
  const base = buildSystemPrompt(info, mode)
  return session.skillsSection ? `${base}\n\n${session.skillsSection}` : base
}

const SUBAGENT_SYSTEM =
  'You are Hesdor\'s exploratory subagent. Investigate the given task using ONLY read tools (list_files, search_files, read_file, read_files, git_status, git_log). ' +
  'Answer the task precisely in your final message and nothing else. Keep the answer under 800 words. If you cannot answer, say so. You have no write or execute permissions.'

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

/** Rough wrapped-line count so the transcript pane never overflows the screen. */
function estimateLines(item: Item, width: number): number {
  const w = Math.max(20, width - 4)
  const text =
    item.kind === 'tool' ? item.label : item.text
  let n = 0
  for (const seg of String(text).split('\n')) {
    n += Math.max(1, Math.ceil(seg.length / w))
  }
  return n + (item.kind === 'user' ? 1 : 0)
}

export interface AppProps {
  info: RepoContextInfo
  flags: CliFlags
  providerId: string
  initialModel: string
  session: Session
  /** Prompt from `hesdor "<prompt>"` — auto-submitted once on mount. */
  initialPrompt?: string
  /** One-off endpoint supplied by `--base-url`. */
  initialBaseUrl?: string
  keySource?: string
}

type PickerState =
  | { kind: 'provider'; customProviders: string[] }
  | { kind: 'model'; loading: boolean; error?: string; models: string[] }
  | null

type SetupState = { kind: 'url'; provider: string } | { kind: 'key'; provider: string } | null

export function App({
  info,
  flags,
  providerId: initialProviderId,
  initialModel,
  session,
  initialPrompt,
  initialBaseUrl,
  keySource,
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
  const [scrollOffset, setScrollOffset] = useState(0)
  const [paletteSel, setPaletteSel] = useState(0)
  const [picker, setPicker] = useState<PickerState>(null)
  const [setup, setSetup] = useState<SetupState>(null)

  const keyCounter = useRef(0)
  const historyRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const queueRef = useRef<string[]>([])
  const sessionIdRef = useRef(newSessionId())
  const sessionCreatedRef = useRef(Date.now())
  const usageRef = useRef<{ totalTokens?: number; inputTokens?: number; outputTokens?: number } | null>(null)
  const reviewAlwaysRef = useRef(false)
  const maxScrollRef = useRef(0)
  // Shared across runs so /undo can restore earlier file changes.
  const stateRef = useRef<ToolContext['state']>({ activeChild: null, snapshots: [], redo: [] })

  const SIDEBAR_W = 30
  // header(3) + input box(3) + footer(3) + safety margin(1)
  const bodyHeight = Math.max(4, size.rows - 10)

  const pushItem = useCallback((item: NewItem): void => {
    setItems((prev) => [...prev, { ...item, key: ++keyCounter.current } as Item])
  }, [])

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
        case 'run.completed':
          pushItem({ kind: 'status', text: `done (${event.steps} step${event.steps === 1 ? '' : 's'})`, tone: 'success' })
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

  // ── one agent turn ────────────────────────────────────────────────────────
  const startRun = useCallback(
    async (prompt: string): Promise<void> => {
      setScrollOffset(0)
      setItems((prev) => [...prev, { key: ++keyCounter.current, kind: 'user', text: prompt }])
      setRunning(true)
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const cfg = await loadConfig()
        const selection = await resolveSelection(flags, cfg)
        const provider = createSelectedProvider({ ...selection, model })
        const ctx: ToolContext = {
          root: info.root,
          mode,
          model: provider.model,
          signal: controller.signal,
          emit: handleEvent,
          requestApproval: (request) =>
            new Promise<boolean>((resolve) => {
              setApproval({ request, resolve })
            }),
          approvalsEnabled: true,
          reviewChange: (request) => {
            if (reviewAlwaysRef.current) return Promise.resolve(true)
            return new Promise<boolean>((resolve) => setReview({ request, resolve }))
          },
          state: stateRef.current,
          // Nested read-only agent backing the explore tool.
          subagent: async (task, subMaxSteps = 5) => {
            const subCtx: ToolContext = {
              root: info.root,
              mode: 'ask',
              model: provider.model,
              signal: controller.signal,
              emit: () => {},
              requestApproval: () => Promise.resolve(false),
              approvalsEnabled: false,
              state: stateRef.current,
              subagent: undefined,
            }
            const subResult = await runAgentLoop({
              provider,
              registry: session.registry.readOnly(),
              ctx: subCtx,
              systemPrompt: SUBAGENT_SYSTEM,
              userPrompt: task,
              history: [],
              maxSteps: Math.min(subMaxSteps, 10),
            })
            const lastText =
              [...subResult.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim() !== '')?.content ?? ''
            if (!lastText) return subResult.error ?? 'subagent produced no answer'
            return lastText.slice(0, 6000)
          },
        }

        const system = buildSystem(session, info, mode)
        const result = await runAgentLoop({
          provider,
          registry: session.registry,
          ctx,
          systemPrompt: system,
          userPrompt: prompt,
          history: historyRef.current.length > 0 ? historyRef.current : undefined,
          plugins: session.plugins,
          ...(flags.maxSteps ? { maxSteps: flags.maxSteps } : {}),
        })
        historyRef.current = result.messages.filter((m) => m.role !== 'system')
        if (result.usage?.ready) usageRef.current = result.usage

        void saveSession(info.root, {
          id: sessionIdRef.current,
          messages: historyRef.current,
          title: titleFrom(historyRef.current),
          createdAt: sessionCreatedRef.current,
        }).catch(() => {})

        if (result.status === 'max_steps') {
          pushItem({ kind: 'status', text: 'stopped: tool-call budget reached (--max-steps to raise)', tone: 'warn' })
        } else if (result.status === 'failed') {
          pushItem({ kind: 'status', text: result.error ?? 'run failed', tone: 'error' })
        }
      } catch (err) {
        pushItem({ kind: 'status', text: err instanceof Error ? err.message : String(err), tone: 'error' })
      } finally {
        abortRef.current = null
        setApproval(null)
        setRunning(false)
        const next = queueRef.current.shift()
        if (next) void startRun(next)
      }
    },
    [flags.maxSteps, handleEvent, info, mode, model, pushItem, session],
  )

  // ── pickers ───────────────────────────────────────────────────────────────
  const openModelPicker = useCallback(
    (targetProviderId = providerId, targetBaseUrl?: string): void => {
      setPicker({ kind: 'model', loading: true, models: [] })
      void (async () => {
        try {
          const [cfg, auth] = await Promise.all([loadConfig(), loadAuth()])
          const preset = getPreset(targetProviderId)
          const custom = cfg.customProviders?.[targetProviderId]
          const baseUrl =
            targetBaseUrl ??
            (targetProviderId === initialProviderId ? initialBaseUrl : undefined) ??
            cfg.baseUrls?.[targetProviderId] ??
            custom?.baseUrl ??
            (preset?.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined) ??
            preset?.baseUrl ??
            undefined
          const envKey = preset?.envKey ?? (custom ? 'HESDOR_CUSTOM_API_KEY' : undefined)
          const envVal = envKey ? process.env[envKey] : undefined
          const apiKey = envVal ?? auth[targetProviderId]
          const models = await fetchModels({
            provider: targetProviderId,
            customKind: preset?.kind ?? custom?.kind ?? (baseUrl ? 'openai' : undefined),
            ...(baseUrl ? { baseUrl } : {}),
            ...(apiKey ? { apiKey } : {}),
          })
          if (models.length === 0) throw new Error('provider returned an empty catalog')
          setPicker({ kind: 'model', loading: false, models })
        } catch (err) {
          setPicker({
            kind: 'model',
            loading: false,
            models: [],
            error: `${err instanceof Error ? err.message : String(err)} — check /provider setup`,
          })
        }
      })()
    },
    [initialBaseUrl, initialProviderId, providerId],
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

  const finishProviderSetup = useCallback(
    (id: string): void => {
      setProviderId(id)
      void saveConfig({ provider: id })
      pushItem({ kind: 'status', text: `provider → ${id} (saved)`, tone: 'info' })
      openModelPicker(id)
    },
    [openModelPicker, pushItem],
  )

  /** Provider chosen → walk through URL/key steps only when missing. */
  const beginProviderSetup = useCallback(
    (id: string): void => {
      void (async () => {
        const [cfg, auth] = await Promise.all([loadConfig(), loadAuth()])
        const preset = getPreset(id)
        const custom = cfg.customProviders?.[id]
        if (!preset && !custom) {
          pushItem({ kind: 'status', text: `unknown provider "${id}"`, tone: 'error' })
          return
        }
        if (custom) {
          setProviderId(id)
          void saveConfig({ provider: id })
          pushItem({ kind: 'status', text: `provider set to ${id} (saved)`, tone: 'info' })
          openModelPicker(id)
          return
        }
        if (!preset) return
        const hasUrl = Boolean(preset.baseUrl ?? cfg.baseUrls?.[id] ?? (preset.baseUrlEnvKey ? process.env[preset.baseUrlEnvKey] : undefined))
        const envVal = preset.envKey ? process.env[preset.envKey] : undefined
        const hasKey = !preset.requiresApiKey || Boolean(envVal || auth[id])
        if (!hasUrl) setSetup({ kind: 'url', provider: id })
        else if (!hasKey) setSetup({ kind: 'key', provider: id })
        else finishProviderSetup(id)
      })()
    },
    [finishProviderSetup, openModelPicker, pushItem],
  )

  const commandNames = useMemo<string[]>(
    () => [...BUILTIN_COMMANDS.map((c) => c.name), ...session.commands.keys()],
    [session],
  )

  const paletteItems = useMemo<CommandInfo[]>(() => {
    const custom: CommandInfo[] = [...session.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
    }))
    return [...custom, ...BUILTIN_COMMANDS]
  }, [session])

  const paletteQuery = input.startsWith('/') ? input.slice(1).trim().toLowerCase() : null
  const paletteFiltered = useMemo<CommandInfo[]>(() => {
    if (paletteQuery === null) return []
    const starts = paletteItems.filter((c) => c.name.startsWith(paletteQuery))
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
          if (target === 'build' || target === 'plan' || target === 'ask') {
            setMode(target)
            pushItem({ kind: 'status', text: `mode → ${target}`, tone: 'info' })
          } else {
            pushItem({ kind: 'status', text: `current mode: ${mode} (usage: /mode build|plan|ask)`, tone: 'info' })
          }
          return
        }
        case 'model': {
          if (argText !== '') {
            setModel(argText)
            void saveConfig({ model: argText })
            pushItem({ kind: 'status', text: `model set to ${argText} (saved)`, tone: 'info' })
            return
          }
          openModelPicker()
          return
        }
        case 'provider': {
          const target = argText.split(/\s+/)[0]?.toLowerCase()
          if (target) {
            setProviderId(target)
            void saveConfig({ provider: target })
            pushItem({ kind: 'status', text: `provider set to ${target} (saved)`, tone: 'info' })
            return
          }
          openProviderPicker()
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
          })
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
          })
          return
        }
        case 'reload': {
          void session.reload().then(() => {
            pushItem({
              kind: 'status',
              text: `reloaded: ${session.commands.size} commands · ${session.skills.length} skills · ${session.plugins.length} plugins · mcp ${session.mcpServerNames.length}`,
              tone: 'success',
            })
          })
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
              text: `recent sessions (/resume <number>):\n${metas
                .map((m, i) => `  ${i + 1}. ${new Date(m.updatedAt).toLocaleString()} · ${m.messageCount} msgs · ${m.title}`)
                .join('\n')}`,
              tone: 'info',
            })
          })
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
            historyRef.current = stored.messages
            sessionIdRef.current = stored.id
            sessionCreatedRef.current = stored.createdAt
            const restored = stored.messages.flatMap<Omit<Item, 'key'>>((m) => {
              if (m.role === 'user') return [{ kind: 'user', text: m.content }]
              if (m.role === 'assistant' && m.content.trim() !== '') {
                return [{ kind: 'assistant', text: m.content, live: false }]
              }
              return []
            })
            setItems((prev) => [...prev, ...restored.map((r) => ({ ...r, key: ++keyCounter.current } as Item))])
            pushItem({
              kind: 'status',
              text: `resumed "${stored.title}" (${stored.messages.length} messages) — /new starts fresh`,
              tone: 'success',
            })
          })
          return
        }
        case 'compact': {
          if (historyRef.current.length === 0) {
            pushItem({ kind: 'status', text: 'nothing to compact yet', tone: 'warn' })
            return
          }
          void (async () => {
            try {
              const cfg = await loadConfig()
              const selection = await resolveSelection(flags, cfg)
              const provider = createSelectedProvider({ ...selection, model })
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
                new AbortController().signal,
              )) {
                if (chunk.type === 'text') summary += chunk.text
              }
              if (summary.trim() === '') throw new Error('model returned an empty summary')
              historyRef.current = [{ role: 'user', content: `[earlier conversation summary]\n${summary.trim()}` }]
              pushItem({ kind: 'status', text: 'context compacted to a summary', tone: 'success' })
            } catch (err) {
              pushItem({
                kind: 'status',
                text: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
                tone: 'error',
              })
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
          pushItem({ kind: 'status', text: `new session ${sessionIdRef.current}`, tone: 'info' })
          return
        case 'clear':
          setItems([])
          historyRef.current = []
          stateRef.current.snapshots = []
          stateRef.current.redo = []
          return
        case 'help':
          pushItem({
            kind: 'status',
            text: `commands: ${commandNames.map((n) => `/${n}`).join(' · ')}\nkeys: tab mode · ↑↓ scroll · ctrl+p menu · esc cancel/stop`,
            tone: 'info',
          })
          return
        default: {
          const custom = session.commands.get(cmd)
          if (custom) {
            void startRun(custom.template.replace(/\$ARGUMENTS/g, argText))
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
    [commandNames, exit, flags, handleEvent, info.root, mode, model, openModelPicker, openProviderPicker, pushItem, running, session, startRun],
  )

  const handleSubmit = useCallback(
    (value: string): void => {
      const trimmed = value.trim()
      if (trimmed === '') return

      if (running && !trimmed.startsWith('/')) {
        setInput('')
        queueRef.current.push(trimmed)
        pushItem({ kind: 'status', text: 'queued — runs after the current task', tone: 'info' })
        return
      }
      if (running) return

      setInput('')

      if (trimmed.startsWith('/')) {
        const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
        executeCommand(rawName?.toLowerCase() ?? '', rest.join(' ').trim())
        return
      }

      void startRun(trimmed)
    },
    [executeCommand, pushItem, running, startRun],
  )

  // ── global keys ───────────────────────────────────────────────────────────
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      exit()
      return
    }
    if (approval || picker || review) return

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
        if (c) setInput(`/${c.name} `)
      }
      return
    }

    if (key.tab) {
      const next = mode === 'build' ? 'plan' : mode === 'plan' ? 'ask' : 'build'
      setMode(next)
      pushItem({ kind: 'status', text: `mode → ${next}`, tone: 'info' })
      return
    }

    if (key.upArrow) setScrollOffset((o) => Math.min(maxScrollRef.current, o + 1))
    else if (key.downArrow) setScrollOffset((o) => Math.max(0, o - 1))
  })

  // `hesdor "<prompt>"`: submit the initial prompt once after mount.
  const submittedRef = useRef(false)
  useEffect(() => {
    if (submittedRef.current || !initialPrompt || running) return
    submittedRef.current = true
    handleSubmit(initialPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, running, handleSubmit])

  // ── layout math ───────────────────────────────────────────────────────────
  const paletteVisible = paletteFiltered.length > 0 && input.startsWith('/')
  const paletteRows = paletteVisible ? paletteFiltered.length + 3 : 0
  const showSidebar = size.columns >= 96 && !picker
  const paneWidth = showSidebar ? Math.max(30, size.columns - SIDEBAR_W) : Math.max(20, size.columns)
  const budget = Math.max(3, bodyHeight - 2 - (picker ? 0 : paletteRows))

  const windowEnd = items.length - scrollOffset
  let acc = 0
  let windowStart = windowEnd
  for (let i = windowEnd - 1; i >= 0; i--) {
    const lines = estimateLines(items[i]!, paneWidth)
    if (acc + lines > budget && windowStart < windowEnd) break
    acc += lines
    windowStart = i
  }
  const shown = items.slice(windowStart, windowEnd)
  useEffect(() => {
    if (scrollOffset === 0) maxScrollRef.current = windowStart
  })

  const modeColor = mode === 'build' ? 'green' : mode === 'plan' ? 'yellow' : 'blue'
  const accent = approval ? 'red' : review ? 'magenta' : picker ? 'cyan' : running ? 'cyan' : modeColor

  const sidebarRows: Array<[string, string] | null> = [
    ['session', sessionIdRef.current.slice(0, 10)],
    ['messages', String(historyRef.current.length)],
    ['tokens', usageRef.current?.totalTokens != null ? String(usageRef.current.totalTokens) : '—'],
    ['undo depth', String(stateRef.current.snapshots.length)],
    null,
    ['branch', info.branch ?? '—'],
    ['changes', info.statusLines.length > 0 ? String(info.statusLines.length) : 'clean'],
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
      <Box borderStyle="round" borderColor={accent} paddingX={1} justifyContent="space-between">
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

      {/* body */}
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={paneWidth} borderStyle="round" borderColor={running ? 'cyan' : 'gray'} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="cyan">
              ACTIVITY
            </Text>
            <Text dimColor>{running ? `${spinner} working` : `${items.length} events`}</Text>
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
          {shown.map((item) => (
            <Box key={item.key} flexDirection="column">
              {item.kind === 'user' && (
                <Text color="cyan" bold>
                  ❯ {item.text}
                </Text>
              )}
              {item.kind === 'assistant' && (
                <Text color={item.live ? 'gray' : undefined}>
                  <Text color="cyan">◆ </Text>
                  {item.text}
                </Text>
              )}
              {item.kind === 'tool' && (
                <Text
                  dimColor={item.state !== 'fail'}
                  color={item.state === 'fail' ? 'red' : item.state === 'ok' ? 'green' : 'yellow'}
                >
                  {item.state === 'run' ? '● ' : item.state === 'ok' ? '✓ ' : '✗ '}
                  {item.label}
                </Text>
              )}
              {item.kind === 'status' && (
                <Text
                  dimColor={item.tone === 'info'}
                  color={
                    item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : item.tone === 'success' ? 'green' : undefined
                  }
                >
                  {scrollOffset === 0 && item === shown[shown.length - 1] && item.tone === 'info' && item.text.startsWith('queued')
                    ? item.text
                    : item.text}
                </Text>
              )}
            </Box>
          ))}
          {windowStart > 0 && <Text dimColor>··· ↑ {windowStart} earlier ···</Text>}
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
          title={`Models · ${providerId}`}
          items={picker.models.map((m) => ({ value: m, label: m }))}
          loading={picker.loading}
          error={picker.error}
          onPick={(m) => {
            setPicker(null)
            setInput('')
            setModel(m)
            void saveConfig({ model: m })
            pushItem({ kind: 'status', text: `model → ${m} (saved)`, tone: 'info' })
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
              const envVal = preset?.envKey ? process.env[preset.envKey] : undefined
              const auth = await loadAuth()
              if (preset?.requiresApiKey && !envVal && !auth[id]) {
                setSetup({ kind: 'key', provider: id })
              } else {
                finishProviderSetup(id)
              }
            })()
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
            })
          }}
        />
      )}

      {/* input dock */}
      {!picker && !approval && !review && !setup && (
        <Box borderStyle="round" borderColor={accent} paddingX={1}>
          <Text color="green" bold>
            {'› '}
          </Text>
          <TextInput
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
        />
      )}

      {review && (
        <DiffReview
          request={review.request}
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
}: {
  request: ApprovalRequest
  onResolve: (yes: boolean) => void
}): React.ReactElement {
  useInput((value, key) => {
    if (value === 'y' || value === 'Y') onResolve(true)
    else if (value === 'n' || value === 'N' || key.escape) onResolve(false)
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red">⚠ {request.title}</Text>
      {request.detail && <Text>{request.detail}</Text>}
      <Text dimColor>[y] approve · [n] deny · [esc] deny</Text>
    </Box>
  )
}
