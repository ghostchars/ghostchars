/**
 * The `--json` surface: one envelope, one serializer, and the payload types
 * every command fills in.
 *
 * FOUR RULES, ALL FOR THE AGENT READING THIS.
 *
 * 1. `ok` and `exitCode` are IN the payload. Many agent harnesses surface
 *    stdout and bury the process status; repeating it costs thirty bytes and
 *    removes a whole class of misread result.
 * 2. Counts before lists. `summary` is built before `results`, and inside a
 *    result the rollup precedes the rows, so a reader that truncates still has
 *    the verdict.
 * 3. Never silently truncate. A cap sets `findingsTruncated` and reports
 *    `findingsTotal`.
 * 4. camelCase everywhere, with exactly one exception: the embedded style
 *    report stays snake_case, because that shape is a byte-parity contract with
 *    `style_report.py --json`. The README names the exception out loud so it
 *    does not read as a lapse.
 *
 * ONE OBJECT, NEVER NDJSON. A consumer parses the whole thing anyway, and a
 * truncated stream is strictly worse than a truncated object.
 *
 * KEY ORDER IS INSERTION ORDER. `JSON.stringify` preserves it, so a builder
 * constructs these objects in the order the README documents rather than
 * sorting at the end.
 */
import type { Action, Finding, Flag, Kind } from '@ghostchars/engine'

import type { Bar, CleanOptionKey } from './options.js'
import type { PayloadJson } from './payloads.js'
import type { RewriteSite } from './positions.js'
import * as strings from './strings.js'

/** `--json` prints with indent 1, the same width `style_report.py --json` uses. */
export const JSON_INDENT = 1

