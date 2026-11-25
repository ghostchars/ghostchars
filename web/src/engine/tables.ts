/**
 * Every table `strip_invisible.py` consults, transliterated to TypeScript.
 *
 * Two kinds of data live here:
 *
 * 1. **The literal tables from the Python**: `ALWAYS_STRIP`, `BIDI_*`, the glue
 *    sets, `SPACES`, `CONTROLS`, `LINE_BREAKS`, `PUNCT`, `ORTHOGRAPHIC_CF`, `GUTTERS` and
 *    the four pre-pass regexes. Python's `set` literals are re-expressed as
 *    sorted `[lo, hi]` range tables; the parity test proves the membership is
 *    identical for every codepoint the fixtures touch, and
 *    `__tests__/engine.test.ts` re-derives the counts.
 * 2. **Unicode character-database extracts**: JavaScript has no `unicodedata`,
 *    so the three property lookups `classify()` makes (`category()`,
 *    `bidirectional()`, and the `category[0] in "LM"` / `== "L"` tests inside
 *    `joining_script()` / `is_letter_in()`) travel as data. They are generated
 *    from the same UCD version the golden fixtures were built against,
 *    **Unicode 16.0.0**: by `tools/gen_unicode_tables.py`. If that version ever
 *    moves, regenerate this file and `golden.json` together;
 *    `python3 tools/gen_unicode_tables.py --check` is a CI gate that fails if
 *    they have drifted apart.
 *
 * Ranges are always sorted and non-overlapping so {@link inRanges} can binary
 * search. Everything is pure data plus pure predicates: no imports, no state.
 */

/** Inclusive codepoint range, `[lo, hi]`. */
export type Range = readonly [number, number]

/**
 * Membership test over a sorted, non-overlapping range table.
 *
 * Binary search rather than a `Set`, because the biggest tables (`RTL_RANGES`,
 * the Indic letter table) cover tens of thousands of codepoints and would cost
 * an unreasonable amount of memory as sets in a browser tab.
 */
export function inRanges(cp: number, ranges: readonly Range[]): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = ranges[mid]
    if (range === undefined) return false
    if (cp < range[0]) hi = mid - 1
    else if (cp > range[1]) lo = mid + 1
    else return true
  }
  return false
}

// --------------------------------------------------------------- literal ----

/**
 * Format controls that are contraband anywhere in prose: `ALWAYS_STRIP`.
 *
 * The tail is the noncharacter block plus the two noncharacters at the top of
 * each of the seventeen planes, and the reserved Default_Ignorable_Code_Point
 * ranges (U+2065, U+FFF0..U+FFF8, U+E0080..U+E00FF, U+E01F0..U+E0FFF). All of
 * them are unassigned (`Cn`) yet renderers already hide the ignorables, so the
 * `Cf` catch-all in `classify` would miss them.
 */
export const ALWAYS_STRIP_RANGES: readonly Range[] = [
  [0x00AD, 0x00AD], // soft hyphen
  [0x034F, 0x034F], // combining grapheme joiner
  [0x180E, 0x180E], // mongolian vowel separator
  [0x200B, 0x200B], // zero width space
  [0x2060, 0x2065], // word joiner, the invisible math operators, reserved U+2065
  [0x206A, 0x206F], // deprecated format controls
  [0x2800, 0x2800], // braille pattern blank
  [0x3164, 0x3164], // hangul filler
  [0xFDD0, 0xFDEF], // noncharacters
  [0xFEFF, 0xFEFF], // zero width no-break space / BOM
  [0xFFA0, 0xFFA0], // halfwidth hangul filler
  [0xFFF0, 0xFFF8], // reserved default-ignorables
  [0xFFF9, 0xFFFB], // interlinear annotation
  [0xFFFE, 0xFFFF],
  [0x1D173, 0x1D17A], // musical symbol format controls
  [0x1FFFE, 0x1FFFF],
  [0x2FFFE, 0x2FFFF],
  [0x3FFFE, 0x3FFFF],
  [0x4FFFE, 0x4FFFF],
  [0x5FFFE, 0x5FFFF],
  [0x6FFFE, 0x6FFFF],
  [0x7FFFE, 0x7FFFF],
  [0x8FFFE, 0x8FFFF],
  [0x9FFFE, 0x9FFFF],
  [0xAFFFE, 0xAFFFF],
  [0xBFFFE, 0xBFFFF],
  [0xCFFFE, 0xCFFFF],
  [0xDFFFE, 0xDFFFF],
  [0xE0080, 0xE00FF], // reserved default-ignorables (tag block tail)
  [0xE01F0, 0xE0FFF], // reserved default-ignorables (after the VS supplement)
  [0xEFFFE, 0xEFFFF],
  [0xFFFFE, 0xFFFFF],
  [0x10FFFE, 0x10FFFF],
]

