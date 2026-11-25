/**
 * The command line: one `node:util` `parseArgs` call per command, wrapped so
 * every failure comes back as a sentence a person or an agent can act on.
 *
 * WHY `parseArgs` AND NOT A DEPENDENCY. Verified on Node 24.12.0: it handles
 * short groups (`-as`), `--bar=text`, the `--` terminator, and it rejects an
 * unknown option with a code we can catch. That is the whole contract we need,
 * at zero bytes and zero dependencies, in a package that declares none.
 *
 * WHY NO PREFIX ABBREVIATION. argparse accepts `--punc` for `--punct`. We do
 * not. This differs from the Python reference: an abbreviation silently
 * changes meaning the day a new flag shares a prefix, and a CLI whose meaning
 * depends on which flags exist in which version is a bad contract for a
 * script. The unknown-flag error names the nearest known flag instead, which
 * recovers the ergonomics without the hazard.
 *
 * WHY THE TABLES LIVE HERE AND THE SENTENCES DO NOT. This module owns which
 * command accepts which flag and what type it is; `src/strings.ts` owns what
 * each flag means. `help --json` joins them, and `test/cli.errors.test.ts`
 * asserts the join is total, so the machine-readable surface cannot drift away
 * from the parser that has to honour it.
 *
 * FROZEN. The flag tables below are the contract every later
 * command module implements against.
 */
import { parseArgs } from 'node:util'

import { UsageError } from './exit.js'
import { OPTION_FLAGS } from './options.js'
import * as strings from './strings.js'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const COMMANDS = [
  'clean',
  'inspect',
  'report',
  'check',
  'mcp',
  'mcp-proxy',
  'canary',
  'help',
  'version',
] as const

export type CommandName = (typeof COMMANDS)[number]

export function isCommandName(value: string): value is CommandName {
  return COMMANDS.some((name) => name === value)
}

/** One flag, as the parser and the help output both need to see it. */
export interface FlagSpec {
  /** The long spelling, dashes included: `--bar`. */
  readonly long: string
  /** The single letter, no dash: `a`. Absent for a long-only flag. */
  readonly short?: string
  readonly type: 'boolean' | 'string'
  /** Placeholder shown in help for a value-taking flag: `<path>`. */
  readonly arg?: string
  /** The closed set of accepted values, when there is one. */
  readonly choices?: readonly string[]
  /** Shown in help as `(default: 200)`. Text, because the shape varies. */
  readonly defaultText?: string
}

/** Caps and limits that a command needs and `--help` prints. */
export const DEFAULT_INSPECT_LIMIT = 200
/** Positions reported per failing file, matching the MCP tool's own default. */
export const DEFAULT_CHECK_LIMIT = 20
/** 2 MiB. A source file bigger than this is not prose. */
export const DEFAULT_MAX_BYTES = 2_097_152

const HELP_FLAG: FlagSpec = { long: '--help', short: 'h', type: 'boolean' }
const VERSION_FLAG: FlagSpec = { long: '--version', type: 'boolean' }

/** `--help` and `--version` before any command name has been read. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [HELP_FLAG, VERSION_FLAG]

const BAR_FLAG: FlagSpec = {
  long: '--bar',
  type: 'string',
  arg: '<bar>',
  choices: ['default', 'text', 'max'],
  defaultText: 'default',
}

const GATE_BAR_FLAG: FlagSpec = {
  long: '--bar',
  type: 'string',
  arg: '<bar>',
  choices: ['default', 'text'],
  defaultText: 'default',
}

const JSON_FLAG: FlagSpec = { long: '--json', type: 'boolean' }

const STDIN_NAME_FLAG: FlagSpec = { long: '--stdin-name', type: 'string', arg: '<label>' }

const AS_FLAG: FlagSpec = {
  long: '--as',
  type: 'string',
  arg: '<mode>',
  choices: ['auto', 'text'],
  defaultText: 'auto',
}

/**
 * The thirteen cleaning switches plus `--max`, shared by `clean` and `inspect`.
 * `check` takes the thirteen as per-surface overrides but NOT `--max`: there is
 * no max bar for the gate, and offering the alias would be a back door to one.
 */
