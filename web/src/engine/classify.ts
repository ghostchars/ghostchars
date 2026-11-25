/**
 * `strip_invisible.classify()`, transliterated.
 *
 * One codepoint in, a {@link Classification} or `null` out. The order of the
 * branches is load-bearing and matches the Python line for line: `ALWAYS_STRIP`
 * beats the `Cf` catch-all (that is how noncharacters and the deprecated format
 * controls get caught), the orthographic Arabic controls are excused *before*
 * the catch-all, and the glue branch runs before either so that a variation
 * selector is judged by its neighbour rather than by its category.
 *
 * The text arrives as an array of **codepoints**, never a UTF-16 string. Python
 * indexes strings by codepoint, so a JavaScript port that walked `text[i]` would
 * see an astral emoji as two surrogates and mis-locate every finding after it.
 */
import {
  ALWAYS_STRIP_RANGES,
  BIDI_ALWAYS_RANGES,
  BIDI_MARK_RANGES,
  BLACK_FLAG,
  CONTROL_RANGES,
  FLAG_TAG_RANGE,
  GLUE_RANGES,
  GUTTER_RANGES,
  HANGUL_FILLER_RANGES,
  KHMER_VOWEL_RANGES,
  EGYPTIAN_CF_RANGES,
  DUPLOYAN_CF_RANGES,
  LINE_BREAK_RANGES,
  MONGOLIAN_FVS_RANGES,
  ORTHOGRAPHIC_CF_RANGES,
  PUNCT,
  SPACE_RANGES,
  TAG_CHAR_RANGES,
  TAG_END,
  VS_EMOJI_RANGES,
  VS_SUPPLEMENT_RANGES,
  VS_TEXT_RANGES,
  WORD_BOUNDARY_RANGES,
  ZWJ,
  ZWNJ,
  inRanges,
  isAsciiAlnum,
  isCjk,
  isEmojiBase,
  isFormatControl,
  isHangulJamo,
  isLetterIn,
  isPrivateUse,
  isRtl,
  joiningScript,
} from './tables'
import { CONFUSABLES } from './confusables'
import type { Classification } from './types'

/**
 * Split a string into codepoints: the array every function here walks.
 *
 * `Array.from(text)` gives the same iteration, but of one-character strings;
 * this returns the numbers directly, and it does so without the `?? 0` fallback
 * a `codePointAt` on each element would need. A lone surrogate round-trips
 * through `String.fromCodePoint` unchanged, so nothing is lost on malformed
 * input either.
 */
export function toCodePoints(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined) out.push(cp)
  }
  return out
}

/** The last codepoint of a string, or `null` when it is empty. */
export function lastCodePoint(text: string): number | null {
  let last: number | null = null
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined) last = cp
  }
  return last
}

/**
 * `valid_flag_tag_indices`: the codepoint indices that sit inside a *complete*
 * subdivision-flag sequence: U+1F3F4, one or more tag characters in
 * U+E0020..U+E007E, then CANCEL TAG.
 *
 * A Scotland flag is such a sequence and survives by default. A lone
 * `U+1F3F4 U+E0067` (ASCII smuggling, or a truncated flag) is not, and its tag
 * characters are stripped.
 */
export function validFlagTagIndices(cps: readonly number[]): ReadonlySet<number> {
  const [tagLo, tagHi] = FLAG_TAG_RANGE
  const valid = new Set<number>()
  let i = 0
  while (i < cps.length) {
    if (cps[i] !== BLACK_FLAG) {
      i += 1
      continue
    }
    let j = i + 1
    while (j < cps.length) {
      const cp = cps[j]
      if (cp === undefined || cp < tagLo || cp > tagHi) break
      j += 1
    }
    if (j > i + 1 && j < cps.length && cps[j] === TAG_END) {
      for (let k = i + 1; k <= j; k += 1) valid.add(k)
      i = j + 1
    } else {
      i += 1
    }
  }
  return valid
}

/**
 * Is the glue at `cp` doing real work?
 *
 * Mirrors the Python's `if / if-elif` shape exactly, including the wrinkle that
 * the ZWJ/ZWNJ test is a second `if` rather than an `elif`: a ZWJ that already
 * bound to an emoji pair skips the joining-script test *and* the whole `elif`
 * chain below it, so nothing can un-bind it.
 */