/** Bidi overrides and embeddings: they reorder unrelated text, so never legitimate. */
export const BIDI_ALWAYS_RANGES: readonly Range[] = [[0x202A, 0x202E]]

/** LRM/RLM/ALM and the isolates: legitimate next to RTL text, kept unless `--bidi`. */
export const BIDI_MARK_RANGES: readonly Range[] = [
  [0x061C, 0x061C],
  [0x200E, 0x200F],
  [0x2066, 0x2069],
]

export const ZWNJ = 0x200C
export const ZWJ = 0x200D
export const TAG_END = 0xE007F
export const BLACK_FLAG = 0x1F3F4

/** Emoji-presentation and text-presentation variation selectors, `VS_EMOJI`. */
export const VS_EMOJI_RANGES: readonly Range[] = [[0xFE0E, 0xFE0F]]
/** `VS_TEXT`: VS1..VS14. */
export const VS_TEXT_RANGES: readonly Range[] = [[0xFE00, 0xFE0D]]
/** `VS_SUPPLEMENT`: VS17..VS256, the Ideographic Variation Sequence selectors. */
export const VS_SUPPLEMENT_RANGES: readonly Range[] = [[0xE0100, 0xE01EF]]
export const MONGOLIAN_FVS_RANGES: readonly Range[] = [[0x180B, 0x180D]]
export const KHMER_VOWEL_RANGES: readonly Range[] = [[0x17B4, 0x17B5]]
export const HANGUL_FILLER_RANGES: readonly Range[] = [[0x115F, 0x1160]]
/**
 * `SCRIPT_CF`: script-specific format controls: quadrat layout in Egyptian
 * hieroglyphs, affix/overlap controls in Duployan. Bound after a letter of
 * their own script ({@link isLetterIn}), contraband anywhere else.
 */
export const EGYPTIAN_CF_RANGES: readonly Range[] = [[0x13430, 0x1343F]]
export const DUPLOYAN_CF_RANGES: readonly Range[] = [[0x1BCA0, 0x1BCA3]]
export const TAG_CHAR_RANGES: readonly Range[] = [[0xE0000, 0xE007F]]

/**
 * TAG SPACE .. TAG TILDE: the tag characters that may appear *inside* a
 * subdivision-flag sequence. The wider {@link TAG_CHAR_RANGES} also covers the
 * unassigned head of the block and CANCEL TAG, neither of which may.
 */
export const FLAG_TAG_RANGE: Range = [0xE0020, 0xE007E]

/**
 * `GLUE`: invisible, but load-bearing when it sits next to the right base.
 *
 * The union of ZWJ/ZWNJ, every variation selector, the Mongolian free variation
 * selectors, the Khmer inherent vowels, the Hangul fillers, the tag block and
 * the Egyptian/Duployan script format controls.
 * Merged into one sorted table because the hot loop asks `is this glue?` once
 * per codepoint: glue does not advance the "previous kept base" cursor.
 */
export const GLUE_RANGES: readonly Range[] = [
  [0x115F, 0x1160],
  [0x17B4, 0x17B5],
  [0x180B, 0x180D],
  [0x200C, 0x200D],
  [0xFE00, 0xFE0F],
  [0x13430, 0x1343F],
  [0x1BCA0, 0x1BCA3],
  [0xE0000, 0xE007F],
  [0xE0100, 0xE01EF],
]

/** Format controls that are ordinary Arabic/Syriac/Kaithi orthography. */
export const ORTHOGRAPHIC_CF_RANGES: readonly Range[] = [
  [0x0600, 0x0605],
  [0x06DD, 0x06DD],
  [0x070F, 0x070F],
  [0x08E2, 0x08E2],
  [0x110BD, 0x110BD],
  [0x110CD, 0x110CD],
]

/** Visible-ish spaces: collapsed to U+0020 rather than deleted. */
export const SPACE_RANGES: readonly Range[] = [
  [0x00A0, 0x00A0],
  [0x1680, 0x1680],
  [0x2000, 0x200A],
  [0x202F, 0x202F],
  [0x205F, 0x205F],
  [0x3000, 0x3000],
]

