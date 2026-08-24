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
}

/** Tool description sent to the provider. */
export interface ToolSpec {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
}

/** Token accounting reported by providers, best-effort. */
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  ready?: boolean
}

/** Incremental chunk streamed from a model provider. */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'finish'; reason: string; usage?: Usage }

/**
 * Event protocol. The agent core emits these; every UI consumes them and the
 * core itself never prints to the terminal.
 */
export type RunEvent =
  | { type: 'run.started'; mode: AgentMode; model: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; content: string; toolCalls: ToolCallRequest[] }
  | { type: 'tool.started'; callId: string; name: string; summary: string }
  | { type: 'tool.output'; callId: string; chunk: string }
  | { type: 'tool.completed'; callId: string; name: string; summary: string }
  | { type: 'tool.failed'; callId: string; name: string; error: string }
  | { type: 'file.changed'; path: string; op: 'write' | 'delete' }
  | { type: 'command.output'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'run.completed'; steps: number; usage?: Usage }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }

/** Terminal outcome of an agent run. */
export interface AgentResult {
  status: 'completed' | 'max_steps' | 'cancelled' | 'failed'
  messages: ChatMessage[]
  usage?: Usage
  error?: string
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