const OPTION_FLAG_SPECS: readonly FlagSpec[] = OPTION_FLAGS.map((option) =>
  option.short === undefined
    ? { long: option.long, type: 'boolean' }
    : { long: option.long, short: option.short, type: 'boolean' },
)

const MAX_FLAG: FlagSpec = { long: '--max', type: 'boolean' }

const CLEAN_FLAGS: readonly FlagSpec[] = [
  ...OPTION_FLAG_SPECS,
  MAX_FLAG,
  BAR_FLAG,
  { long: '--in-place', short: 'i', type: 'boolean' },
  { long: '--count', short: 'c', type: 'boolean' },
  { long: '--check', type: 'boolean' },
  JSON_FLAG,
  STDIN_NAME_FLAG,
  AS_FLAG,
  { long: '--output', short: 'o', type: 'string', arg: '<path>' },
  { long: '--metadata', type: 'boolean' },
  { long: '--rsids', type: 'boolean' },
]

const INSPECT_FLAGS: readonly FlagSpec[] = [
  ...OPTION_FLAG_SPECS,
  MAX_FLAG,
  BAR_FLAG,
  JSON_FLAG,
  STDIN_NAME_FLAG,
  AS_FLAG,
  {
    long: '--limit',
    type: 'string',
    arg: '<n>',
    defaultText: String(DEFAULT_INSPECT_LIMIT),
  },
]

const REPORT_FLAGS: readonly FlagSpec[] = [
  JSON_FLAG,
  STDIN_NAME_FLAG,
  {
    long: '--fail-on',
    type: 'string',
    arg: '<severity>',
    choices: ['none', 'low', 'medium', 'high'],
    defaultText: 'none',
  },
]

const CHECK_FLAGS: readonly FlagSpec[] = [
  GATE_BAR_FLAG,
  ...OPTION_FLAG_SPECS,
  { long: '--config', type: 'string', arg: '<path>' },
  { long: '--no-config', type: 'boolean' },
  { long: '--git', type: 'boolean' },
  { long: '--no-git', type: 'boolean' },
  {
    long: '--max-bytes',
    type: 'string',
    arg: '<n>',
    defaultText: String(DEFAULT_MAX_BYTES),
  },
  { long: '--limit', type: 'string', arg: '<n>', defaultText: String(DEFAULT_CHECK_LIMIT) },
  { long: '--fix', type: 'boolean' },
  JSON_FLAG,
  { long: '--sarif', type: 'boolean' },
  { long: '--verbose', type: 'boolean' },
]

const MCP_FLAGS: readonly FlagSpec[] = [
  { long: '--allow-write', type: 'boolean' },
  { long: '--tool-prefix', type: 'string', arg: '<prefix>' },
  { long: '--name', type: 'string', arg: '<name>', defaultText: strings.TOOL },
  { long: '--root', type: 'string', arg: '<path>' },
]

/**
 * `mcp-proxy` takes the wrapped server's command line after `--`, so its own
 * table stays small: one switch to only watch, one to keep a log, and `--max`
 * for the look-alike letters the default clean leaves alone.
 */
const MCP_PROXY_FLAGS: readonly FlagSpec[] = [
  { long: '--report-only', type: 'boolean' },
  { long: '--log', type: 'string', arg: '<file>' },
  MAX_FLAG,
]

/**
 * `canary embed` and `canary detect` share one table; the command checks which
 * flags make sense for which action. A key is read from a file or from the
 * environment and never from argv, where a process listing would show it.
 */
const CANARY_FLAGS: readonly FlagSpec[] = [
  { long: '--id', type: 'string', arg: '<id>' },
  { long: '--ids', type: 'string', arg: '<file>' },
  { long: '--out-dir', type: 'string', arg: '<dir>' },
  { long: '--key-file', type: 'string', arg: '<path>' },
  { long: '--key-env', type: 'string', arg: '<name>' },
  JSON_FLAG,
  STDIN_NAME_FLAG,
]

const HELP_FLAGS: readonly FlagSpec[] = [JSON_FLAG]

