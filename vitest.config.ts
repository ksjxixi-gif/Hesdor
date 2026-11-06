import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@hesdor/protocol': pkg('protocol'),
      '@hesdor/providers': pkg('providers'),
      '@hesdor/agent-core': pkg('agent-core'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 30000,
    // Used only by `pnpm test:coverage`, which needs the provider installed once:
    //   pnpm add -Dw @vitest/coverage-v8@3   (match the vitest major)
    // Report lands in coverage/ (text summary + lcov). Ratchet: once a baseline exists, add
    // `thresholds: { lines: <baseline>, autoUpdate: true }` so coverage can only go up (report G9).
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', 'packages/*/src/testing/**', 'packages/*/src/__fixtures__/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
})
