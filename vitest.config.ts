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
  },
  }
})