/**
 * C0/C1 controls, excluding tab, LF, CR and NEL.
 *
 * Tab and LF are legitimate text; CR is handled by the `-n` pre-pass; NEL
 * (U+0085) is a line break, so it lives in {@link LINE_BREAK_RANGES} instead.
 */
export const CONTROL_RANGES: readonly Range[] = [
  [0x0000, 0x0008],
  [0x000B, 0x000C],
  [0x000E, 0x001F],
  [0x007F, 0x0084],
  [0x0086, 0x009F],
]

/** Line breaks folded to LF by `-n`. CR/CRLF are handled by a pre-pass. */
/**
 * `WORD_BOUNDARY`: the look-alike rule's notion of a word edge: whitespace,
 * ASCII punctuation and the common punctuation blocks. Hand-maintained in
 * lock-step with the Python (NOT a General_Category table, on purpose: both
 * engines carry the identical list). Invisible/format characters are neither
 * boundary nor letter, the scan steps over them, so a ZWSP wedged into
 * "аpple" cannot hide the look-alike.
 */
export const WORD_BOUNDARY_RANGES: readonly Range[] = [
  [0x0009, 0x000D],
  [0x0020, 0x002F],
  [0x003A, 0x0040],
  [0x005B, 0x0060],
  [0x007B, 0x007E],
  [0x0085, 0x0085],
  [0x00A0, 0x00A1],
  [0x00A7, 0x00A7],
  [0x00AB, 0x00AB],
  [0x00B6, 0x00B7],
  [0x00BB, 0x00BB],
  [0x00BF, 0x00BF],
  [0x1680, 0x1680],
  [0x2000, 0x200A],
  [0x2010, 0x2027],
  [0x2028, 0x2029],
  [0x202F, 0x202F],
  [0x2030, 0x205E],
  [0x205F, 0x205F],
  [0x2E00, 0x2E7F],
  [0x3000, 0x3000],
  [0x3001, 0x303F],
  [0xFF01, 0xFF0F],
  [0xFF1A, 0xFF20],
  [0xFF3B, 0xFF40],
  [0xFF5B, 0xFF65],
]

/** ASCII letter or digit, the "other script" half of a mixed-script word. */
export function isAsciiAlnum(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
}

export const LINE_BREAK_RANGES: readonly Range[] = [
  [0x0085, 0x0085],
  [0x2028, 0x2029],
]

/** Hangul jamo blocks, the bases that make a Hangul filler load-bearing. */
export const HANGUL_JAMO_RANGES: readonly Range[] = [
  [0x1100, 0x11FF],
  [0xA960, 0xA97C],
  [0xD7B0, 0xD7C6],
]

/** Bases that make a ZWJ or a VS15/VS16 load-bearing: `is_emoji_base`. */
export const EMOJI_BASE_RANGES: readonly Range[] = [
  [0x0023, 0x0023], // #
  [0x002A, 0x002A], // *
  [0x0030, 0x0039], // keycap digits
  [0x00A9, 0x00A9], // COPYRIGHT SIGN
  [0x00AE, 0x00AE], // REGISTERED SIGN
  [0x2122, 0x2122], // TRADE MARK SIGN
  [0x2190, 0x25FF],
  [0x2600, 0x27BF],
  [0x2B00, 0x2BFF],
  [0x3030, 0x3030],
  [0x303D, 0x303D],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
  [0x1F000, 0x1FAFF],
]

/** Bases that make a text/supplement variation selector load-bearing: `is_cjk`. */
export const CJK_RANGES: readonly Range[] = [
  [0x3400, 0x4DBF],
  [0x4E00, 0x9FFF],
  [0xF900, 0xFAFF],
  [0x20000, 0x323AF],
]

/**
 * Typographic punctuation that reads as machine-generated, and the ASCII a
 * human keyboard would have produced. Dashes surrounded by text are handled by
 * {@link DASH_RE} first; what reaches this table is the unspaced remainder.
 */
export const PUNCT: ReadonlyMap<number, string> = new Map([
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201A, "'"],
  [0x201B, "'"],
  [0x201C, '"'],
  [0x201D, '"'],
  [0x201E, '"'],
  [0x201F, '"'],
  [0x02BC, "'"], // modifier letter apostrophe
  [0x2032, "'"], // prime
  [0x2033, '"'], // double prime
  [0x2026, '...'], // horizontal ellipsis
  [0x2010, '-'],
  [0x2011, '-'],
  [0x2012, '-'],
  [0x2013, '-'],
  [0x2014, '-'],
  [0x2015, '-'],
  [0x2212, '-'], // minus sign
  [0x2044, '/'], // fraction slash, what NFKC turns U+00BD VULGAR FRACTION ONE HALF into
])

