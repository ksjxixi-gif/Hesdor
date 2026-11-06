import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { McpElicitRequest, McpElicitResult } from '@hesdor/agent-core'
import { useArmed } from './DiffReview.js'
import { coerceField, formContent, formFields } from './logic.js'
import type { FormField } from './logic.js'

export interface ElicitFormProps {
  server: string
  request: McpElicitRequest
  onDone: (result: McpElicitResult) => void
}

/**
 * MCP elicitation: a server asks the user for input. Intro (fill in / decline / cancel), one step per
 * field, then a review before anything is sent. Every step ignores keys for 300 ms (useArmed), so
 * type-ahead cannot answer it; Esc cancels at any step.
 */
export function ElicitForm({ server, request, onDone }: ElicitFormProps): React.ReactElement {
  const schema = 'requestedSchema' in request ? request.requestedSchema : undefined
  const { fields, unsupported } = useMemo(() => formFields(schema), [schema])
  const blocked = unsupported.filter((u) => u.required).map((u) => u.key)
  const [step, setStep] = useState<'intro' | 'review' | number>('intro')
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial])))
  const next = (i: number): void => setStep(i + 1 < fields.length ? i + 1 : 'review')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow" wrap="truncate">
        ? MCP server "{server}" asks for input
      </Text>
      <Text wrap="wrap">{request.message}</Text>
      {step === 'intro' && <Intro fields={fields} unsupported={unsupported.map((u) => u.key)} blocked={blocked} onFill={() => setStep(fields.length ? 0 : 'review')} onDone={onDone} />}
      {typeof step === 'number' && (
        <FieldStep
          key={step}
          field={fields[step]!}
          index={step}
          total={fields.length}
          value={values[fields[step]!.key] ?? ''}
          onSubmit={(v) => {
            setValues((prev) => ({ ...prev, [fields[step]!.key]: v }))
            next(step)
          }}
          onCancel={() => onDone({ action: 'cancel' })}
        />
      )}
      {step === 'review' && <Review fields={fields} values={values} onEdit={() => setStep(fields.length ? 0 : 'intro')} onDone={onDone} />}
    </Box>
  )
}

function Intro({
  fields,
  unsupported,
  blocked,
  onFill,
  onDone,
}: {
  fields: FormField[]
  unsupported: string[]
  blocked: string[]
  onFill: () => void
  onDone: (r: McpElicitResult) => void
}): React.ReactElement {
  const armed = useArmed()
  useInput((ch, key) => {
    if (key.escape) onDone({ action: 'cancel' })
    else if (!armed.current) return
    else if (key.return && blocked.length === 0) onFill()
    else if (ch === 'd' || ch === 'D') onDone({ action: 'decline' })
  })
  return (
    <>
      <Text dimColor wrap="truncate">
        {fields.length > 0 ? `fields: ${fields.map((f) => `${f.label}${f.required ? '*' : ''}`).join(', ')}` : 'no fields: the server only wants a yes or no'}
      </Text>
      {unsupported.length > 0 && (
        <Text color={blocked.length ? 'red' : 'yellow'} wrap="truncate">
          {blocked.length ? `this form needs fields Hesdor cannot show (${blocked.join(', ')}); decline or cancel` : `skipped fields Hesdor cannot show: ${unsupported.join(', ')}`}
        </Text>
      )}
      <Text dimColor>{blocked.length ? '' : '[enter] fill in · '}[d] decline · [esc] cancel</Text>
    </>
  )
}

function FieldStep({
  field,
  index,
  total,
  value: initial,
  onSubmit,
  onCancel,
}: {
  field: FormField
  index: number
  total: number
  value: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.ReactElement {
  const armed = useArmed()
  const [value, setValue] = useState(initial)
  const [sel, setSel] = useState(() => Math.max(0, field.options?.findIndex((o) => o.value === initial) ?? 0))
  const [error, setError] = useState<string | undefined>()
  const submit = (v: string): void => {
    if (!armed.current) return
    const r = coerceField(field, v)
    if (r.ok) onSubmit(v)
    else setError(r.error)
  }
  useInput((_ch, key) => {
    if (key.escape) onCancel()
    else if (!field.options) return
    else if (key.upArrow) setSel((s) => Math.max(0, s - 1))
    else if (key.downArrow) setSel((s) => Math.min(field.options!.length - 1, s + 1))
    else if (key.return) submit(field.options[sel]?.value ?? '')
  })
  const range =
    field.min !== undefined || field.max !== undefined
      ? ` (${field.kind === 'string' ? 'length ' : ''}${field.min ?? ''}…${field.max ?? ''})`
      : ''
  return (
    <>
      <Text wrap="truncate">
        <Text bold>
          {field.label}
          {field.required ? '*' : ''}
        </Text>
        <Text dimColor>
          {' '}
          {field.kind}
          {range} · {index + 1}/{total}
        </Text>
      </Text>
      {field.description && <Text dimColor wrap="wrap">{field.description}</Text>}
      {field.options ? (
        field.options.map((o, i) => (
          <Text key={o.value} color={i === sel ? 'cyan' : undefined} bold={i === sel}>
            {i === sel ? '› ' : '  '}
            {o.label}
          </Text>
        ))
      ) : (
        <Box>
          <Text color="green">{'> '}</Text>
          <TextInput
            value={value}
            // Type-ahead from before the form opened must not land in a field.
            onChange={(v) => armed.current && setValue(v)}
            onSubmit={submit}
          />
        </Box>
      )}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>{field.options ? '[↑↓] choose · ' : ''}[enter] next · [esc] cancel</Text>
    </>
  )
}

function Review({
  fields,
  values,
  onEdit,
  onDone,
}: {
  fields: FormField[]
  values: Record<string, string>
  onEdit: () => void
  onDone: (r: McpElicitResult) => void
}): React.ReactElement {
  const armed = useArmed()
  const result = useMemo(() => formContent(fields, values), [fields, values])
  useInput((ch, key) => {
    if (key.escape) onDone({ action: 'cancel' })
    else if (!armed.current) return
    else if ((ch === 'y' || ch === 'Y') && result.ok) onDone({ action: 'accept', content: result.content })
    else if (ch === 'e' || ch === 'E') onEdit()
    else if (ch === 'd' || ch === 'D') onDone({ action: 'decline' })
  })
  return (
    <>
      <Text bold>Send this to the server?</Text>
      {fields.map((f) => (
        <Text key={f.key} wrap="truncate">
          <Text dimColor>{f.label}: </Text>
          {f.options?.find((o) => o.value === values[f.key])?.label ?? (values[f.key] || '(empty)')}
        </Text>
      ))}
      {!result.ok && <Text color="red">{result.error}</Text>}
      <Text dimColor>{result.ok ? '[y] send · ' : ''}[e] edit · [d] decline · [esc] cancel</Text>
    </>
  )
}