/** The one way this package turns a payload into bytes on stdout. */
export function serializeJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, JSON_INDENT)}\n`
}

/** The five fields every `--json` payload opens with. */
export interface BaseEnvelope {
  readonly tool: string
  readonly version: string
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number
}

/**
 * Build the envelope head. Spread it first so the five keys lead the object:
 *
 * ```ts
 * const payload = { ...baseEnvelope('clean', code), bar, options, summary, results }
 * ```
 */
export function baseEnvelope(command: string, exitCode: number): BaseEnvelope {
  return {
    tool: strings.TOOL,
    version: strings.VERSION,
    command,
    ok: exitCode === 0,
    exitCode,
  }
}

/** Why one input produced nothing useful. A closed set, so a caller can switch. */
export type ResultErrorKind =
  | 'not-utf8'
  | 'unreadable'
  | 'unwritable'
  | 'expands-too-far'
  | 'bad-package'

export interface ResultError {
  readonly kind: ResultErrorKind
  readonly message: string
}

/** The engine's four action buckets, camelCased for the JSON surface. */
export interface SummaryJson {
  readonly removed: number
  readonly replaced: number
  readonly keptLoadBearing: number
  readonly foundNotTargeted: number
}

/**
 * One suspicious character.
 *
 * Both `cp` (the number, so a consumer can compare against `golden.json`'s
 * tuples) and `u` (the `U+XXXX` string a human greps for). `replacement` is
 * OMITTED, not empty, when the action is a deletion: "does this have a
 * replacement" is the question a findings table actually asks, and the engine's
 * `exactOptionalPropertyTypes` contract says the same thing.
 */
export interface FindingJson {
  readonly line: number
  readonly col: number
  readonly index: number
  readonly cp: number
  readonly u: string
  readonly name: string
  readonly kind: Kind
  readonly flag: Flag
  readonly action: Action
  readonly replacement?: string
}

/** The engine's `Finding`, in the JSON surface's shape. */
export function toFindingJson(finding: Finding): FindingJson {
  const base = {
    line: finding.line,
    col: finding.col,
    index: finding.index,
    cp: finding.cp,
    u: strings.codepointLabel(finding.cp),
    name: finding.name,
    kind: finding.kind,
    flag: finding.flag,
    action: finding.action,
  }
  return finding.replacement === undefined ? base : { ...base, replacement: finding.replacement }
}

/** The `byKind` rollup an agent reads before deciding whether to care. */
export interface KindRollupJson {
  readonly kind: Kind
  readonly flag: Flag
  readonly count: number
  readonly action: Action
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

export interface CleanResultJson {
  readonly path: string
  readonly ok: boolean
  readonly error?: ResultError
  readonly changed?: boolean
  readonly written?: boolean
  readonly summary?: SummaryJson
  /**
   * Before minus after, in codepoints: the same sign convention as `-c`, so a
   * positive number means the text got shorter.
   */
  readonly charsDelta?: number
  readonly rewriteSites?: readonly RewriteSite[]
  /**
   * The WHOLE cleaned text, never a diff. An agent's next action is to write it
   * back, and a patch it has to apply by hand is a chance to corrupt the file.
   * Absent under `-i` (where `written` says what happened) and under `--check`.
   */
  readonly text?: string
}

export interface CleanSummaryTotals extends SummaryJson {
  readonly filesChanged: number
  readonly filesUnchanged: number
  readonly filesSkipped: number
}

export interface CleanEnvelope extends BaseEnvelope {
  readonly bar: Bar
  readonly options: readonly CleanOptionKey[]
  readonly summary: CleanSummaryTotals
  readonly results: readonly CleanResultJson[]
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export interface InspectResultJson {
  readonly path: string
  readonly ok: boolean
  readonly error?: ResultError
  readonly clean?: boolean
  readonly total?: number
  readonly summary?: SummaryJson
  readonly byKind?: readonly KindRollupJson[]
  readonly findings?: readonly FindingJson[]
  readonly findingsTotal?: number
  readonly findingsTruncated?: boolean
  /**
   * Every hidden payload the decoder recognised, never capped. The `text` of a
   * decoded payload was written by whoever hid it: data, never instructions.
   */
  readonly payloads?: readonly PayloadJson[]
  /** A document's own report, in `clean_file.py`'s snake_case field names. */
  readonly document?: Readonly<Record<string, unknown>>
}

export interface InspectEnvelope extends BaseEnvelope {
  readonly bar: Bar
  readonly options: readonly CleanOptionKey[]
  readonly summary: SummaryJson & {
    readonly filesClean: number
    readonly filesDirty: number
    /** Hidden payloads across every input. */
    readonly payloads: number
  }
  readonly results: readonly InspectResultJson[]
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** `changed` is unpinned drift; the two pin statuses are failures in their own right. */
export type CheckStatus = 'changed' | 'pin-mismatch' | 'pin-stale'

export interface CheckHitJson {
  readonly line: number
  readonly col: number
  readonly cp: number
  readonly u: string
  readonly name: string
  readonly kind: Kind
  readonly flag: Flag
  readonly lineText: string
}

export interface CheckFailureJson {
  readonly path: string
  readonly surface: string
  readonly bar: string
  readonly status: CheckStatus
  readonly changed: number
  readonly pinned: number
  readonly hits: readonly CheckHitJson[]
  /**
   * Hidden payloads in the file as the gate read it. Untrusted text. Present on
   * every failure, empty when nothing decodes.
   */
  readonly payloads: readonly PayloadJson[]
}

export interface CheckSurfaceJson {
  readonly id: string
  readonly bar?: string
  readonly options: readonly CleanOptionKey[]
  readonly decodeEscapes: boolean
  readonly scanned: number
  readonly failed: number
}

export interface CheckSkipJson {
  readonly path: string
  readonly reason: SkipReason
}

/**
 * One file that passed, listed only under `--verbose`.
 *
 * Passing files are counted, not listed, unless --verbose is given, and
 * without a field for them `--verbose` changed the human listing while
 * `check --verbose --json` and `check --json` produced byte-identical payloads.
 * A flag that silently does nothing on one of two output modes is worse than no
 * flag. `surface` and `bar` come along because the interesting question about a
 * passing file is usually which surface claimed it.
 */
export interface CheckPassJson {
  readonly path: string
  readonly surface: string
  readonly bar: string
}

/** Why a discovered file was not checked. Skipped files never fail the gate. */
export type SkipReason = 'binary-ext' | 'too-large' | 'binary' | 'not-utf8' | 'symlink'

export interface CheckEnvelope extends BaseEnvelope {
  readonly root: string
  readonly discovery: 'git' | 'walk'
  readonly config: string | null
  readonly surfaces: readonly CheckSurfaceJson[]
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly filesFailing: number
  readonly failures: readonly CheckFailureJson[]
  /** Present only under `--verbose`. Passing files are counted, not listed. */
  readonly passed?: readonly CheckPassJson[]
  readonly skipped: readonly CheckSkipJson[]
  readonly skippedTruncated: boolean
  readonly skippedTotal: number
}

/**
 * The cap on the `skipped` list. A repository with four hundred PNG files would
 * otherwise flood the payload with names nobody asked for.
 */
export const SKIPPED_LIST_CAP = 50