// ---------------------------------------------------------------- regexes ---

/**
 * Python's `\s` for `str` patterns, spelled out.
 *
 * It is *not* JavaScript's `\s`: Python includes U+001C..U+001F and U+0085 and
 * excludes U+FEFF, JavaScript does the opposite. The pre-pass regexes below all
 * hinge on `(?<=\S)` / `(?=\S)`, so borrowing the wrong definition would change
 * where a dash gets spaced. Written out, the two engines agree exactly.
 */
const PY_SPACE_CLASS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_NON_SPACE = `[^${PY_SPACE_CLASS}]`

/**
 * An en/em dash or horizontal bar *between* two non-space runs, with any
 * surrounding spaces or tabs. `--punct` rewrites the whole match to `" - "`, so
 * `a—b` and `a — b` both land on `a - b`. A dash that starts a line (dialogue)
 * has no left-hand `\S`, so it falls through to the `PUNCT` table and becomes a
 * bare `-`.
 *
 * The `u` flag makes the lookarounds operate on codepoints, so an astral
 * character on either side counts as one non-space, not two surrogate halves.
 */
export const DASH_RE = new RegExp(
  `(?<=${PY_NON_SPACE})[ \\t]*[\\u2013\\u2014\\u2015][ \\t]*(?=${PY_NON_SPACE})`,
  'gu',
)

/**
 * Spaces or tabs before a line break or the very end of the text (`--trailing`).
 * JavaScript's `$` without the `m` flag is Python's `\Z`: end of string only,
 * with no special case for a final newline.
 */
export const TRAILING_RE = /[ \t]+(?=\r?\n|$)/gu

/**
 * Terminal quote bars (`--gutters`): `GUTTERS`, the left block eighths
 * U+258C..U+258F and the light and heavy box-drawing verticals.
 *
 * A terminal draws a block quote with a bar in the left margin, and copying
 * the quote copies the bar as text. The bar is a gutter only when it opens its
 * line (after spaces/tabs, which are kept) and the rest of that line holds no
 * second copy of the SAME glyph; that clause leaves a box-drawn table row
 * alone. It goes with at most one following space, and only one bar goes per
 * line: a quote nested under the same bar is left whole, because its second
 * copy is exactly what a table rule looks like.
 */
export const GUTTER_RANGES: readonly Range[] = [
  [0x2502, 0x2503],
  [0x258C, 0x258F],
]

/**
 * `GUTTER_RE`, the same pattern as the Python.
 *
 * `(?<![^\n])` is "at the start of the text or right after an LF", spelled
 * so that neither engine needs a multiline flag: JavaScript's `m` flag would
 * also start a line after CR, U+2028 and U+2029, and Python's does not. A CR
 * is therefore just a character of its line, which is what keeps CRLF intact.
 * The group-2 backreference inside the lookahead is the "no second copy of
 * this glyph" test. Replaced with `$1`, the indentation.
 */
export const GUTTER_RE = /(?<![^\n])([ \t]*)([\u2502\u2503\u258C-\u258F]) ?(?![^\n]*\2)/gu

/** Runs of two or more spaces/tabs *inside* a line (`--collapse`); indentation is kept. */
export const COLLAPSE_RE = new RegExp(
  `(?<=${PY_NON_SPACE})[ \\t]{2,}(?=${PY_NON_SPACE})`,
  'gu',
)

// ------------------------------------------------- generated (Unicode 16) ---
// Generated by tools/gen_unicode_tables.py from the SAME `unicodedata` that
// built golden.json. Print a fresh block with `python3 tools/gen_unicode_tables.py`;
// `--check` (run in CI) fails if the ranges below no longer match that Python.
//
// Derived from the Unicode Character Database, via Python's unicodedata.
// Copyright (c) 1991-2024 Unicode, Inc. All rights reserved.
// Distributed under the Unicode License v3: https://www.unicode.org/license.txt
//
// The notice lives INSIDE the generated block, and the generator emits it, so a
// regeneration reproduces it rather than dropping it. Unicode's licence requires
// the notice to accompany distributions of the data, and this file is one: it
// ships to every visitor's browser.
/**
 * The UCD version these tables were generated from.
 *
 * `golden.json`'s `meta.unicodeVersion` must agree; the parity test asserts it.
 * If Python moves to a newer UCD, regenerate this file and the fixtures together.
 */
