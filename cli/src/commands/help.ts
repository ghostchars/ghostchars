/**
 * `help`, `--help`, and the machine-readable surface behind `help --json`.
 *
 * WHY `help --json` EXISTS. An agent that hits an unknown flag has two ways
 * out: guess again, or read the surface. One `help --json` call returns every
 * command, every flag, every bar and every exit code as one document, so the
 * unknown-flag error can point at it by name and the next attempt is informed
 * rather than lucky. It is also the anti-drift device: the document is built
 * from the same flag tables the parser uses, and a test asserts that every flag
 * it advertises is one the parser actually accepts.
 */
import { COMMANDS, COMMAND_ARGUMENTS, FLAG_TABLES, GLOBAL_FLAGS, isCommandName } from '../args.js'
import type { CommandName, FlagSpec, ParsedCommand } from '../args.js'
import { EXIT_OK, UsageError } from '../exit.js'
import { serializeJson } from '../json.js'
import { out, outLine } from '../io.js'
import { BARS, GATE_BARS, optionNames, optionsForBar } from '../options.js'
import * as strings from '../strings.js'

/** Which exit codes a command can actually produce. Part of the contract. */
const COMMAND_EXIT_CODES: Readonly<Record<CommandName, readonly number[]>> = {
  clean: [0, 1, 2, 3],
  inspect: [0, 1, 2, 3],
  report: [0, 1, 2, 3],
  check: [0, 1, 2, 3],
  mcp: [0, 2, 3],
  // Otherwise the wrapped server's own exit code, passed through.
  'mcp-proxy': [0, 2, 3],
  // detect: 0 when a mark was found, 1 when none was.
  canary: [0, 1, 2, 3],
  help: [0, 2],
  version: [0],
}

/** `-a, --aggressive` or `    --bar <bar>`, so the descriptions line up. */
function flagLabel(flag: FlagSpec): string {
  const short = flag.short === undefined ? '    ' : `-${flag.short}, `
  const argument = flag.arg === undefined ? '' : ` ${flag.arg}`
  return `${short}${flag.long}${argument}`
}

/** What a flag means for one command: the shared line unless it has its own. */
function flagSummary(flag: FlagSpec, command?: CommandName): string {
  const own = command === undefined ? undefined : strings.COMMAND_FLAG_SUMMARIES[command]?.[flag.long]
  return own ?? strings.FLAG_SUMMARIES[flag.long] ?? ''
}

function flagDescription(flag: FlagSpec, command: CommandName): string {
  const summary = flagSummary(flag, command)
  return flag.defaultText === undefined ? summary : `${summary} (default: ${flag.defaultText})`
}

function flagRows(flags: readonly FlagSpec[], command: CommandName): string[] {
  const labels = flags.map(flagLabel)
  const width = Math.min(28, Math.max(...labels.map((label) => label.length)))
  return flags.map((flag, index) => {
    const label = labels[index] ?? ''
    return `  ${label.padEnd(width)}  ${flagDescription(flag, command)}`.trimEnd()
  })
}

/** `ghostchars help`. */
export function topLevelHelp(): string[] {
  const lines = [
    `${strings.TOOL} ${strings.VERSION}`,
    strings.TAGLINE,
    '',
    strings.HELP_TOP_USAGE,
    '',
    strings.HELP_COMMANDS_HEADING,
  ]
  const width = Math.max(...COMMANDS.map((name) => name.length))
  for (const name of COMMANDS) {
    lines.push(`  ${name.padEnd(width)}  ${strings.COMMAND_SUMMARIES[name] ?? ''}`)
  }
  lines.push('', strings.HELP_BARS_HEADING)
  const barWidth = Math.max(...BARS.map((bar) => bar.length))
  for (const bar of BARS) {
    lines.push(`  ${bar.padEnd(barWidth)}  ${strings.BAR_SUMMARIES[bar] ?? ''}`)
  }
  lines.push('', strings.HELP_EXIT_HEADING)
  for (const [code, meaning] of strings.EXIT_CODE_MEANINGS) lines.push(`  ${code}  ${meaning}`)
  lines.push('', strings.HELP_FOOTER)
  return lines
}

/** `ghostchars help clean`, and `ghostchars clean --help`. */
export function commandHelp(name: CommandName): string[] {
  const lines = [
    strings.usageLine(name, COMMAND_ARGUMENTS[name]),
    '',
    strings.COMMAND_SUMMARIES[name] ?? '',
    '',
    strings.HELP_FLAGS_HEADING,
    ...flagRows(FLAG_TABLES[name], name),
  ]
  const examples = strings.COMMAND_EXAMPLES[name] ?? []
  if (examples.length > 0) {
    lines.push('', strings.HELP_EXAMPLES_HEADING)
    for (const example of examples) lines.push(`  ${example}`)
  }
  lines.push(
    '',
    `${strings.HELP_EXIT_HEADING} ${COMMAND_EXIT_CODES[name].join(', ')}`,
  )
  return lines
}

interface FlagDocument {
  readonly long: string
  readonly short: string | null
  readonly type: string
  readonly arg?: string
  readonly choices?: readonly string[]
  readonly default?: string
  readonly summary: string
}

function flagDocument(flag: FlagSpec, command?: CommandName): FlagDocument {
  return {
    long: flag.long,
    short: flag.short === undefined ? null : `-${flag.short}`,
    type: flag.type,
    ...(flag.arg === undefined ? {} : { arg: flag.arg }),
    ...(flag.choices === undefined ? {} : { choices: flag.choices }),
    ...(flag.defaultText === undefined ? {} : { default: flag.defaultText }),
    summary: flagSummary(flag, command),
  }
}

/** The whole surface, as one document. Built from the parser's own tables. */
export function helpDocument(): unknown {
  const bars: Record<string, readonly string[]> = {}
  for (const bar of BARS) bars[bar] = optionNames(optionsForBar(bar))
  return {
    tool: strings.TOOL,
    version: strings.VERSION,
    summary: strings.TAGLINE,
    bars,
    gateBars: [...GATE_BARS],
    exitCodes: strings.EXIT_CODE_MEANINGS.map(([code, meaning]) => ({ code, meaning })),
    globalFlags: GLOBAL_FLAGS.map((flag) => flagDocument(flag)),
    commands: COMMANDS.map((name) => ({
      name,
      summary: strings.COMMAND_SUMMARIES[name] ?? '',
      arguments: COMMAND_ARGUMENTS[name],
      exitCodes: COMMAND_EXIT_CODES[name],
      flags: FLAG_TABLES[name].map((flag) => flagDocument(flag, name)),
      examples: strings.COMMAND_EXAMPLES[name] ?? [],
    })),
  }
}

export function run(parsed: ParsedCommand): number {
  if (parsed.values.bool('--json')) {
    out(serializeJson(helpDocument()))
    return EXIT_OK
  }
  const topic = parsed.positionals[0]
  if (topic === undefined) {
    for (const line of topLevelHelp()) outLine(line)
    return EXIT_OK
  }
  if (!isCommandName(topic)) throw new UsageError(strings.errNoSuchHelpTopic(topic, COMMANDS))
  for (const line of commandHelp(topic)) outLine(line)
  return EXIT_OK
}
