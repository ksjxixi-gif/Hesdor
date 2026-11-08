import { ProviderError } from './provider.js'

/**
 * Parse `data:` payloads out of an SSE response body.
 * Yields one string per data line; empty string for comment/keepalive lines.
 */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError('provider response has no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let skipLF = false
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') throw err
        // undici reports a dropped socket as "terminated"; make it a classified, retryable error.
        throw new ProviderError(`stream interrupted: ${err instanceof Error ? err.message : String(err)}`, { kind: 'network' })
      })
      if (done) break
      let text = decoder.decode(value, { stream: true })
      // Lines end in CRLF, LF or CR (SSE spec). A CR that ends a chunk already ended its line,
      // so an LF starting the next chunk is the rest of that CRLF, not an empty line.
      const skip = skipLF && text.startsWith('\n')
      if (text) skipLF = text.endsWith('\r')
      if (skip) text = text.slice(1)
      const lines = (buffer + text).split(/\r\n|\r|\n/)
      buffer = lines.pop()!
      for (const line of lines) {
        if (line.startsWith('data:')) {
          yield line.slice(5).trim()
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
