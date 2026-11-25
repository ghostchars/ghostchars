/**
 * `version` and `--version`.
 *
 * The bare form prints the version and nothing else, so
 * `V=$(ghostchars version)` is a version and not a sentence to parse.
 * `--json` adds the running Node version, which is the first thing anyone asks
 * for in a bug report.
 */
import type { ParsedCommand } from '../args.js'
import { EXIT_OK } from '../exit.js'
import { out, outLine } from '../io.js'
import { serializeJson } from '../json.js'
import * as strings from '../strings.js'

export function run(parsed: ParsedCommand): number {
  if (parsed.values.bool('--json')) {
    out(
      serializeJson({
        tool: strings.TOOL,
        version: strings.VERSION,
        node: process.versions.node,
      }),
    )
    return EXIT_OK
  }
  outLine(strings.VERSION)
  return EXIT_OK
}