function isGlueBound(
  cp: number,
  prev: number | null,
  nxt: number | null,
  prevKept: number | null,
  index: number,
  flagTags: ReadonlySet<number>,
): boolean {
  let bound = false
  if (cp === ZWJ) {
    bound = prevKept !== null && nxt !== null && isEmojiBase(prevKept) && isEmojiBase(nxt)
  }
  if ((cp === ZWJ || cp === ZWNJ) && !bound) {
    const before = prev !== null ? joiningScript(prev) : null
    const after = nxt !== null ? joiningScript(nxt) : null
    bound = prev !== null && nxt !== null && before !== null && before === after
  } else if (inRanges(cp, VS_EMOJI_RANGES)) {
    bound = prev !== null && isEmojiBase(prev)
  } else if (inRanges(cp, VS_TEXT_RANGES) || inRanges(cp, VS_SUPPLEMENT_RANGES)) {
    bound = prev !== null && isCjk(prev)
  } else if (inRanges(cp, MONGOLIAN_FVS_RANGES)) {
    bound = prevKept !== null && isLetterIn(prevKept, 'mongolian')
  } else if (inRanges(cp, KHMER_VOWEL_RANGES)) {
    bound = prevKept !== null && isLetterIn(prevKept, 'khmer')
  } else if (inRanges(cp, HANGUL_FILLER_RANGES)) {
    bound = prevKept !== null && isHangulJamo(prevKept)
  } else if (inRanges(cp, EGYPTIAN_CF_RANGES)) {
    bound = prevKept !== null && isLetterIn(prevKept, 'egyptian')
  } else if (inRanges(cp, DUPLOYAN_CF_RANGES)) {
    bound = prevKept !== null && isLetterIn(prevKept, 'duployan')
  } else if (inRanges(cp, TAG_CHAR_RANGES)) {
    bound = flagTags.has(index)
  }
  return bound
}

/**
 * `in_mixed_script_word`: does the word around `index` also contain an ASCII
 * letter or digit? A Cyrillic а inside "аpple" or "Miсrosoft" is a look-alike;
 * the same letter inside "Рецепт" is just Russian. Only the former is a finding.
 */
export function inMixedScriptWord(cps: readonly number[], index: number): boolean {
  for (let j = index - 1; j >= 0; j -= 1) {
    const c = cps[j]
    if (c === undefined || inRanges(c, WORD_BOUNDARY_RANGES)) break
    if (isAsciiAlnum(c)) return true
  }
  for (let j = index + 1; j < cps.length; j += 1) {
    const c = cps[j]
    if (c === undefined || inRanges(c, WORD_BOUNDARY_RANGES)) break
    if (isAsciiAlnum(c)) return true
  }
  return false
}

/**
 * `mixed_script_words`: `inMixedScriptWord(cps, i)` for every index `i`, in
 * linear time.
 *
 * Asking `inMixedScriptWord` of each confusable rescans its word every time, so
 * a long word of look-alikes costs the square of its length. Two passes give
 * every answer at once. `right[k]` says an ASCII letter or digit sits in
 * `cps[k..]` before the first word boundary; the forward pass carries the same
 * fact about `cps[..i]`, read back from the nearest boundary. A boundary resets
 * both, so index `i` sees exactly the run the per-index scan walks: left of `i`
 * and right of `i`, each stopping at a boundary, never counting `i` itself.
 */
export function mixedScriptWords(cps: readonly number[]): boolean[] {
  const n = cps.length
  const right = new Uint8Array(n + 1)
  for (let k = n - 1; k >= 0; k -= 1) {
    const c = cps[k] ?? 0
    right[k] = !inRanges(c, WORD_BOUNDARY_RANGES) && (right[k + 1] === 1 || isAsciiAlnum(c)) ? 1 : 0
  }
  const mixed: boolean[] = new Array<boolean>(n)
  let left = false
  for (let k = 0; k < n; k += 1) {
    mixed[k] = left || right[k + 1] === 1
    const c = cps[k] ?? 0
    left = !inRanges(c, WORD_BOUNDARY_RANGES) && (left || isAsciiAlnum(c))
  }
  return mixed
}