export const TABLES_UNICODE_VERSION = '16.0.0'

/** General_Category=Cf. `classify` uses it as the catch-all for unlisted format controls. */
export const CF_RANGES: readonly Range[] = [
  [0x00AD, 0x00AD], [0x0600, 0x0605], [0x061C, 0x061C], [0x06DD, 0x06DD], [0x070F, 0x070F],
  [0x0890, 0x0891], [0x08E2, 0x08E2], [0x180E, 0x180E], [0x200B, 0x200F], [0x202A, 0x202E],
  [0x2060, 0x2064], [0x2066, 0x206F], [0xFEFF, 0xFEFF], [0xFFF9, 0xFFFB], [0x110BD, 0x110BD],
  [0x110CD, 0x110CD], [0x13430, 0x1343F], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A],
  [0xE0001, 0xE0001], [0xE0020, 0xE007F],
]

/** General_Category=Co (the three private-use areas). */
export const CO_RANGES: readonly Range[] = [
  [0xE000, 0xF8FF], [0xF0000, 0xFFFFD], [0x100000, 0x10FFFD],
]

/** Bidi_Class in {R, AL, AN} -- `is_rtl` in the Python. */
export const RTL_RANGES: readonly Range[] = [
  [0x05BE, 0x05BE], [0x05C0, 0x05C0], [0x05C3, 0x05C3], [0x05C6, 0x05C6], [0x05D0, 0x05EA],
  [0x05EF, 0x05F4], [0x0600, 0x0605], [0x0608, 0x0608], [0x060B, 0x060B], [0x060D, 0x060D],
  [0x061B, 0x064A], [0x0660, 0x0669], [0x066B, 0x066F], [0x0671, 0x06D5], [0x06DD, 0x06DD],
  [0x06E5, 0x06E6], [0x06EE, 0x06EF], [0x06FA, 0x070D], [0x070F, 0x0710], [0x0712, 0x072F],
  [0x074D, 0x07A5], [0x07B1, 0x07B1], [0x07C0, 0x07EA], [0x07F4, 0x07F5], [0x07FA, 0x07FA],
  [0x07FE, 0x0815], [0x081A, 0x081A], [0x0824, 0x0824], [0x0828, 0x0828], [0x0830, 0x083E],
  [0x0840, 0x0858], [0x085E, 0x085E], [0x0860, 0x086A], [0x0870, 0x088E], [0x0890, 0x0891],
  [0x08A0, 0x08C9], [0x08E2, 0x08E2], [0x200F, 0x200F], [0xFB1D, 0xFB1D], [0xFB1F, 0xFB28],
  [0xFB2A, 0xFB36], [0xFB38, 0xFB3C], [0xFB3E, 0xFB3E], [0xFB40, 0xFB41], [0xFB43, 0xFB44],
  [0xFB46, 0xFBC2], [0xFBD3, 0xFD3D], [0xFD50, 0xFD8F], [0xFD92, 0xFDC7], [0xFDF0, 0xFDFC],
  [0xFE70, 0xFE74], [0xFE76, 0xFEFC], [0x10800, 0x10805], [0x10808, 0x10808],
  [0x1080A, 0x10835], [0x10837, 0x10838], [0x1083C, 0x1083C], [0x1083F, 0x10855],
  [0x10857, 0x1089E], [0x108A7, 0x108AF], [0x108E0, 0x108F2], [0x108F4, 0x108F5],
  [0x108FB, 0x1091B], [0x10920, 0x10939], [0x1093F, 0x1093F], [0x10980, 0x109B7],
  [0x109BC, 0x109CF], [0x109D2, 0x10A00], [0x10A10, 0x10A13], [0x10A15, 0x10A17],
  [0x10A19, 0x10A35], [0x10A40, 0x10A48], [0x10A50, 0x10A58], [0x10A60, 0x10A9F],
  [0x10AC0, 0x10AE4], [0x10AEB, 0x10AF6], [0x10B00, 0x10B35], [0x10B40, 0x10B55],
  [0x10B58, 0x10B72], [0x10B78, 0x10B91], [0x10B99, 0x10B9C], [0x10BA9, 0x10BAF],
  [0x10C00, 0x10C48], [0x10C80, 0x10CB2], [0x10CC0, 0x10CF2], [0x10CFA, 0x10D23],
  [0x10D30, 0x10D39], [0x10D40, 0x10D65], [0x10D6F, 0x10D85], [0x10D8E, 0x10D8F],
  [0x10E60, 0x10E7E], [0x10E80, 0x10EA9], [0x10EAD, 0x10EAD], [0x10EB0, 0x10EB1],
  [0x10EC2, 0x10EC4], [0x10F00, 0x10F27], [0x10F30, 0x10F45], [0x10F51, 0x10F59],
  [0x10F70, 0x10F81], [0x10F86, 0x10F89], [0x10FB0, 0x10FCB], [0x10FE0, 0x10FF6],
  [0x1E800, 0x1E8C4], [0x1E8C7, 0x1E8CF], [0x1E900, 0x1E943], [0x1E94B, 0x1E94B],
  [0x1E950, 0x1E959], [0x1E95E, 0x1E95F], [0x1EC71, 0x1ECB4], [0x1ED01, 0x1ED3D],
  [0x1EE00, 0x1EE03], [0x1EE05, 0x1EE1F], [0x1EE21, 0x1EE22], [0x1EE24, 0x1EE24],
  [0x1EE27, 0x1EE27], [0x1EE29, 0x1EE32], [0x1EE34, 0x1EE37], [0x1EE39, 0x1EE39],
  [0x1EE3B, 0x1EE3B], [0x1EE42, 0x1EE42], [0x1EE47, 0x1EE47], [0x1EE49, 0x1EE49],
  [0x1EE4B, 0x1EE4B], [0x1EE4D, 0x1EE4F], [0x1EE51, 0x1EE52], [0x1EE54, 0x1EE54],
  [0x1EE57, 0x1EE57], [0x1EE59, 0x1EE59], [0x1EE5B, 0x1EE5B], [0x1EE5D, 0x1EE5D],
  [0x1EE5F, 0x1EE5F], [0x1EE61, 0x1EE62], [0x1EE64, 0x1EE64], [0x1EE67, 0x1EE6A],
  [0x1EE6C, 0x1EE72], [0x1EE74, 0x1EE77], [0x1EE79, 0x1EE7C], [0x1EE7E, 0x1EE7E],
  [0x1EE80, 0x1EE89], [0x1EE8B, 0x1EE9B], [0x1EEA1, 0x1EEA3], [0x1EEA5, 0x1EEA9],
  [0x1EEAB, 0x1EEBB],
]

