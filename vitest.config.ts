import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

// *.live.test.ts send real, billed requests: only `pnpm test:live` (--mode live) or HESDOR_LIVE=1 runs them.
export default defineConfig(({ mode }) => {
  const live = mode === 'live' || process.env.HESDOR_LIVE === '1'
  return {
  resolve: {
    alias: {
      '@hesdor/protocol': pkg('protocol'),
      '@hesdor/providers': pkg('providers'),
      '@hesdor/agent-core': pkg('agent-core'),
    },
  },
  test: {
    include: [mode === 'live' ? 'packages/*/src/**/*.live.test.ts' : 'packages/*/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(live ? [] : ['**/*.live.test.ts'])],
    env: live ? { HESDOR_LIVE: '1' } : {},
    testTimeout: mode === 'live' ? 180_000 : 30000,
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
  }
})
