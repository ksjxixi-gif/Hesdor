import React, { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { capDiff, diffStats, unifiedDiff } from '../diff.js'

export interface DiffReviewRequest {
  path: string
  before: string | null
  after: string | null
}

export interface DiffReviewProps {
  request: DiffReviewRequest
  /** Rendered height budget for the diff body. */
  maxLines?: number
  onResolve: (decision: 'accept' | 'reject' | 'always') => void
}

/**
 * Codex-style change review: colored unified diff with accept/reject.
 * `a` (always) accepts this and every future change for the session.
 */
export function DiffReview({ request, maxLines = 16, onResolve }: DiffReviewProps): React.ReactElement {
  const body = useMemo(() => {
    if (request.before === null) {
      return capDiff(fileLines(request.after).map((text) => ({ kind: 'add' as const, text })))
    }
    if (request.after === null) {
      return capDiff(fileLines(request.before).map((text) => ({ kind: 'del' as const, text })))
    }
    return capDiff(unifiedDiff(request.before, request.after))
  }, [request])

  const stats = useMemo(() => diffStats(body.lines), [body])
  const shown = useMemo(() => {
    const limit = Math.max(1, maxLines)
    if (body.lines.length <= limit) return body.lines
    const head = Math.ceil((limit - 1) / 2)
    const tail = Math.max(0, limit - 1 - head)
    return [
      ...body.lines.slice(0, head),
      { kind: 'meta' as const, text: '· · · middle omitted · · ·' },
      ...(tail > 0 ? body.lines.slice(-tail) : []),
    ]
  }, [body, maxLines])
  const hidden = shown.length < body.lines.length

  useInput((ch, key) => {
    if (ch === 'y' || ch === 'Y' || key.return) onResolve('accept')
    else if (ch === 'n' || ch === 'N' || key.escape) onResolve('reject')
    else if (ch === 'a' || ch === 'A') onResolve('always')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text>
        <Text bold color="magenta">
          ⧉ review change
        </Text>{' '}
        <Text bold>{request.path}</Text>{' '}
        <Text color="green">+{stats.added}</Text> <Text color="red">-{stats.removed}</Text>
        {body.truncated || hidden ? <Text dimColor> (truncated)</Text> : undefined}
      </Text>
      {shown.map((line, idx) => (
        <Text
          key={idx}
          color={line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : 'gray'}
          dimColor={line.kind === 'ctx' || line.kind === 'meta'}
          wrap="truncate"
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
          {line.text}
        </Text>
      ))}
      <Text dimColor>
        [y] apply · [n] reject · [a] always allow this session
      </Text>
    </Box>
  )
}

function fileLines(content: string | null): string[] {
  if (content === null || content === '') return []
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}
