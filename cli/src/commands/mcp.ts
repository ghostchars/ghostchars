/**
 * `mcp`: three lines of real work, and one important thing they must not do.
 *
 * WHY LAZILY, AND WHY A SEPARATE BUNDLE. The MCP SDK plus zod is most of a
 * megabyte of JavaScript to parse. `clean` is the command an agent and a CI
 * walk call hundreds of times, and it must not pay for a server it never
 * starts. `dist/mcp.js` is its own esbuild entry point, self-contained, and is
 * read from disk only when somebody types `ghostchars mcp`.
 *
 * WHICH IS WHY THE ONLY IMPORT FROM `src/mcp/` BELOW IS A TYPE. A value import
 * of anything under `src/mcp/` would pull the SDK straight back into
 * `dist/main.js` and undo the split. `verbatimModuleSyntax` keeps `import type`
 * honest: it is erased by both `tsc` and esbuild, so the bundle never names the
 * module at all. `test/mcp.stdio.test.ts` asserts that `dist/main.js` contains
 * no reference to the SDK.
 *
 * The specifier is built at runtime rather than written as a literal so that
 * esbuild leaves it alone instead of following it into this bundle.
 */
import type { ParsedCommand } from '../args.js'
import { UsageError } from '../exit.js'
import type { ServeOptions } from '../mcp/server.js'
import * as strings from '../strings.js'

/** The one export `dist/mcp.js` is required to have. */
interface McpBundle {
  readonly serve: (options: ServeOptions) => Promise<number>
}

/**
 * This package bans `as`, so a module loaded by a runtime specifier (which
 * TypeScript can only type as `any`) is narrowed by a hand-written guard, the
 * same way every other trust boundary in this package is.
 */
function isMcpBundle(value: unknown): value is McpBundle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'serve' in value &&
    typeof value.serve === 'function'
  )
}

export async function run(parsed: ParsedCommand): Promise<number> {
  const options: ServeOptions = {
    name: parsed.values.string('--name') ?? strings.TOOL,
    allowWrite: parsed.values.bool('--allow-write'),
    toolPrefix: parsed.values.string('--tool-prefix') ?? '',
    root: parsed.values.string('--root') ?? process.cwd(),
  }

  const href = new URL('./mcp.js', import.meta.url).href
  const loaded: unknown = await import(href)
  if (!isMcpBundle(loaded)) {
    // A corrupt or partial install: `dist/mcp.js` is there but is not the
    // bundle we built. Exit 2, not 3, because nothing is wrong with ghostchars
    // itself and the fix is a reinstall rather than a bug report. The sentence
    // comes from src/strings.ts, like every other one a person reads.
    throw new UsageError(strings.ERR_MCP_BUNDLE_MISSING)
  }
  return await loaded.serve(options)
}
