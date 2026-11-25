/**
 * The engine's public vocabulary.
 *
 * Every domain value is an `as const` tuple with a derived union type, so there
 * are no loose strings anywhere downstream: a `Kind` badge, a `Flag` toggle and
 * an `Action` tile all render from these registries.
 *
 * The names mirror `strip_invisible.py` one-for-one: `Flag` is literally the
 * CLI option that has to be on for a finding to be acted on, and `"default"` is
 * the pseudo-flag that is always on. Keeping the CLI spelling means the golden
 * fixtures, the CLI's `--show` output and this API all say the same words.
 */

/** CLI option that must be enabled before a finding is acted on. */
export const FLAGS = [
  'default',
  '-a',
  '-s',
  '-n',
  '--bidi',
  '--controls',
  '--pua',
  '--punct',
  '--confusables',
  '--gutters',
] as const

export type Flag = (typeof FLAGS)[number]

/** What a suspicious codepoint *is*: the label the CLI prints under `--show`. */
export const KINDS = [
  'invisible',
  'bidi-override',
  'bidi-mark',
  'glue',
  'format-control',
  'private-use',
  'space',
  'line-break',
  'control',
  'punct',
  'confusable',
  'gutter',
] as const

export type Kind = (typeof KINDS)[number]

/**
 * What the current option set does about a finding.
 *
 * - `removed` / `replaced`: the finding's flag is on; it is deleted, or
 *   substituted with {@link Finding.replacement}.
 * - `kept-load-bearing`: glue or a bidi mark that is doing real work (a ZWJ
 *   inside a family emoji, an RLM next to Hebrew). Reported, deliberately kept,
 *   only removable with `-a` / `--bidi`.
 * - `found-not-targeted`: any other finding whose flag is off.
 */
export const ACTIONS = ['removed', 'replaced', 'kept-load-bearing', 'found-not-targeted'] as const

export type Action = (typeof ACTIONS)[number]

/**
 * The cleaning switches, in the order `strip_invisible.py` documents them.
 *
 * The first eight have a matching {@link Flag} and gate the per-character
 * classifier. The last five (`nfc`, `nfkc`, `gutters`, `trailing`,
 * `collapse`) are whole-text pre-passes that run before classification.
 * Four of them never produce findings of their own. `gutters` is the
 * exception: the pre-pass removes a terminal quote bar, and the classifier
 * reports that same bar as a `gutter` finding under `--gutters`, so what was
 * removed is still on the record.
 */
export const CLEAN_OPTION_KEYS = [
  'aggressive',
  'spaces',
  'newlines',
  'bidi',
  'controls',
  'pua',
  'punct',
  'confusables',
  'nfc',
  'nfkc',
  'gutters',
  'trailing',
  'collapse',
] as const

export type CleanOptionKey = (typeof CLEAN_OPTION_KEYS)[number]

/**
 * All thirteen switches, none optional. Mutable on purpose: the UI builds the
 * next option set with `{ ...options }` and assigns one key. Nothing in the
 * engine ever mutates a caller's object.
 */
export type CleanOptions = { [K in CleanOptionKey]: boolean }

/** A suspicious codepoint, located in the text the caller passed in. */
export interface Finding {
  /** 0-based index **in codepoints**, not UTF-16 units. */
  readonly index: number
  /** 1-based, counted in codepoints, exactly like the CLI prints it. */
  readonly line: number
  /** 1-based, counted in codepoints, exactly like the CLI prints it. */
  readonly col: number
  readonly cp: number
  /** Unicode name, or `U+XXXX` for the codepoints that have none. */
  readonly name: string
  readonly kind: Kind
  /** The option that has to be on for this finding to be acted on. */
  readonly flag: Flag
  readonly action: Action
  /** Present only when the character is substituted rather than deleted. */
  readonly replacement?: string
}

export interface CleanSummary {
  readonly removed: number
  readonly replaced: number
  readonly keptLoadBearing: number
  readonly foundNotTargeted: number
}

export interface CleanResult {
  readonly text: string
  readonly findings: readonly Finding[]
  readonly summary: CleanSummary
}

/** What {@link classify} returns for a suspicious codepoint. */
export interface Classification {
  readonly kind: Kind
  readonly flag: Flag
  /** Substitution text; `''` means delete. */
  readonly replacement: string
}