const VERSION_FLAGS: readonly FlagSpec[] = [JSON_FLAG]

/**
 * Every flag every command accepts. `--help` is appended to each table rather
 * than written into each one, because a command that does not answer `--help`
 * is a bug and this makes that impossible.
 */
export const FLAG_TABLES: Readonly<Record<CommandName, readonly FlagSpec[]>> = {
  clean: [...CLEAN_FLAGS, HELP_FLAG],
  inspect: [...INSPECT_FLAGS, HELP_FLAG],
  report: [...REPORT_FLAGS, HELP_FLAG],
  check: [...CHECK_FLAGS, HELP_FLAG],
  mcp: [...MCP_FLAGS, HELP_FLAG],
  'mcp-proxy': [...MCP_PROXY_FLAGS, HELP_FLAG],
  canary: [...CANARY_FLAGS, HELP_FLAG],
  help: [...HELP_FLAGS, HELP_FLAG],
  version: [...VERSION_FLAGS, HELP_FLAG],
}

/** The positional part of each usage line. */
export const COMMAND_ARGUMENTS: Readonly<Record<CommandName, string>> = {
  clean: '[flags] [files...]',
  inspect: '[flags] [files...]',
  report: '[flags] [files...]',
  check: '[flags] [paths...]',
  mcp: '[flags]',
  'mcp-proxy': '[flags] -- <command> [args...]',
  canary: 'embed|detect [flags] [file]',
  help: '[command] [--json]',
  version: '[--json]',
}

// ---------------------------------------------------------------------------
// reading the parsed values
// ---------------------------------------------------------------------------

/** Typed reads of one command's parsed flags. */
export interface FlagValues {
  /** True only when the boolean flag was given. */
  bool(long: string): boolean
  /** The string value, or undefined when the flag was not given. */
  string(long: string): string | undefined
  /** A non-negative whole number, or the fallback. Throws a usage error otherwise. */
  integer(long: string, fallback: number): number
}

const WHOLE_NUMBER = /^\d+$/

class ParsedValues implements FlagValues {
  readonly #raw: Readonly<Record<string, unknown>>

  constructor(raw: Readonly<Record<string, unknown>>) {
    this.#raw = raw
  }

  bool(long: string): boolean {
    return this.#raw[keyOf(long)] === true
  }

  string(long: string): string | undefined {
    const value = this.#raw[keyOf(long)]
    return typeof value === 'string' ? value : undefined
  }

  integer(long: string, fallback: number): number {
    const value = this.string(long)
    if (value === undefined) return fallback
    if (!WHOLE_NUMBER.test(value)) throw new UsageError(strings.errNeedsNumber(long, value))
    return Number(value)
  }
}

/** What a command module receives. Nothing else reads `process.argv`. */
export interface ParsedCommand {
  readonly name: CommandName
  readonly positionals: readonly string[]
  readonly values: FlagValues
  /** The command's own flag table, so `--help` can render it. */
  readonly flags: readonly FlagSpec[]
}

/** Every command module exports exactly this. */
export type CommandRun = (parsed: ParsedCommand) => Promise<number> | number

function keyOf(long: string): string {
  return long.startsWith('--') ? long.slice(2) : long
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

interface ParseArgsOption {
  type: 'boolean' | 'string'
  short?: string
}

function configFor(flags: readonly FlagSpec[]): Record<string, ParseArgsOption> {
  const config: Record<string, ParseArgsOption> = {}
  for (const flag of flags) {
    config[keyOf(flag.long)] =
      flag.short === undefined ? { type: flag.type } : { type: flag.type, short: flag.short }
  }
  return config
}

/** Levenshtein distance, iterative, two rows. Small inputs, no allocation storm. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const insert = (current[j - 1] ?? 0) + 1
      const remove = (previous[j] ?? 0) + 1
      current[j] = Math.min(substitute, insert, remove)
    }
    previous = current
  }
  return previous[b.length] ?? Math.max(a.length, b.length)
}

/**
 * The nearest known flag, or nothing.
 *
 * The threshold scales with the length of what was typed, so `--punc` finds
 * `--punct` while `--nope` suggests nothing at all. A wrong suggestion is worse
 * than none: it sends the caller down a second wrong path.
 */
export function nearestFlag(unknown: string, flags: readonly FlagSpec[]): string | undefined {
  const budget = Math.max(2, Math.floor(unknown.length / 3))
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const flag of flags) {
    const score = distance(unknown, flag.long)
    if (score < bestScore) {
      bestScore = score
      best = flag.long
    }
  }
  return bestScore <= budget ? best : undefined
}

