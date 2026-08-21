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
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data:')) {
          yield line.slice(5).trim()
        }
        nl = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
