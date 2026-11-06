/** Agent permission levels. */
export type AgentMode = 'build' | 'plan' | 'ask'

/** Risk classification for tools and commands. */
export type ToolRisk = 'READ' | 'WRITE' | 'EXECUTE' | 'NETWORK' | 'DESTRUCTIVE'

/** A tool invocation requested by the model. Arguments are a JSON string. */
export interface ToolCallRequest {
  id: string
  name: string
  argumentsJson: string
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool_result'

/** A base64-encoded image (png, jpeg, gif or webp) attached to a user or tool_result message. */
export interface ChatImage {
  /** image/png | image/jpeg | image/gif | image/webp */
  mediaType: string
  /** Base64, no data: prefix. */
  data: string
}

/** Largest image file sent to a model: 5 MB once base64-encoded, the strictest provider limit (Bedrock, Vertex). */
export const MAX_IMAGE_BYTES = 3_750_000

/** Image media type from a file's magic bytes; undefined when it is not png, jpeg, gif or webp. */
export function imageMediaType(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Provider-neutral conversation message. Providers translate this into their
 * wire format; the agent loop only ever deals with this shape.
 */
export interface ChatMessage {
  role: ChatRole
  content: string
  /** Present on assistant messages that request tool calls. */
  toolCalls?: ToolCallRequest[]
  /** Present on tool_result messages. */
  toolCallId?: string
  isError?: boolean
  /** User and tool_result only: images for the model. Adapters replace them with a note for models known to lack vision. */
  images?: ChatImage[]
  /** Assistant only: reasoning/thinking text the model showed, for display and adapters that echo it. */
  reasoning?: string
  /**
   * Assistant only: opaque state the adapter that produced this message needs replayed
   * (signed thinking blocks, thought signatures). Adapters tag it and ignore state they did not write.
   */
  providerState?: unknown
}

/** Tool description sent to the provider. */
export interface ToolSpec {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
}

/** Token accounting reported by providers, best-effort. */
export interface Usage {
  /** All input tokens, including cache reads and writes. */
  inputTokens?: number
  /** Part of inputTokens read from the prompt cache. */
  cacheReadTokens?: number
  /** Part of inputTokens written to the prompt cache. */
  cacheWriteTokens?: number
  outputTokens?: number
  totalTokens?: number
  ready?: boolean
  /** USD cost the provider reported itself (e.g. OpenRouter `usage.cost`); preferred over catalog prices. */
  costUsd?: number
}

/** Incremental chunk streamed from a model provider. */
export type StreamChunk =
  | { type: 'text'; text: string }
  /** Reasoning text; may be empty to signal that hidden thinking started. */
  | { type: 'reasoning'; text: string }
  /** Adapter-owned state to store on this turn's assistant message (last one wins). */
  | { type: 'provider_state'; state: unknown }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
  /** reason: 'stop' | 'tool_calls' | 'length' (cut off by the output token limit). */
  | { type: 'finish'; reason: string; usage?: Usage }

/** Provider failure classes; adapter errors carry one as `kind`. */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'context_overflow'
  | 'model_not_found'
  | 'bad_request'
  | 'network'
  | 'unknown'

/**
 * Event protocol. The agent core emits these; every UI consumes them and the
 * core itself never prints to the terminal.
 */
export type RunEvent =
  | { type: 'run.started'; mode: AgentMode; model: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.reasoning'; text: string }
  | { type: 'assistant.message'; content: string; toolCalls: ToolCallRequest[] }
  | { type: 'tool.started'; callId: string; name: string; summary: string }
  | { type: 'tool.output'; callId: string; chunk: string }
  | { type: 'tool.completed'; callId: string; name: string; summary: string }
  | { type: 'tool.failed'; callId: string; name: string; error: string }
  | { type: 'file.changed'; path: string; op: 'write' | 'delete' }
  | { type: 'command.output'; stream: 'stdout' | 'stderr'; line: string }
  /** A request failed before any output and is retried after delayMs. */
  | { type: 'provider.retry'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** truncated: the final answer was cut off by the max output token limit. */
  | { type: 'run.completed'; steps: number; usage?: Usage; truncated?: boolean }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }
  /** A command hook failed (non-blocking) or returned a `systemMessage` for the user. */
  | { type: 'hook.notice'; event: string; message: string }
  /** Turn checkpoints are unavailable for this workspace (too large, or git failed); sent once per workspace. */
  | { type: 'checkpoint.skipped'; reason: string }
  /**
   * The history was shrunk to fit the context window: 'prune' replaced old tool outputs,
   * 'summary' also replaced older turns with a model-written summary. Token counts are estimates.
   */
  | { type: 'context.compacted'; phase: 'prune' | 'summary'; beforeTokens: number; afterTokens: number }
  /** The model failed (overloaded, rate limit after retries, quota, network); the rest of the turn uses `to` (`provider/model`). */
  | { type: 'provider.fallback'; from: string; to: string; reason: string }
  /** The guardian reviewed an approval: allow skips the prompt, deny asks the human, disabled turns it off for the session. */
  | { type: 'approval.guardian'; decision: 'allow' | 'deny' | 'disabled'; action: string; reason: string }
  /** Goal mode: the evaluator judged turn `turn` (1-based) against the goal condition. */
  | { type: 'goal.evaluated'; turn: number; verdict: 'met' | 'not_yet' | 'impossible'; reason: string }

/** Terminal outcome of an agent run. */
export interface AgentResult {
  status: 'completed' | 'max_steps' | 'cancelled' | 'failed'
  messages: ChatMessage[]
  usage?: Usage
  error?: string
  /** The final answer was cut off by the max output token limit. */
  truncated?: boolean
  /**
   * Older turns were replaced by a summary, so `messages` no longer extends the history passed in:
   * save it as a new session linked to the previous one instead of overwriting that one.
   */
  compacted?: boolean
}

/**
 * Provider-neutral streaming chat interface. Implemented in @hesdor/providers;
 * the agent loop consumes only this contract.
 */
export interface ModelProvider {
  readonly name: string
  readonly model: string
  stream(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<StreamChunk>
}

export const AGENT_MODES: readonly AgentMode[] = ['build', 'plan', 'ask']

export function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value)
}
