export type { ModelProvider } from '@hesdor/protocol'

export class ProviderError extends Error {
  readonly status?: number
  readonly body?: string

  constructor(message: string, options?: { status?: number; body?: string }) {
    super(options?.body ? `${message}: ${options.body}` : message)
    this.name = 'ProviderError'
    this.status = options?.status
    this.body = options?.body
  }
}

/** Build a descriptive error from a failed HTTP response. Never leaks secrets. */
export async function httpError(res: Response): Promise<ProviderError> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 2000)
  } catch {
    // ignore read failures
  }
  return new ProviderError(`provider request failed with HTTP ${res.status}`, {
    status: res.status,
    body,
  })
}

/** Join a base URL and path, tolerating a trailing slash on either side. */
export function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmed}${path}`
}
