/**
 * The thirteen cleaning switches, the three bars, and the one fixed order in
 * which a command turns them into a {@link CleanOptions} object.
 *
 * WHY A BAR AT ALL. Thirteen booleans are a fine interface for a person who has
 * read the README and a terrible one for an agent, which will pick a plausible
 * subset and be quietly wrong. A bar is one word with a documented meaning:
 * `default` for characters nobody chose, `text` for the typography of prose a
 * person reads, `max` for everything including passes that rewrite letters.
 *
 * WHY OPTIONS CAN ONLY BE TURNED ON. `strip_invisible.py` has no `--no-punct`,
 * so neither do we. Subtracting from a bar would also make the resolution order
 * observable in a way nobody could predict from the command line.
 */
import {
  CLEAN_OPTION_KEYS,
  DEFAULT_OPTIONS,
  MAX_OPTIONS,
  type CleanOptionKey,
  type CleanOptions,
} from '@ghostchars/engine'

import { UsageError } from './exit.js'
import * as strings from './strings.js'

export { CLEAN_OPTION_KEYS }
export type { CleanOptionKey, CleanOptions }

/** How hard to clean, as one word. */
export const BARS = ['default', 'text', 'max'] as const
export type Bar = (typeof BARS)[number]

/**
 * The bars a gate may hold a file to.
 *
 * `max` is deliberately absent, in the CLI and in MCP alike: it folds
 * look-alike letters and applies NFKC, which condemns legitimate Cyrillic,
 * Greek and emoji content. A gate that fails out of the box on a repository's
 * real content gets deleted by the people who installed it.
 */
export const GATE_BARS = ['default', 'text'] as const
export type GateBar = (typeof GATE_BARS)[number]

export function isBar(value: string): value is Bar {
  return BARS.some((bar) => bar === value)
}

export function isGateBar(value: string): value is GateBar {
  return GATE_BARS.some((bar) => bar === value)
}

/** The CLI spelling of each option, identical to the Python reference CLI. */
export interface OptionFlagSpec {
  readonly key: CleanOptionKey
  readonly long: string
  readonly short?: string
}

/**
 * The thirteen, in the order `strip_invisible.py` documents them. `--help` prints
 * them in this order and `help --json` lists them in this order, so the two
 * tools describe themselves the same way.
 */
export const OPTION_FLAGS: readonly OptionFlagSpec[] = [
  { key: 'aggressive', long: '--aggressive', short: 'a' },
  { key: 'spaces', long: '--spaces', short: 's' },
  { key: 'newlines', long: '--newlines', short: 'n' },
  { key: 'bidi', long: '--bidi' },
  { key: 'controls', long: '--controls' },
  { key: 'pua', long: '--pua' },
  { key: 'punct', long: '--punct' },
  { key: 'confusables', long: '--confusables' },
  { key: 'nfc', long: '--nfc' },
  { key: 'nfkc', long: '--nfkc' },
  { key: 'gutters', long: '--gutters' },
  { key: 'trailing', long: '--trailing' },
  { key: 'collapse', long: '--collapse' },
]

/** `text` is exactly `-s --punct`, the bar this repository enforces on itself. */
const TEXT_BAR_KEYS: readonly CleanOptionKey[] = ['spaces', 'punct']

/** The option set a bar starts from. */
export function optionsForBar(bar: Bar): CleanOptions {
  if (bar === 'max') return { ...MAX_OPTIONS }
  const options: CleanOptions = { ...DEFAULT_OPTIONS }
  if (bar === 'text') for (const key of TEXT_BAR_KEYS) options[key] = true
  return options
}

/** What a command read off the command line, before any of it is resolved. */
export interface OptionSelection {
  /** `--bar`, already validated. Defaults to `default` when absent. */
  readonly bar?: Bar
  /** `--max`, the alias for the twelve-option set. */
  readonly max?: boolean
  /** Every option flag the user actually typed. */
  readonly explicit: readonly CleanOptionKey[]
}

/**
 * THE RESOLUTION ORDER, fixed and documented so it is always predictable:
 *
 * 1. start from all thirteen off;
 * 2. apply the bar (`default` changes nothing, `text` sets spaces and punct,
 *    `max` sets the twelve);
 * 3. apply `--max` if given (the same twelve; `nfc` stays off because `nfkc`
 *    supersedes it, matching Python's `apply_max()` and its `if/elif` pre-pass);
 * 4. apply each explicit boolean flag, which can only turn an option ON.
 *
 * So `--bar max --punct` is `max`, and `--bar text --collapse` is
 * `-s --punct --collapse`.
 */
export function resolveCleanOptions(selection: OptionSelection): CleanOptions {
  const options = optionsForBar(selection.bar ?? 'default')
  if (selection.max === true) {
    for (const key of CLEAN_OPTION_KEYS) if (MAX_OPTIONS[key]) options[key] = true
  }
  for (const key of selection.explicit) options[key] = true
  return options
}

/**
 * The ON option names, sorted, which is the shape `golden.json` uses for a
 * combo. A combo id and a CLI invocation then describe themselves identically.
 */
export function optionNames(options: CleanOptions): CleanOptionKey[] {
  return CLEAN_OPTION_KEYS.filter((key) => options[key]).sort()
}

/** Anything that can answer "was this flag given, and with what value". */
export interface FlagReader {
  bool(name: string): boolean
  string(name: string): string | undefined
}

/** Every option flag the user typed, in {@link OPTION_FLAGS} order. */
export function explicitOptionKeys(values: FlagReader): CleanOptionKey[] {
  return OPTION_FLAGS.filter((spec) => values.bool(spec.long)).map((spec) => spec.key)
}

/** `--bar` for `clean`, `inspect` and `report`: all three bars are legal. */
export function readBar(values: FlagReader, fallback: Bar = 'default'): Bar {
  const raw = values.string('--bar')
  if (raw === undefined) return fallback
  if (!isBar(raw)) throw new UsageError(strings.errBadBar(raw))
  return raw
}

/** `--bar` for `check`: `default` and `text` only, and the message says why. */
export function readGateBar(values: FlagReader, fallback: GateBar = 'default'): GateBar {
  const raw = values.string('--bar')
  if (raw === undefined) return fallback
  if (!isGateBar(raw)) throw new UsageError(strings.errBadGateBar(raw))
  return raw
}

/** The whole option resolution for a text command, in one call. */
export function readCleanOptions(values: FlagReader, bar: Bar): CleanOptions {
  return resolveCleanOptions({
    bar,
    max: values.bool('--max'),
    explicit: explicitOptionKeys(values),
  })
}
