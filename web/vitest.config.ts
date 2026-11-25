import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/** The engine's tests run against source, in Node. `@/` resolves to `src`. */
export default defineConfig({
  resolve: {
    alias: {
      '@/': `${fromHere('./src')}/`,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
})