const LINE_FEED = 0x0a
const SPACE = 0x20
const TAB = 0x09

/**
 * `is_gutter`: is the bar at `index` a terminal quote gutter?
 *
 * The test `GUTTER_RE` makes, asked of one index so the classifier can report
 * the bar at its position in the caller's text: only spaces and tabs between
 * the bar and the start of its line, and no second copy of the same glyph
 * between the bar and the next LF.
 */
export function isGutter(cps: readonly number[], index: number): boolean {
  const cp = cps[index]
  let j = index - 1
  while (j >= 0 && (cps[j] === SPACE || cps[j] === TAB)) j -= 1
  if (j >= 0 && cps[j] !== LINE_FEED) return false
  for (let k = index + 1; k < cps.length; k += 1) {
    const c = cps[k]
    if (c === LINE_FEED) break
    if (c === cp) return false
  }
  return true
}

/**
 * Classify the codepoint at `index`, or return `null` for ordinary text.
 *
 * `prevKept` is the last codepoint that survived the cleaner and was *not*
 * glue: the emoji or letter a run of invisible characters is hanging off.
 * `prev` / `next` are the raw neighbours regardless of whether they survived,
 * which is why a variation selector after a doomed character is still judged
 * against it.
 *
 * `mixed` is `mixedScriptWords(cps)`, which a caller walking the whole text
 * passes so a long word of look-alikes stays linear. Without it the one index
 * is answered by `inMixedScriptWord`, with the same result.
 */
export function classify(
  cps: readonly number[],
  index: number,
  prevKept: number | null,
  flagTags: ReadonlySet<number>,
  mixed?: readonly boolean[],
): Classification | null {
  const cp = cps[index]
  if (cp === undefined) return null
  const prev = index > 0 ? (cps[index - 1] ?? null) : null
  const nxt = index + 1 < cps.length ? (cps[index + 1] ?? null) : null

  if (inRanges(cp, ALWAYS_STRIP_RANGES)) return { kind: 'invisible', flag: 'default', replacement: '' }
  if (inRanges(cp, BIDI_ALWAYS_RANGES)) return { kind: 'bidi-override', flag: 'default', replacement: '' }
  if (inRanges(cp, BIDI_MARK_RANGES)) {
    const nearRtl = (prev !== null && isRtl(prev)) || (nxt !== null && isRtl(nxt))
    return { kind: 'bidi-mark', flag: nearRtl ? '--bidi' : 'default', replacement: '' }
  }

  if (inRanges(cp, GLUE_RANGES)) {
    const bound = isGlueBound(cp, prev, nxt, prevKept, index, flagTags)
    return { kind: 'glue', flag: bound ? '-a' : 'default', replacement: '' }
  }

  if (inRanges(cp, ORTHOGRAPHIC_CF_RANGES)) return null
  if (isFormatControl(cp)) return { kind: 'format-control', flag: 'default', replacement: '' }
  if (isPrivateUse(cp)) return { kind: 'private-use', flag: '--pua', replacement: '' }
  if (inRanges(cp, SPACE_RANGES)) return { kind: 'space', flag: '-s', replacement: ' ' }
  if (inRanges(cp, LINE_BREAK_RANGES)) return { kind: 'line-break', flag: '-n', replacement: '\n' }
  if (inRanges(cp, CONTROL_RANGES)) return { kind: 'control', flag: '--controls', replacement: '' }

  const punct = PUNCT.get(cp)
  if (punct !== undefined) return { kind: 'punct', flag: '--punct', replacement: punct }

  if (inRanges(cp, GUTTER_RANGES) && isGutter(cps, index)) {
    return { kind: 'gutter', flag: '--gutters', replacement: '' }
  }

  const confusable = CONFUSABLES.get(cp)
  if (confusable !== undefined && (mixed ? mixed[index] === true : inMixedScriptWord(cps, index))) {
    return { kind: 'confusable', flag: '--confusables', replacement: confusable }
  }

  return null
}
