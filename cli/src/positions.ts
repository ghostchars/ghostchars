/**
 * Line and column arithmetic, done in codepoints, and the rewrite-site scan.
 *
 * WHY CODEPOINTS AND NOT `.length`. Python counts a string in codepoints and
 * JavaScript counts it in UTF-16 units, so an emoji or a styled math letter
 * makes the two disagree by one per character. Every number this package prints
 * next to a character (line, column, the `-c` delta, the JSON `charsDelta`) is
 * a codepoint count, because the reference CLI's numbers are and a pin copied
 * from one tool has to mean the same thing in the other.
 *
 * WHY LINES ARE SPLIT ON `\n` ONLY. That is what the engine's `find()` does: it
 * increments the line counter on U+000A and nothing else, so a lone CR or a
 * U+2028 sits inside a line rather than starting one. Any other rule here would
 * put our column numbers a line away from the engine's.
 */
import { formatCodepoint, type CleanOptions } from '@ghostchars/engine'

import { nameOf } from './names.js'
import * as strings from './strings.js'

/** A 1-based position, exactly as the reference CLI prints it. */
export interface Position {
  readonly line: number
  readonly col: number
}

/** How wide a quoted source line may be before it is cut. */
export const CONTEXT_WIDTH = 160

/** The number of codepoints in a string. */
export function cpLength(text: string): number {
  let count = 0
  for (const _character of text) count += 1
  return count
}

/**
 * A source line as it is quoted under a finding: stripped, and cut to
 * {@link CONTEXT_WIDTH} codepoints so one long minified line cannot flood the
 * output.
 *
 * WHY IT DOES NOT SPREAD THE WHOLE LINE. `[...trimmed]` builds one array element
 * per codepoint, which on a 200 KB single-line paragraph is a 200,000 element
 * array thrown away to keep 160 of them. Called once per finding on that line,
 * that alone is quadratic, and it was: with the position arithmetic already
 * fixed, `clean --json` over a 200 KB line of dashes still took 2.9 s at 25,000
 * dashes, 11.1 s at 50,000 and 46.9 s at 100,000. A codepoint is at most two
 * UTF-16 units, so the first {@link CONTEXT_WIDTH} codepoints cannot reach past
 * the first `2 * CONTEXT_WIDTH` units, and slicing there first makes the whole
 * function cost the width rather than the line.
 */
export function contextLine(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= CONTEXT_WIDTH) return trimmed
  const head = trimmed.slice(0, CONTEXT_WIDTH * 2)
  const points = [...head]
  // Fewer codepoints than the width means `head` is already the whole answer:
  // either it is the whole line, or every codepoint in it is a surrogate pair
  // and the cut fell between two of them.
  return points.length <= CONTEXT_WIDTH ? head : points.slice(0, CONTEXT_WIDTH).join('')
}

/**
 * One pass over a text, then O(log lines) per lookup.
 *
 * Built once per file. A command with 400 findings in one file must not walk
 * the text 400 times, and a gate walking a repository must not walk it twice.
 */
export class TextIndex {
  readonly #lines: readonly string[]
  readonly #lineStartUnits: readonly number[]
  /**
   * Per line, the offsets inside it where a surrogate PAIR begins, built the
   * first time that line is asked about and kept. See {@link positionAtUnit}.
   */
  readonly #pairStarts: (readonly number[] | undefined)[]
  /** Per line, its quoted form. See {@link contextAt}. */
  readonly #context: (string | undefined)[]

  constructor(text: string) {
    const lines = text.split('\n')
    const starts: number[] = []
    let unit = 0
    for (const line of lines) {
      starts.push(unit)
      unit += line.length + 1
    }
    this.#lines = lines
    this.#lineStartUnits = starts
    this.#pairStarts = new Array<undefined>(lines.length)
    this.#context = new Array<undefined>(lines.length)
  }

  /** The number of lines, counting a trailing empty one the way `split` does. */
  get lineCount(): number {
    return this.#lines.length
  }

  /** The text of a 1-based line, without its newline. Empty when out of range. */
  lineText(line: number): string {
    return this.#lines[line - 1] ?? ''
  }

  /**
   * The quoted form of a line, built once and kept.
   *
   * `String.prototype.trim` walks the whole line, so calling it once per finding
   * is the same quadratic shape the position arithmetic had. Every finding on a
   * line quotes the same 160 characters, so the answer is computed once.
   */
  contextAt(line: number): string {
    const known = this.#context[line - 1]
    if (known !== undefined) return known
    const built = contextLine(this.lineText(line))
    this.#context[line - 1] = built
    return built
  }

  /**
   * The 1-based line and column of a UTF-16 index, with the column counted in
   * codepoints. Regular expressions report UTF-16 indices, so this is the
   * bridge between a `RegExp` match and a number a person reads.
   *
   * WHY THIS DOES NOT SLICE THE LINE. It used to: `lineText(line).slice(0, n)`
   * followed by `cpLength(prefix)`, which is O(n) per call. One long paragraph
   * with many dashes on it then made {@link rewriteSites} O(text^2), and that is
   * not a theoretical shape. MEASURED before this change, on a single 200,000
   * character line of `a` plus U+2014 repeated: `clean_text` at the MCP server's
   * default bar took 84,997 ms and blocked every other request on the connection
   * for the whole of it, against 40 ms with `punct` off. The curve was clean
   * quadratic: 10,000 dashes 877 ms, 50,000 dashes 21,725 ms, 100,000 dashes
   * 81,836 ms.
   *
   * WHAT IT DOES INSTEAD. A column in codepoints differs from a column in UTF-16
   * units by exactly the number of surrogate PAIRS that fit entirely inside the
   * prefix, because `for...of` yields a well-formed pair as one character and a
   * lone surrogate as one character. So each line records the offsets where a
   * pair begins, once, the first time that line is asked about, and every later
   * lookup is a binary search over that list. A line with no astral character at
   * all, which is nearly every line, records an empty list and answers in
   * constant time forever after. Same numbers, one pass instead of one per hit.
   */
  positionAtUnit(unitIndex: number): Position {
    const line = this.#lineOf(unitIndex)
    const start = this.#lineStartUnits[line - 1] ?? 0
    const units = Math.max(0, unitIndex - start)
    const pairs = this.#pairStartsIn(line)
    if (pairs.length === 0) return { line, col: units + 1 }
    // A pair starting at `units - 1` is cut in half by the prefix, and the lone
    // high surrogate left behind counts as one character, so only pairs that end
    // at or before `units` are subtracted.
    return { line, col: units - countAtOrBelow(pairs, units - 2) + 1 }
  }

