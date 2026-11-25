/**
 * `mcp-proxy -- <command> [args...]`: wrap another MCP server and clean what it
 * sends the model.
 *
 * Everything after `--` is the wrapped server's own command line and is never
 * read as ghostchars flags, so `ghostchars mcp-proxy -- npx -y some-server
 * --help` starts that server with `--help` rather than printing this help.
 *
 * The proxy needs no MCP library: it reads newline-framed JSON-RPC itself, so
 * it lives in the main bundle and starts as fast as `clean`.
 */
import type { ParsedCommand } from '../args.js'
import { UsageError } from '../exit.js'
import { resolveCleanOptions } from '../options.js'
import * as strings from '../strings.js'

import { runProxy } from '../proxy/run.js'

export async function run(parsed: ParsedCommand): Promise<number> {
  const [command, ...args] = parsed.positionals
  if (command === undefined || command === '') throw new UsageError(strings.ERR_PROXY_NEEDS_COMMAND)
  const logPath = parsed.values.string('--log')
  if (logPath === '') throw new UsageError(strings.errNeedsValue('--log'))
  return await runProxy({
    command,
    args,
    options: resolveCleanOptions({ bar: 'default', max: parsed.values.bool('--max'), explicit: [] }),
    reportOnly: parsed.values.bool('--report-only'),
    ...(logPath === undefined ? {} : { logPath }),
  })
}
