/** Placeholder that replaces anything that looks like a secret. */
export const REDACTED = '[REDACTED]'

// Order matters: whole PEM blocks first, then specific key formats before the generic sk- pattern.
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED], // OpenAI (sk-, sk-proj-), OpenRouter (sk-or-), DeepSeek, ...
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`],
  // NAME=value, NAME: value, "NAME": "value" for names ending in KEY/TOKEN/SECRET/PASSWORD.
  // Values that read another variable (process.env.X, $X, os.environ[...]) are code, not secrets.
  [
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))(["']?\s*[:=]\s*)(["']?)(?!process\.|os\.|env\.|import\.|\$|\[REDACTED\])([^\s"'`,;)}]{8,})/g,
    `$1$2$3${REDACTED}`,
  ],
]

/** Replace likely secrets (provider keys, tokens, PEM blocks, KEY=value assignments) with [REDACTED]. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

/** Deep copy with every string redacted (keeps JSON structure valid, unlike redacting serialized text). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}
