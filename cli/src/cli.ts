/**
 * The entry point of `dist/main.js`: read argv, dispatch, set an exit code.
 *
 * WHY `process.exitCode` AND NEVER `process.exit()`. `clean` writes whole files
 * to stdout, and `process.exit` truncates a pending pipe write: the process
 * dies with bytes still queued in the kernel and the reader silently gets a
 * short file. Setting `process.exitCode` and returning lets Node drain the
 * stream first. The single exception is the EPIPE guard in `src/io.ts`, which
 * exits immediately because the reader is already gone.
 *
 * WHY A BARE INVOCATION SPLITS ON A TTY. With no arguments and a terminal on
 * stdin, printing help is the only useful thing to do. With no arguments and a
 * pipe, the useful thing is to clean what is coming down it, so
 * `pbpaste | ghostchars | pbcopy` works with nothing to remember. Anything else
 * that is not a known command is a usage error that lists the commands.
 *
 * WHY EXIT 3 EXISTS. Code 3 has no Python counterpart, so it cannot diverge
 * from parity. It is here so a caller can tell "I passed the wrong flag" from
 * "the tool broke", which are different next actions, and so a bug report gets
 * a stack when `GHOSTCHARS_DEBUG=1` is set instead of a shrug.
 */
import { parseCommand, resolveCommand } from './args.js'
import type { CommandName, CommandRun } from './args.js'
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, UsageError } from './exit.js'
import { errLine, outLine } from './io.js'
import * as strings from './strings.js'

import * as canary from './commands/canary.js'
import * as check from './commands/check.js'
import * as clean from './commands/clean.js'
import * as help from './commands/help.js'
import * as inspect from './commands/inspect.js'
import * as mcp from './commands/mcp.js'
import * as mcpProxy from './commands/mcp-proxy.js'
import * as report from './commands/report.js'
import * as version from './commands/version.js'

/**
 * Every command name resolves here. `mcp` is the only one whose real work lives
 * in another bundle, and it reaches it through a dynamic import so that nothing
 * but `ghostchars mcp` ever pays for the SDK.
 */
const RUNNERS: Readonly<Record<CommandName, CommandRun>> = {
  clean: clean.run,
  inspect: inspect.run,
  report: report.run,
  check: check.run,
  mcp: mcp.run,
  'mcp-proxy': mcpProxy.run,
  canary: canary.run,
  help: help.run,
  version: version.run,
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const first = argv[0]

  if (first === undefined) {
    if (process.stdin.isTTY === true) {
      for (const line of help.topLevelHelp()) outLine(line)
      outLine('')
      outLine(strings.HELP_BARE_HINT)
      return EXIT_OK
    }
    return await RUNNERS.clean(parseCommand('clean', []))
  }

  if (first === '--help' || first === '-h') return help.run(parseCommand('help', argv.slice(1)))
  if (first === '--version') return version.run(parseCommand('version', argv.slice(1)))

  const { name, rest } = resolveCommand(argv)
  const parsed = parseCommand(name, rest)
  if (parsed.values.bool('--help')) {
    for (const line of help.commandHelp(name)) outLine(line)
    return EXIT_OK
  }
  return await RUNNERS[name](parsed)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown failure'
}

/** The whole run, with the two top-level catches. Returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      errLine(error.message)
      return EXIT_USAGE
    }
    errLine(strings.internalError(messageOf(error)))
    if (process.env['GHOSTCHARS_DEBUG'] === '1' && error instanceof Error) {
      errLine(error.stack ?? '(no stack)')
    }
    return EXIT_INTERNAL
  }
}

process.exitCode = await main(process.argv.slice(2))