/**
 * The first token in `argv` that is not a flag this command knows.
 *
 * `parseArgs` throws with a code but its message text is not a contract, so we
 * find the offending token ourselves. Value-taking flags consume the next token
 * (or the rest of a short group), which is why this walks rather than filters:
 * in `--stdin-name --weird`, `--weird` is a value, not an unknown flag.
 */
function firstUnknownToken(argv: readonly string[], flags: readonly FlagSpec[]): string | undefined {
  const byLong = new Map(flags.map((flag) => [flag.long, flag]))
  const byShort = new Map(
    flags.filter((flag) => flag.short !== undefined).map((flag) => [flag.short, flag]),
  )
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (token === '--') return undefined
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals === -1 ? token : token.slice(0, equals)
      const flag = byLong.get(name)
      if (flag === undefined) return name
      if (flag.type === 'string' && equals === -1) i += 1
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let c = 1; c < token.length; c += 1) {
        const letter = token[c]
        if (letter === undefined) break
        const flag = byShort.get(letter)
        if (flag === undefined) return `-${letter}`
        if (flag.type === 'string') {
          // The rest of the group is this flag's value, or the next token is.
          if (c === token.length - 1) i += 1
          break
        }
      }
    }
  }
  return undefined
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Parse one command's arguments.
 *
 * `argv` is what follows the command name. `name` is only used to word the
 * error, so `cli.ts` can parse a bare `ghostchars` invocation as `clean`.
 */
export function parseCommand(name: CommandName, argv: readonly string[]): ParsedCommand {
  const flags = FLAG_TABLES[name]
  try {
    const result = parseArgs({
      args: [...argv],
      options: configFor(flags),
      allowPositionals: true,
      strict: true,
    })
    return {
      name,
      positionals: result.positionals,
      values: new ParsedValues(result.values),
      flags,
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const token = firstUnknownToken(argv, flags) ?? '(unknown)'
      throw new UsageError(strings.errUnknownFlag(name, token, nearestFlag(token, flags)))
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const token = missingValueToken(argv, flags)
      throw new UsageError(
        token === undefined
          ? strings.errUnknownFlag(name, '(a flag)', undefined)
          : strings.errNeedsValue(token),
      )
    }
    throw error
  }
}

/**
 * Which value-taking flag was left without a value.
 *
 * `parseArgs` raises the same code for "boolean flag given a value" and "string
 * flag given none"; the second is the one people actually hit, and naming the
 * flag is the whole value of the message.
 */
function missingValueToken(
  argv: readonly string[],
  flags: readonly FlagSpec[],
): string | undefined {
  const stringFlags = new Set(
    flags.filter((flag) => flag.type === 'string').map((flag) => flag.long),
  )
  const last = argv[argv.length - 1]
  if (last !== undefined && stringFlags.has(last)) return last
  for (const token of argv) {
    if (token.startsWith('--') && token.includes('=')) {
      const name = token.slice(0, token.indexOf('='))
      if (!stringFlags.has(name) && flags.some((flag) => flag.long === name)) return name
    }
  }
  return undefined
}

/**
 * Split `process.argv.slice(2)` into a command and its arguments.
 *
 * A bare invocation is decided by the caller, not here: with no arguments and a
 * pipe on stdin the tool cleans stdin, which is what makes
 * `pbpaste | ghostchars | pbcopy` work.
 */
export function resolveCommand(argv: readonly string[]): { name: CommandName; rest: string[] } {
  const first = argv[0]
  if (first === undefined || !isCommandName(first)) {
    throw new UsageError(strings.errUnknownCommand(first ?? '', COMMANDS))
  }
  return { name: first, rest: argv.slice(1) }
}