  /** Where the surrogate pairs on a line start. Built once, then reused. */
  #pairStartsIn(line: number): readonly number[] {
    const known = this.#pairStarts[line - 1]
    if (known !== undefined) return known
    const text = this.lineText(line)
    const found: number[] = []
    for (let i = 0; i < text.length; i += 1) {
      const unit = text.charCodeAt(i)
      if (unit < 0xd800 || unit > 0xdbff) continue
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        found.push(i)
        i += 1
      }
    }
    this.#pairStarts[line - 1] = found
    return found
  }

  #lineOf(unitIndex: number): number {
    let low = 0
    let high = this.#lineStartUnits.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((this.#lineStartUnits[middle] ?? 0) <= unitIndex) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

/** How many entries of a sorted list are at most `limit`. Binary search. */
function countAtOrBelow(sorted: readonly number[], limit: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] ?? 0) <= limit) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The dashes `--punct` rewrites to `" - "`, and the shape of the match.
 *
 * WHY THIS REGEX IS COPIED RATHER THAN IMPORTED. It is `DASH_RE` from
 * `web/src/engine/tables.ts`, character for character, including the Python
 * space class the lookarounds are built from. `tables.ts` is not one of the six
 * modules the engine exposes through the package's `paths` aliases, and adding
 * a seventh alias for one constant would widen the CLI's coupling to the
 * engine's internals for no gain. If the engine's rule ever changes, this
 * comment is the pointer to the other copy.
 */
const PY_SPACE_CLASS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_NON_SPACE = `[^${PY_SPACE_CLASS}]`
const DASH_SITE_RE = new RegExp(
  `(?<=${PY_NON_SPACE})[ \\t]*[\\u2013\\u2014\\u2015][ \\t]*(?=${PY_NON_SPACE})`,
  'gu',
)

const DASH_CODEPOINTS = new Set([0x2013, 0x2014, 0x2015])

/**
 * A place where the mechanical clean is right and the result still reads badly.
 *
 * Nothing else in this ecosystem reports these. A cleaner turns an em dash
 * between two words into a space, a hyphen and a space; that is a faithful
 * substitution and a worse sentence. These are the positions where the answer
 * is to rewrite, and `hint` says so.
 */
export interface RewriteSite {
  readonly line: number
  readonly col: number
  readonly cp: number
  /** `U+2014`, for a person grepping the output. */
  readonly u: string
  readonly name: string
  /** The source line the dash sits on, stripped and cut. */
  readonly before: string
  readonly hint: string
}

/** A capped list of rewrite sites, with the number there would have been. */
export interface RewriteSiteList {
  readonly sites: readonly RewriteSite[]
  /** How many sites the text holds, whether or not they were all built. */
  readonly total: number
}

/**
 * Every dash `--punct` would rewrite, located in the ORIGINAL text.
 *
 * Emitted only when the resolved options include `punct`: with the option off
 * nothing would be rewritten, and reporting a site the run did not touch would
 * be a lie about what happened. Curly quotes, ellipses and no-break spaces
 * flatten correctly and are deliberately not listed.
 *
 * WHY THERE IS A LIMIT AND WHY IT RETURNS A TOTAL. The list is one record per
 * dash, each carrying a quoted source line, so a 200 KB paragraph of dashes
 * built a 23 MB response for a caller who wanted to know where to rewrite. The
 * limit caps what is BUILT, not what is counted: scanning to the end is one
 * linear pass and the count is the number the caller needs in order to know the
 * list was cut. Nothing here is silently truncated.
 */
export function rewriteSites(
  text: string,
  options: CleanOptions,
  index: TextIndex = new TextIndex(text),
  limit: number = Number.POSITIVE_INFINITY,
): RewriteSiteList {
  if (!options.punct) return { sites: [], total: 0 }
  const sites: RewriteSite[] = []
  let total = 0
  DASH_SITE_RE.lastIndex = 0
  for (const match of text.matchAll(DASH_SITE_RE)) {
    const start = match.index
    const dashOffset = findDash(match[0])
    if (dashOffset < 0) continue
    const unit = start + dashOffset
    const cp = text.codePointAt(unit)
    if (cp === undefined) continue
    total += 1
    if (sites.length >= limit) continue
    const position = index.positionAtUnit(unit)
    sites.push({
      line: position.line,
      col: position.col,
      cp,
      u: formatCodepoint(cp),
      name: nameOf(cp),
      before: index.contextAt(position.line),
      hint: strings.REWRITE_HINT,
    })
  }
  return { sites, total }
}

/** The offset of the dash inside a match that may carry spaces on either side. */
function findDash(matched: string): number {
  for (let i = 0; i < matched.length; i += 1) {
    const cp = matched.codePointAt(i)
    if (cp !== undefined && DASH_CODEPOINTS.has(cp)) return i
  }
  return -1
}
