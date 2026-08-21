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
  },
})