/** General_Category starting with L or M, restricted to the blocks `joining_script` scans. */
export const JOINING_LETTER_OR_MARK_RANGES: readonly Range[] = [
  [0x0610, 0x061A], [0x0620, 0x065F], [0x066E, 0x06D3], [0x06D5, 0x06DC], [0x06DF, 0x06E8],
  [0x06EA, 0x06EF], [0x06FA, 0x06FC], [0x06FF, 0x06FF], [0x0710, 0x074A], [0x074D, 0x07B1],
  [0x07CA, 0x07F5], [0x07FA, 0x07FA], [0x07FD, 0x07FD], [0x0800, 0x082D], [0x0840, 0x085B],
  [0x0860, 0x086A], [0x0870, 0x0887], [0x0889, 0x088E], [0x0897, 0x08E1], [0x08E3, 0x08FF],
  [0x0900, 0x0963], [0x0971, 0x0983], [0x0985, 0x098C], [0x098F, 0x0990], [0x0993, 0x09A8],
  [0x09AA, 0x09B0], [0x09B2, 0x09B2], [0x09B6, 0x09B9], [0x09BC, 0x09C4], [0x09C7, 0x09C8],
  [0x09CB, 0x09CE], [0x09D7, 0x09D7], [0x09DC, 0x09DD], [0x09DF, 0x09E3], [0x09F0, 0x09F1],
  [0x09FC, 0x09FC], [0x09FE, 0x09FE], [0x0A01, 0x0A03], [0x0A05, 0x0A0A], [0x0A0F, 0x0A10],
  [0x0A13, 0x0A28], [0x0A2A, 0x0A30], [0x0A32, 0x0A33], [0x0A35, 0x0A36], [0x0A38, 0x0A39],
  [0x0A3C, 0x0A3C], [0x0A3E, 0x0A42], [0x0A47, 0x0A48], [0x0A4B, 0x0A4D], [0x0A51, 0x0A51],
  [0x0A59, 0x0A5C], [0x0A5E, 0x0A5E], [0x0A70, 0x0A75], [0x0A81, 0x0A83], [0x0A85, 0x0A8D],
  [0x0A8F, 0x0A91], [0x0A93, 0x0AA8], [0x0AAA, 0x0AB0], [0x0AB2, 0x0AB3], [0x0AB5, 0x0AB9],
  [0x0ABC, 0x0AC5], [0x0AC7, 0x0AC9], [0x0ACB, 0x0ACD], [0x0AD0, 0x0AD0], [0x0AE0, 0x0AE3],
  [0x0AF9, 0x0AFF], [0x0B01, 0x0B03], [0x0B05, 0x0B0C], [0x0B0F, 0x0B10], [0x0B13, 0x0B28],
  [0x0B2A, 0x0B30], [0x0B32, 0x0B33], [0x0B35, 0x0B39], [0x0B3C, 0x0B44], [0x0B47, 0x0B48],
  [0x0B4B, 0x0B4D], [0x0B55, 0x0B57], [0x0B5C, 0x0B5D], [0x0B5F, 0x0B63], [0x0B71, 0x0B71],
  [0x0B82, 0x0B83], [0x0B85, 0x0B8A], [0x0B8E, 0x0B90], [0x0B92, 0x0B95], [0x0B99, 0x0B9A],
  [0x0B9C, 0x0B9C], [0x0B9E, 0x0B9F], [0x0BA3, 0x0BA4], [0x0BA8, 0x0BAA], [0x0BAE, 0x0BB9],
  [0x0BBE, 0x0BC2], [0x0BC6, 0x0BC8], [0x0BCA, 0x0BCD], [0x0BD0, 0x0BD0], [0x0BD7, 0x0BD7],
  [0x0C00, 0x0C0C], [0x0C0E, 0x0C10], [0x0C12, 0x0C28], [0x0C2A, 0x0C39], [0x0C3C, 0x0C44],
  [0x0C46, 0x0C48], [0x0C4A, 0x0C4D], [0x0C55, 0x0C56], [0x0C58, 0x0C5A], [0x0C5D, 0x0C5D],
  [0x0C60, 0x0C63], [0x0C80, 0x0C83], [0x0C85, 0x0C8C], [0x0C8E, 0x0C90], [0x0C92, 0x0CA8],
  [0x0CAA, 0x0CB3], [0x0CB5, 0x0CB9], [0x0CBC, 0x0CC4], [0x0CC6, 0x0CC8], [0x0CCA, 0x0CCD],
  [0x0CD5, 0x0CD6], [0x0CDD, 0x0CDE], [0x0CE0, 0x0CE3], [0x0CF1, 0x0CF3], [0x0D00, 0x0D0C],
  [0x0D0E, 0x0D10], [0x0D12, 0x0D44], [0x0D46, 0x0D48], [0x0D4A, 0x0D4E], [0x0D54, 0x0D57],
  [0x0D5F, 0x0D63], [0x0D7A, 0x0D7F], [0x0D81, 0x0D83], [0x0D85, 0x0D96], [0x0D9A, 0x0DB1],
  [0x0DB3, 0x0DBB], [0x0DBD, 0x0DBD], [0x0DC0, 0x0DC6], [0x0DCA, 0x0DCA], [0x0DCF, 0x0DD4],
  [0x0DD6, 0x0DD6], [0x0DD8, 0x0DDF], [0x0DF2, 0x0DF3], [0x0F00, 0x0F00], [0x0F18, 0x0F19],
  [0x0F35, 0x0F35], [0x0F37, 0x0F37], [0x0F39, 0x0F39], [0x0F3E, 0x0F47], [0x0F49, 0x0F6C],
  [0x0F71, 0x0F84], [0x0F86, 0x0F97], [0x0F99, 0x0FBC], [0x0FC6, 0x0FC6], [0x1000, 0x103F],
  [0x1050, 0x108F], [0x109A, 0x109D], [0x1780, 0x17D3], [0x17D7, 0x17D7], [0x17DC, 0x17DD],
  [0x180B, 0x180D], [0x180F, 0x180F], [0x1820, 0x1878], [0x1880, 0x18AA], [0xFB50, 0xFBB1],
  [0xFBD3, 0xFD3D], [0xFD50, 0xFD8F], [0xFD92, 0xFDC7], [0xFDF0, 0xFDFB], [0xFE70, 0xFE74],
  [0xFE76, 0xFEFC],
]

