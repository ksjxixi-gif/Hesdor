import { describe, expect, it } from 'vitest'
import { helpText, parseArgs } from './args.js'

describe('headless and session flags', () => {
  it('parses output, session and workspace flags', () => {
    const { command, prompt, flags } = parseArgs(['run', '--output-format', 'stream-json', '-o', 'out.md', '-c', '--allow-home', 'fix it'])
    expect(command).toBe('run')
    expect(prompt).toBe('fix it')
    expect(flags).toMatchObject({ outputFormat: 'stream-json', outputFile: 'out.md', continue: true, allowHome: true })
    expect(parseArgs(['-r', 'abc123']).flags.resume).toBe('abc123')
    expect(parseArgs(['--resume', 'abc', 'ask', 'q']).flags.resume).toBe('abc')
  })

  it('accepts "-" as the stdin prompt and rejects bad values', () => {
    expect(parseArgs(['ask', '-'])).toMatchObject({ command: 'ask', prompt: '-' })
    expect(() => parseArgs(['--output-format', 'xml'])).toThrow(/invalid --output-format/)
    expect(() => parseArgs(['-r'])).toThrow(/requires a value/)
  })

  it('documents exit codes', () => {
    expect(helpText()).toMatch(/3 provider error/)
    expect(helpText()).toMatch(/--output-format/)
  })
})
