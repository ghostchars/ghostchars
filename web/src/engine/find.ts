/**
 * `strip_invisible.find()`: every suspicious codepoint, in order, located.
 *
 * The Python returns `(line, col, cp, kind, flag)` tuples; the golden fixtures
 * record exactly those five fields, and {@link scan} reproduces them. `find()`
 * adds the two things a UI needs and a CLI does not: the Unicode name, and the
 * {@link Action} the *current* option set would take: with no options on, which
 * is what the reveal-only view shows.
 *
 * `find` is flag-independent by construction. `prev_kept` advances on every
 * non-glue character whether or not that character would have survived a clean,
 * so the same text always yields the same findings: a property the fixtures
 * rely on (findings are recorded once per fixture, `cleaned` once per combo).
 */
import { classify, mixedScriptWords, toCodePoints, validFlagTagIndices } from './classify'
import { isGlue } from './tables'
import { nameOf } from './unicode-names'
import type { Action, Finding, Flag, Kind } from './types'

const LINE_FEED = 0x0a

/** The raw five-tuple the Python's `find()` yields, plus the codepoint index. */
export interface ScanHit {
  readonly index: number
  readonly line: number
  readonly col: number
  readonly cp: number
  readonly kind: Kind
  readonly flag: Flag
  readonly replacement: string
}

/** The flag set a bare `find()` runs under: nothing but the always-on pseudo-flag. */
export const DEFAULT_ENABLED_FLAGS: ReadonlySet<Flag> = new Set<Flag>(['default'])

/**
 * Walk the text once, classifying as we go.
 *
 * Line and column are 1-based and counted in **codepoints**, exactly like the
 * CLI's `--show` output: an astral emoji advances the column by one, not two.
 */
export function scan(cps: readonly number[]): ScanHit[] {
  const flagTags = validFlagTagIndices(cps)
  const mixed = mixedScriptWords(cps)
  const hits: ScanHit[] = []
  let prevKept: number | null = null
  let line = 1
  let col = 1
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i]
    if (cp === undefined) continue
    const hit = classify(cps, i, prevKept, flagTags, mixed)
    if (hit !== null) {
      hits.push({ index: i, line, col, cp, kind: hit.kind, flag: hit.flag, replacement: hit.replacement })
    }
    if (!isGlue(cp)) prevKept = cp
    if (cp === LINE_FEED) {
      line += 1
      col = 1
    } else {
      col += 1
    }
  }
  return hits
}

/**
 * What the enabled options do about a finding.
 *
 * Flag on: the character is substituted, or deleted when the replacement is
 * empty. Flag off: glue and bidi marks that were judged load-bearing get their
 * own tile, because "we found this and deliberately left it" is a different
 * statement from "this needs a flag you have not turned on".
 */
export function actionFor(hit: ScanHit, enabled: ReadonlySet<Flag>): Action {
  if (enabled.has(hit.flag)) return hit.replacement === '' ? 'removed' : 'replaced'
  if (hit.kind === 'glue' && hit.flag === '-a') return 'kept-load-bearing'
  if (hit.kind === 'bidi-mark' && hit.flag === '--bidi') return 'kept-load-bearing'
  return 'found-not-targeted'
}

/** Turn a raw hit into the public {@link Finding}, given the enabled flag set. */
export function toFinding(hit: ScanHit, enabled: ReadonlySet<Flag>): Finding {
  const base = {
    index: hit.index,
    line: hit.line,
    col: hit.col,
    cp: hit.cp,
    name: nameOf(hit.cp),
    kind: hit.kind,
    flag: hit.flag,
    action: actionFor(hit, enabled),
  }
  // `replacement` is omitted rather than set to `''` for deletions:
  // `exactOptionalPropertyTypes` makes the difference observable, and
  // "there is a replacement" is exactly the question the findings table asks.
  return hit.replacement === '' ? base : { ...base, replacement: hit.replacement }
}

/**
 * Every suspicious codepoint in `text`, with actions derived under the default
 * option set (nothing enabled but `default`).
 */
export function find(text: string): Finding[] {
  return scan(toCodePoints(text)).map((hit) => toFinding(hit, DEFAULT_ENABLED_FLAGS))
}
