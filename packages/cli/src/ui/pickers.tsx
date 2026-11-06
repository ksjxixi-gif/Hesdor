import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

export interface PickerItem {
  value: string
  label: string
  hint?: string
}

export interface ListPickerProps {
  title: string
  items: PickerItem[]
  /** Show a loading hint instead of the filter input while true. */
  loading?: boolean
  error?: string
  onPick: (value: string) => void
  onClose: () => void
}

const VISIBLE = 14

/** Full-width searchable picker dialog (provider list, model catalog, ...). */
export function ListPicker({ title, items, loading, error, onPick, onClose }: ListPickerProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)

  const filtered = useMemo<PickerItem[]>(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? items : items.filter((i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q))
  }, [items, query])

  const start = Math.min(Math.max(0, sel - VISIBLE + 1), Math.max(0, filtered.length - VISIBLE))
  const visible = filtered.slice(start, start + VISIBLE)

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useInput((_ch, key) => {
    if (key.upArrow) setSel((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSel((s) => Math.max(0, Math.min(filtered.length - 1, s + 1)))
    else if (key.escape || key.tab) onClose()
    else if (key.return) {
      const item = filtered[sel]
      if (item) onPick(item.value)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {title}
        </Text>
        {!loading && <Text dimColor>{filtered.length} match{filtered.length === 1 ? '' : 'es'}</Text>}
      </Box>
      {loading ? (
        <Text dimColor>loading…</Text>
      ) : (
        <>
          <Box>
            <Text dimColor>filter › </Text>
            <TextInput value={query} onChange={setQuery} placeholder="type to search…" />
          </Box>
          {error && <Text color="red">{error}</Text>}
          {start > 0 && <Text dimColor>↑ more</Text>}
          {visible.map((item, i) =>
            i + start === sel ? (
              <Box key={item.value} columnGap={1}>
                <Text color="cyan" bold>
                  › {item.label}
                </Text>
                {item.hint && <Text dimColor wrap="truncate">{item.hint}</Text>}
              </Box>
            ) : (
              <Box key={item.value} columnGap={1}>
                <Text> {item.label}</Text>
                {item.hint && <Text dimColor wrap="truncate">{item.hint}</Text>}
              </Box>
            ),
          )}
          {start + visible.length < filtered.length && <Text dimColor>↓ more</Text>}
          {filtered.length === 0 && !error && <Text dimColor>no matches — esc to close</Text>}
        </>
      )}
      <Text dimColor>[↑↓] move · [enter] select · [esc] close</Text>
    </Box>
  )
}

export interface PromptBoxProps {
  title: string
  placeholder?: string
  /** Mask input characters (for API keys). */
  password?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** Single-line modal prompt used for base URLs and API keys during setup. */
export function PromptBox({ title, placeholder, password, onSubmit, onCancel }: PromptBoxProps): React.ReactElement {
  const [value, setValue] = useState('')

  useInput((_ch, key) => {
    if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>{title}</Text>
      <Box>
        <Text color="green">{'> '}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={() => value.trim() !== '' && onSubmit(value.trim())}
          placeholder={placeholder ?? ''}
          mask={password ? '•' : undefined}
        />
      </Box>
      <Text dimColor>[enter] confirm · [esc] cancel</Text>
    </Box>
  )
}