/** General_Category L*, restricted to the four blocks `is_letter_in` is called with. */
export const SCRIPT_LETTER_RANGES: readonly Range[] = [
  [0x1780, 0x17B3], [0x17D7, 0x17D7], [0x17DC, 0x17DC], [0x1820, 0x1878], [0x1880, 0x1884],
  [0x1887, 0x18A8], [0x18AA, 0x18AA], [0x13000, 0x1342F], [0x1BC00, 0x1BC6A],
  [0x1BC70, 0x1BC7C], [0x1BC80, 0x1BC88], [0x1BC90, 0x1BC99],
]

// --------------------------------------------------------- end generated ----

// ------------------------------------------------------------ predicates ----

/** `unicodedata.category(chr(cp)) == "Cf"`. */
export function isFormatControl(cp: number): boolean {
  return inRanges(cp, CF_RANGES)
}

/** `unicodedata.category(chr(cp)) == "Co"`. */
export function isPrivateUse(cp: number): boolean {
  return inRanges(cp, CO_RANGES)
}

/** `unicodedata.bidirectional(chr(cp)) in ("R", "AL", "AN")`. */
export function isRtl(cp: number): boolean {
  return inRanges(cp, RTL_RANGES)
}

/** `is_emoji_base`: a base that makes an adjacent ZWJ or VS15/VS16 load-bearing. */
export function isEmojiBase(cp: number): boolean {
  return inRanges(cp, EMOJI_BASE_RANGES)
}

