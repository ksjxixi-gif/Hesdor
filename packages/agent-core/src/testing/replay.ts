import { readFileSync, writeFileSync } from 'node:fs'
import type { ChatMessage, ChatRole, ModelProvider, StreamChunk, ToolSpec } from '@hesdor/protocol'

/**
 * Cassettes: recorded model turns replayed against the real agent loop and real tools.
 * One interaction per model request, in order. The `match` block checks the request's
 * last message so a behavior change in the loop or a tool fails loudly instead of
 * silently drifting the conversation.
 */
export interface CassetteMatch {
  role?: ChatRole
  toolCallId?: string
  /** Substrings the last message's content must contain. */
  contains?: string[]
  /** Substrings it must not contain. */
  notContains?: string[]
}

export interface CassetteError {
  message: string
  /** ProviderErrorKind; the loop reads `retryable` and `retryAfterMs` duck-typed. */
  kind?: string
  retryable?: boolean
  retryAfterMs?: number
}

export interface CassetteInteraction {
  note?: string
  match?: CassetteMatch
  /** Streamed in order; when `error` is also set, it is thrown after these chunks. */
  chunks?: StreamChunk[]
  error?: CassetteError
}

export interface Cassette {
  name: string
  description?: string
  model?: string
  interactions: CassetteInteraction[]
}

export interface ReplayedRequest {
  messages: ChatMessage[]
  tools: string[]
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError'
}

export function loadCassette(file: string): Cassette {
  return JSON.parse(readFileSync(file, 'utf8')) as Cassette
}

export function saveCassette(file: string, cassette: Cassette): void {
  writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`)
}

function abortError(): Error {
  const err = new Error('run cancelled')
  err.name = 'AbortError'
  return err
}

/** Replays a cassette. Any request beyond the cassette or not matching it throws a non-retryable ReplayError. */
export class ReplayProvider implements ModelProvider {
  readonly name = 'replay'
  readonly model: string
  readonly requests: ReplayedRequest[] = []
  /** Mismatches seen so far; the loop turns a throw into status "failed", so tests also check this. */
  readonly failures: string[] = []
  private next = 0

  constructor(readonly cassette: Cassette) {
    this.model = cassette.model ?? 'replay-model'
  }

  async *stream(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const n = this.next++
    this.requests.push({ messages: structuredClone(messages), tools: tools.map((t) => t.name) })
    const step = this.cassette.interactions[n]
    if (!step) this.fail(`unexpected request #${n + 1}: cassette "${this.cassette.name}" has ${this.cassette.interactions.length}`, messages)
    const problem = step.match ? mismatch(step.match, messages.at(-1)) : undefined
    if (problem) this.fail(`request #${n + 1} of "${this.cassette.name}"${step.note ? ` (${step.note})` : ''}: ${problem}`, messages)

    for (const chunk of step.chunks ?? []) {
      if (signal.aborted) throw abortError()
      yield structuredClone(chunk)
    }
    if (step.error) {
      const { message, ...props } = step.error
      throw Object.assign(new Error(message), { name: 'ProviderError', ...props })
    }
  }

  /** Throws when a request mismatched or the cassette was not fully used. */
  assertDone(): void {
    if (this.failures.length > 0) throw new ReplayError(this.failures.join('\n'))
    if (this.next !== this.cassette.interactions.length) {
      throw new ReplayError(`cassette "${this.cassette.name}" used ${this.next} of ${this.cassette.interactions.length} interactions`)
    }
  }

  private fail(message: string, messages: ChatMessage[]): never {
    const last = messages.at(-1)
    const detail = last ? `\nlast message (${last.role}${last.toolCallId ? ` ${last.toolCallId}` : ''}): ${last.content.slice(0, 400)}` : ''
    this.failures.push(message + detail)
    throw new ReplayError(message + detail)
  }
}

function mismatch(match: CassetteMatch, last: ChatMessage | undefined): string | undefined {
  if (!last) return 'request has no messages'
  if (match.role && last.role !== match.role) return `expected last message role ${match.role}, got ${last.role}`
  if (match.toolCallId && last.toolCallId !== match.toolCallId) return `expected tool result for ${match.toolCallId}, got ${last.toolCallId ?? 'none'}`
  const missing = match.contains?.find((s) => !last.content.includes(s))
  if (missing !== undefined) return `last message does not contain ${JSON.stringify(missing)}`
  const present = match.notContains?.find((s) => last.content.includes(s))
  if (present !== undefined) return `last message unexpectedly contains ${JSON.stringify(present)}`
  return undefined
}

/**
 * Wraps a real provider and records each request's chunks (and error) into a cassette.
 * Only the last message's role, tool call id and (for user prompts) its first 200 characters
 * become the match block: tool output holds paths and timings that differ between runs.
 */
export class RecordingProvider implements ModelProvider {
  readonly cassette: Cassette

  constructor(
    private readonly inner: ModelProvider,
    name: string,
  ) {
    this.cassette = { name, model: inner.model, interactions: [] }
  }

  get name(): string {
    return this.inner.name
  }

  get model(): string {
    return this.inner.model
  }

  async *stream(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const last = messages.at(-1)
    const interaction: CassetteInteraction = {
      ...(last
        ? {
            match: {
              role: last.role,
              ...(last.toolCallId ? { toolCallId: last.toolCallId } : {}),
              ...(last.role === 'user' ? { contains: [last.content.slice(0, 200)] } : {}),
            },
          }
        : {}),
      chunks: [],
    }
    this.cassette.interactions.push(interaction)
    try {
      for await (const chunk of this.inner.stream(messages, tools, signal)) {
        interaction.chunks!.push(structuredClone(chunk))
        yield chunk
      }
    } catch (err) {
      const e = err as { message?: unknown; kind?: unknown; retryable?: unknown; retryAfterMs?: unknown; name?: unknown }
      if (e?.name !== 'AbortError') {
        interaction.error = {
          message: String(e?.message ?? err),
          ...(typeof e?.kind === 'string' ? { kind: e.kind } : {}),
          ...(typeof e?.retryable === 'boolean' ? { retryable: e.retryable } : {}),
          ...(typeof e?.retryAfterMs === 'number' ? { retryAfterMs: e.retryAfterMs } : {}),
        }
      }
      throw err
    }
  }

  save(file: string): void {
    saveCassette(file, this.cassette)
  }
}
