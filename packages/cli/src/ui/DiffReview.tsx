import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { diffStats, showWhitespace, unifiedDiff } from '../diff.js'

export interface DiffReviewRequest {
  path: string
  before: string | null
  after: string | null
}

export interface DiffReviewProps {
  request: DiffReviewRequest
  /** Diff rows shown at once (the rest scrolls). */
  maxLines?: number
  /** The session has read web or MCP output (ToolContext state.tainted). */
  tainted?: boolean
  onResolve: (decision: 'accept' | 'reject' | 'always') => void
}

/** Keystrokes arriving this soon after a prompt opens were typed for something else. */
export const PROMPT_ARM_MS = 300

/**
 * Ref that turns true PROMPT_ARM_MS after mount. Approval prompts ignore input
 * until then, so type-ahead ("make it async") cannot answer them.
 */
export function useArmed(ms = PROMPT_ARM_MS): React.MutableRefObject<boolean> {
  const armed = useRef(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      armed.current = true
    }, ms)
    return () => clearTimeout(timer)
  }, [ms])
  return armed
}

/**
 * Codex-style change review: the whole diff, scrollable (arrows, PgUp/PgDn, Home/End), with
 * line numbers, @@ hunk headers and visible whitespace on changed lines.
 * Shift+A (always) accepts this and every future change for the session;
 * Enter does nothing, so a stray keypress never approves.
 */
export function DiffReview({ request, maxLines = 16, tainted, onResolve }: DiffReviewProps): React.ReactElement {
  const lines = useMemo(() => unifiedDiff(request.before ?? '', request.after ?? ''), [request])
  const stats = useMemo(() => diffStats(lines), [lines])
  const numWidth = useMemo(() => String(lines.reduce((max, l) => Math.max(max, l.oldNo ?? 0, l.newNo ?? 0), 1)).length, [lines])
  const page = Math.max(1, maxLines)
  const maxTop = Math.max(0, lines.length - page)
  const [top, setTop] = useState(0)
  const first = Math.min(top, maxTop)
  const shown = lines.slice(first, first + page)

  const armed = useArmed()
  useInput((ch, key) => {
    // Scrolling is not a decision, so it works before the prompt is armed.
    if (key.upArrow) setTop(Math.max(0, first - 1))
    else if (key.downArrow) setTop(Math.min(maxTop, first + 1))
    else if (key.pageUp) setTop(Math.max(0, first - page + 1))
    else if (key.pageDown) setTop(Math.min(maxTop, first + page - 1))
    else if (key.home) setTop(0)
    else if (key.end) setTop(maxTop)
    else if (!armed.current) return
    else if (ch === 'y' || ch === 'Y') onResolve('accept')
    else if (ch === 'n' || ch === 'N' || key.escape) onResolve('reject')
    else if (ch === 'A') onResolve('always')
  })

  const num = (n: number | undefined): string => (n === undefined ? '' : String(n)).padStart(numWidth)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color="magenta">
          ⧉ review change
        </Text>{' '}
        <Text bold>{request.path}</Text> <Text color="green">+{stats.added}</Text> <Text color="red">-{stats.removed}</Text>
        <Text dimColor>
          {request.before === null ? ' (new file)' : request.after === null ? ' (delete)' : ''}
          {lines.length > page ? ` · lines ${first + 1}-${first + shown.length} of ${lines.length}` : ''}
        </Text>
        {tainted && <Text color="yellow"> · after reading web/MCP content</Text>}
      </Text>
      {shown.map((line, idx) =>
        line.kind === 'meta' ? (
          <Text key={first + idx} color="cyan" wrap="truncate">
            {line.text}
          </Text>
        ) : (
          <Text key={first + idx} wrap="truncate">
            <Text dimColor>
              {num(line.oldNo)} {num(line.newNo)}{' '}
            </Text>
            <Text color={line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : 'gray'} dimColor={line.kind === 'ctx'}>
              {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
              {showWhitespace(line.text, line.kind !== 'ctx')}
            </Text>
          </Text>
        ),
      )}
      <Text dimColor wrap="truncate">
        {lines.length > page ? '[↑↓ pgup/pgdn home/end] scroll · ' : ''}[y] apply · [n] reject · [shift+a] always allow this session
      </Text>
    </Box>
  )
}
