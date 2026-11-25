import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Tests run in Node against the BUILT `dist/`, with the same six engine aliases
 * the build uses, so a helper that needs the engine in process (the gate
 * invariant, the golden loader) sees exactly the engine the binary shipped.
 *
 * `pool: 'forks'` because several suites spawn the binary, write temp trees and
 * set environment variables; a worker thread sharing state with its neighbour
 * would make a failure depend on ordering. `testTimeout` is generous because
 * the golden replay spawns the binary fourteen times over every text fixture.
 */
const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // ORDER IS LOAD-BEARING HERE. Vite matches a plain string alias as "equal,
    // or a path under it" and takes the FIRST hit, so a bare
    // '@ghostchars/engine' entry placed first would rewrite
    // '@ghostchars/engine/style' into '.../engine/index.ts/style'. The specific
    // keys go first. (esbuild prefers the longer match and does not care about
    // order, but the two files are kept identical so nobody has to remember
    // which tool is which.)
    alias: {
      '@ghostchars/engine/style': fromHere('../web/src/engine/style.ts'),
      '@ghostchars/engine/docx': fromHere('../web/src/engine/docx.ts'),
      '@ghostchars/engine/odt': fromHere('../web/src/engine/odt.ts'),
      '@ghostchars/engine/html': fromHere('../web/src/engine/html.ts'),
      '@ghostchars/engine/zip': fromHere('../web/src/engine/zip.ts'),
      '@ghostchars/engine': fromHere('../web/src/engine/index.ts'),
      // A seventh entry beyond the six the build uses, and it is not ours:
      // the engine's own docx.ts, odt.ts and html.ts import their siblings as
      // '@/engine', which is the WEB app's alias. esbuild resolves that from
      // web/tsconfig.json on its own (it reads the tsconfig nearest each file),
      // and tsc gets the same entry in cli/tsconfig.json, but Vite resolves
      // aliases globally and would fail the moment a test imported one of those
      // three modules in process.
      '@/engine': fromHere('../web/src/engine/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    pool: 'forks',
    testTimeout: 60_000,
  },
})