/** `is_cjk`: a base that makes an adjacent text/supplement variation selector load-bearing. */
export function isCjk(cp: number): boolean {
  return inRanges(cp, CJK_RANGES)
}

/** `is_hangul_jamo`: pure block test, no category check, exactly as in the Python. */
export function isHangulJamo(cp: number): boolean {
  return inRanges(cp, HANGUL_JAMO_RANGES)
}

/** `ord(ch) in GLUE`: glue never advances the previous-kept-base cursor. */
export function isGlue(cp: number): boolean {
  return inRanges(cp, GLUE_RANGES)
}

/** The broad script groups in which ZWJ/ZWNJ are ordinary orthography. */
export const JOINING_SCRIPTS = ['arabic', 'indic', 'south-asian', 'khmer', 'mongolian'] as const

export type JoiningScript = (typeof JOINING_SCRIPTS)[number]

/**
 * `joining_script`'s block table, in the Python's own order.
 *
 * The blocks do not overlap, so the order is cosmetic, but it is kept
 * identical so a future edit on either side is a one-line diff.
 */
const JOINING_BLOCKS: readonly (readonly [number, number, JoiningScript])[] = [
  [0x0600, 0x08FF, 'arabic'],
  [0xFB50, 0xFDFF, 'arabic'],
  [0xFE70, 0xFEFF, 'arabic'],
  [0x0900, 0x0DFF, 'indic'],
  [0x0F00, 0x109F, 'south-asian'],
  [0x1780, 0x17FF, 'khmer'],
  [0x1800, 0x18AF, 'mongolian'],
]

/**
 * `joining_script(cp)`: the script group in which a neighbouring ZWJ/ZWNJ is
 * orthographic, or `null`. A ZWNJ is kept when the codepoints on both sides
 * resolve to the *same* group.
 */
export function joiningScript(cp: number): JoiningScript | null {
  for (const [lo, hi, name] of JOINING_BLOCKS) {
    if (cp >= lo && cp <= hi && inRanges(cp, JOINING_LETTER_OR_MARK_RANGES)) return name
  }
  return null
}

/**
 * The four blocks `is_letter_in(cp, lo, hi)` is ever called with.
 *
 * Naming them instead of passing raw bounds keeps
 * {@link SCRIPT_LETTER_RANGES} (which only covers these blocks) from being
 * consulted for a block it has no data for.
 */
const LETTER_BLOCKS = {
  khmer: [0x1780, 0x17FF],
  mongolian: [0x1800, 0x18AF],
  egyptian: [0x13000, 0x1342F],
  duployan: [0x1BC00, 0x1BC9F],
} as const satisfies Record<string, readonly [number, number]>

export type LetterBlock = keyof typeof LETTER_BLOCKS

/** `is_letter_in(cp, lo, hi)`: a letter (category `L*`) inside the named block. */
export function isLetterIn(cp: number, block: LetterBlock): boolean {
  const [lo, hi] = LETTER_BLOCKS[block]
  return cp >= lo && cp <= hi && inRanges(cp, SCRIPT_LETTER_RANGES)
}
