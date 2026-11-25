/**
 * Behavioural tests for the text engine.
 *
 * `parity.test.ts` proves the port is byte-identical to the Python across the
 * whole golden corpus. This file is the readable half: the cases from
 * `tests/test_strip_invisible.py` restated as assertions, plus the things only
 * the TypeScript side has: codepoint-counted positions, the `Action`
 * derivation, the three-tile summary and the Python-vs-JavaScript regex traps
 * that a naive port falls into.
 *
 * Invisible characters are written as `U(0x200b)` rather than pasted in. A test
 * suite for a hidden-character stripper is the last place you want a literal
 * zero-width space that a reviewer cannot see.
 */
import { describe, expect, it } from 'vitest'

import { classify, inMixedScriptWord, mixedScriptWords, toCodePoints, validFlagTagIndices } from '../classify'
import { DEFAULT_OPTIONS, MAX_OPTIONS, clean, cleanText, enabledFlags, resolveOptions } from '../clean'
import { find } from '../find'
import {
  ALWAYS_STRIP_RANGES,
  BIDI_ALWAYS_RANGES,
  BIDI_MARK_RANGES,
  CONTROL_RANGES,
  GLUE_RANGES,
  LINE_BREAK_RANGES,
  ORTHOGRAPHIC_CF_RANGES,
  PUNCT,
  SPACE_RANGES,
} from '../tables'
import type { Range } from '../tables'
import { formatCodepoint, nameOf } from '../unicode-names'
import { CLEAN_OPTION_KEYS } from '../types'
import type { CleanOptionKey, Finding } from '../types'

/** Build a string from codepoints, so no test fixture is literally invisible. */
const U = (...cps: number[]): string => String.fromCodePoint(...cps)

const ZWSP = 0x200b
const ZWNJ = 0x200c
const ZWJ = 0x200d
const LRM = 0x200e
const RLM = 0x200f
const RLO = 0x202e
const ALM = 0x061c
const SOFT_HYPHEN = 0x00ad
const CGJ = 0x034f
const BOM = 0xfeff
const NBSP = 0x00a0
const NNBSP = 0x202f
const IDEOGRAPHIC_SPACE = 0x3000
const LINE_SEPARATOR = 0x2028
const NEL = 0x0085
const EM_DASH = 0x2014
const EN_DASH = 0x2013
const ELLIPSIS = 0x2026
const RIGHT_SINGLE_QUOTE = 0x2019
const LEFT_DOUBLE_QUOTE = 0x201c
const RIGHT_DOUBLE_QUOTE = 0x201d
const VS16 = 0xfe0f
const BELL = 0x0007
const PUA = 0xe000
const BLACK_FLAG = 0x1f3f4
const CANCEL_TAG = 0xe007f
const GRINNING_FACE = 0x1f600
const MAN = 0x1f468
const WOMAN = 0x1f469
const GIRL = 0x1f467
const RED_HEART = 0x2764
const FIRE = 0x1f525

const SCOTLAND_FLAG = U(BLACK_FLAG, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, CANCEL_TAG)
const FAMILY = U(MAN, ZWJ, WOMAN, ZWJ, GIRL)
const PERSIAN = U(0x0645, 0x06cc, ZWNJ, 0x0631, 0x0648, 0x0645) // می‌روم
const HEBREW = U(0x05e9, 0x05dc, 0x05d5, 0x05dd) // שלום

/** How many codepoints a range table covers: the Python `len(SET)`. */
function sizeOf(ranges: readonly Range[]): number {
  return ranges.reduce((total, [lo, hi]) => total + (hi - lo + 1), 0)
}

describe('tables', () => {
  // The Python's `len()` of each set, recorded so a mistyped range boundary
  // cannot slip through as "one more codepoint than intended".
  it.each([
    ['ALWAYS_STRIP', ALWAYS_STRIP_RANGES, 3834],
    ['BIDI_ALWAYS', BIDI_ALWAYS_RANGES, 5],
    ['BIDI_MARKS', BIDI_MARK_RANGES, 7],
    ['GLUE', GLUE_RANGES, 413],
    ['SPACES', SPACE_RANGES, 16],
    ['CONTROLS', CONTROL_RANGES, 61],
    ['LINE_BREAKS', LINE_BREAK_RANGES, 3],
    ['ORTHOGRAPHIC_CF', ORTHOGRAPHIC_CF_RANGES, 11],
  ])('%s covers exactly the codepoints the Python set does', (_name, ranges, size) => {
    expect(sizeOf(ranges)).toBe(size)
  })

  it('PUNCT maps the same twenty codepoints', () => {
    expect(PUNCT.size).toBe(20)
    expect(PUNCT.get(ELLIPSIS)).toBe('...')
    expect(PUNCT.get(EM_DASH)).toBe('-')
    expect(PUNCT.get(0x2044)).toBe('/')
  })

  it('excludes tab, LF and CR from CONTROLS: they are legitimate text', () => {
    expect(cleanText('a\tb\nc\rd', { controls: true })).toBe('a\tb\nc\rd')
  })
})

describe('default pass: the contraband that needs no flag', () => {
  it.each([
    ZWSP, 0x2060, SOFT_HYPHEN, 0x2061, 0x2062, 0x2063, 0x2064,
    0x202a, 0x202b, 0x202c, 0x202d, RLO, BOM,
  ])('U+%s is stripped with no flags', (cp) => {
    expect(cleanText(`A${U(cp)}B`)).toBe('AB')
  })

  it('strips LRM and RLM inside Latin text', () => {
    expect(cleanText(`A${U(LRM)}B`)).toBe('AB')
    expect(cleanText(`A${U(RLM)}B`)).toBe('AB')
  })

  it('strips free-floating ZWJ and ZWNJ between Latin letters', () => {
    expect(cleanText(`A${U(ZWJ)}B`)).toBe('AB')
    expect(cleanText(`A${U(ZWNJ)}B`)).toBe('AB')
  })

  it('leaves exotic spaces and alternative line breaks alone until asked', () => {
    for (const cp of [NBSP, NNBSP, 0x205f, IDEOGRAPHIC_SPACE]) {
      expect(cleanText(`A${U(cp)}B`)).toBe(`A${U(cp)}B`)
      expect(cleanText(`A${U(cp)}B`, { spaces: true })).toBe('A B')
    }
    for (const cp of [LINE_SEPARATOR, 0x2029, NEL]) {
      expect(cleanText(`A${U(cp)}B`)).toBe(`A${U(cp)}B`)
      expect(cleanText(`A${U(cp)}B`, { newlines: true })).toBe('A\nB')
    }
  })

  it('keeps CRLF unless -n is on', () => {
    expect(cleanText('a\r\nb')).toBe('a\r\nb')
    expect(cleanText('a\r\nb', { newlines: true })).toBe('a\nb')
    expect(cleanText('a\nb', { newlines: true })).toBe('a\nb')
  })
})

describe('context-aware glue', () => {
  it('keeps a family emoji together and breaks it only with -a', () => {
    expect(cleanText(FAMILY)).toBe(FAMILY)
    expect(cleanText(FAMILY, { aggressive: true })).toBe(U(MAN, WOMAN, GIRL))
  })

  it('keeps heart-on-fire, a VS16 + ZWJ chain', () => {
    const heartOnFire = U(RED_HEART, VS16, ZWJ, FIRE)
    expect(cleanText(heartOnFire)).toBe(heartOnFire)
  })

  it('keeps a keycap but strips a VS16 hanging off a Latin letter', () => {
    const keycap = U(0x31, VS16, 0x20e3)
    expect(cleanText(keycap)).toBe(keycap)
    expect(cleanText(`A${U(VS16)}B`)).toBe('AB')
  })

  it('keeps a Persian ZWNJ and strips it with -a', () => {
    expect(cleanText(PERSIAN)).toBe(PERSIAN)
    expect(cleanText(PERSIAN, { aggressive: true })).toBe(PERSIAN.replace(U(ZWNJ), ''))
  })

  it('keeps a Devanagari ZWJ', () => {
    const devanagari = U(0x0915, 0x094d, ZWJ, 0x0937)
    expect(cleanText(devanagari)).toBe(devanagari)
  })

  it('keeps a complete subdivision flag and strips a truncated one', () => {
    expect(cleanText(SCOTLAND_FLAG)).toBe(SCOTLAND_FLAG)
    expect(cleanText(SCOTLAND_FLAG, { aggressive: true })).toBe(U(BLACK_FLAG))
    expect(cleanText(U(BLACK_FLAG, 0xe0067) + 'A')).toBe(`${U(BLACK_FLAG)}A`)
  })

  it('strips free tag characters: the ASCII smuggling channel', () => {
    expect(cleanText(`A${U(0xe0048, 0xe0069)}B`)).toBe('AB')
  })

  it.each([
    ['Khmer inherent vowel', U(0x1780, 0x17b4), `A${U(0x17b4)}B`],
    ['Hangul filler', U(0x1100, 0x1160), `A${U(0x1160)}B`],
    ['Mongolian FVS', U(0x1820, 0x180b), `A${U(0x180b)}B`],
    ['ideographic variation selector', U(0x8fbb, 0xe0100), `A${U(0xe0100, 0xe0101)}B`],
  ])('keeps a %s after its own script and strips it after Latin', (_name, kept, stripped) => {
    expect(cleanText(kept)).toBe(kept)
    expect(cleanText(stripped)).toBe('AB')
  })

  it('strips U+3164 HANGUL FILLER, which is ALWAYS_STRIP rather than glue', () => {
    expect(cleanText(`A${U(0x3164)}B`)).toBe('AB')
  })

  it('does not let glue advance the base a later character is judged against', () => {
    // The ZWJ sees the emoji through the doomed ZWSP: glue never becomes
    // `prev_kept`, and a deleted character never becomes it either.
    const smuggled = U(MAN, ZWSP, ZWJ, WOMAN)
    expect(cleanText(smuggled)).toBe(U(MAN, ZWJ, WOMAN))
  })
})

describe('bidi', () => {
  it('keeps an LRM next to Hebrew, removes it with --bidi', () => {
    const text = `${HEBREW}${U(LRM)} (hi)`
    expect(cleanText(text)).toBe(text)
    expect(cleanText(text, { bidi: true })).toBe(`${HEBREW} (hi)`)
  })

  it('keeps an isolate wrapping Arabic', () => {
    const text = U(0x2067, 0x0645, 0x2069)
    expect(cleanText(text)).toBe(text)
  })

  it('strips an override even next to RTL: it can reorder unrelated text', () => {
    expect(cleanText(U(RLO, 0x0645))).toBe(U(0x0645))
  })

  it('strips an Arabic letter mark sitting in Latin', () => {
    expect(cleanText(`A${U(ALM)}B`)).toBe('AB')
  })
})

describe('catch-alls', () => {
  it('strips a combining grapheme joiner and an unlisted Cf', () => {
    expect(cleanText(`A${U(CGJ)}B`)).toBe('AB')
    expect(cleanText(`A${U(0xfffb)}B`)).toBe('AB')
    expect(cleanText(`A${U(0x0890)}B`)).toBe('AB') // Cf with no table entry
  })

  it('spares the orthographic Arabic controls', () => {
    // U+0600 ARABIC NUMBER SIGN is a Cf, but it is ordinary orthography and is
    // excused before the catch-all. (The digit beside it is a confusable, so
    // the text is not finding-free: only U+0600 is.)
    const text = U(0x0600, 0x0661)
    expect(cleanText(text)).toBe(text)
    expect(find(text).map((hit) => hit.cp)).not.toContain(0x0600)
  })

  it('keeps private-use characters unless --pua (icon fonts live there)', () => {
    expect(cleanText(`A${U(PUA)}B`)).toBe(`A${U(PUA)}B`)
    expect(cleanText(`A${U(PUA)}B`, { pua: true })).toBe('AB')
  })

  it('keeps C0 controls unless --controls', () => {
    expect(cleanText(`A${U(BELL)}B`)).toBe(`A${U(BELL)}B`)
    expect(cleanText(`A${U(BELL)}B`, { controls: true })).toBe('AB')
  })

  it('lets -n win over --controls for NEL', () => {
    expect(cleanText(`A${U(NEL)}B`, { controls: true, newlines: true })).toBe('A\nB')
  })

  it('strips a noncharacter, which no category test would catch', () => {
    expect(cleanText(`A${U(0xfdd0)}B`)).toBe('AB')
    expect(cleanText(`A${U(0x10fffe)}B`)).toBe('AB')
  })
})

describe('--punct', () => {
  it.each([
    ['unspaced em dash', `a${U(EM_DASH)}b`, 'a - b'],
    ['spaced em dash, no double space', `a ${U(EM_DASH)} b`, 'a - b'],
    ['leading em dash keeps dialogue shape', `${U(EM_DASH)}Hello`, '-Hello'],
    ['en dash range', `1990${U(EN_DASH)}1995`, '1990 - 1995'],
    ['curly double quotes', `${U(LEFT_DOUBLE_QUOTE)}x${U(RIGHT_DOUBLE_QUOTE)}`, '"x"'],
    ['apostrophe', `don${U(RIGHT_SINGLE_QUOTE)}t`, "don't"],
    ['ellipsis', `wait${U(ELLIPSIS)}`, 'wait...'],
    ['minus and non-breaking hyphen', `${U(0x2212)}5 ${U(0x2011)}`, '-5 -'],
    ['multi-line', `a${U(EM_DASH)}b\nc ${U(EM_DASH)} d`, 'a - b\nc - d'],
  ])('%s', (_name, input, expected) => {
    expect(cleanText(input, { punct: true })).toBe(expected)
  })

  it('leaves an em dash alone without the flag', () => {
    expect(cleanText(`a${U(EM_DASH)}b`)).toBe(`a${U(EM_DASH)}b`)
  })
})

describe('normalisation and confusables', () => {
  it('NFKC folds styled maths and fullwidth to ASCII', () => {
    const bold = [...'hello'].map((c) => U(0x1d41a + (c.codePointAt(0) ?? 0) - 97)).join('')
    expect(cleanText(bold, { nfkc: true })).toBe('hello')
    expect(cleanText(U(0xff28, 0xff49), { nfkc: true })).toBe('Hi')
  })

  it('leaves Cyrillic alone by default and Latinises it only on request', () => {
    const cyrillicApple = `${U(0x0430)}pple`
    expect(cleanText(cyrillicApple)).toBe(cyrillicApple)
    expect(cleanText(cyrillicApple, { confusables: true })).toBe('apple')
  })

  it('leaves a pure-Cyrillic word alone: look-alikes count only in mixed-script words', () => {
    // "сор" is Russian, not three look-alikes.
    expect(cleanText(U(0x0441, 0x043e, 0x0440), { confusables: true })).toBe(U(0x0441, 0x043e, 0x0440))
    // A Cyrillic с inside a Latin brand IS one: even in the middle of Russian prose.
    expect(cleanText(`письмо от Mi${U(0x0441)}rosoft`, { confusables: true })).toBe('письмо от Microsoft')
    // Punctuation is a word boundary; invisible characters are not.
    expect(cleanText(`сор, ok`, { confusables: true })).toBe('сор, ok')
    expect(cleanText(`${U(0x0430)}${U(0x200b)}pple`, { confusables: true })).toBe('apple')
  })

  it('reports zero findings on ordinary Russian prose', () => {
    expect(find('Рецепт шарлотки наконец готов').length).toBe(0)
  })
})

describe('Python regex semantics, not JavaScript', () => {
  // Python's `\S` and JavaScript's differ on three sets. `tables.ts` writes the
  // class out by hand; these are the cases that catch a lazy `\S`.
  it('treats U+FEFF as non-space, the way Python does', () => {
    expect(cleanText(`${U(BOM)}${U(EM_DASH)}x`, { punct: true })).toBe(' - x')
    expect(cleanText(`a${U(BOM)}  ${U(BOM)}b`, { collapse: true })).toBe('a b')
  })

  it('treats U+0085 and U+001F as space, the way Python does', () => {
    expect(cleanText(`${U(NEL)}${U(EM_DASH)}x`, { punct: true })).toBe(`${U(NEL)}-x`)
    const withNel = `a${U(NEL)}  ${U(NEL)}b`
    expect(cleanText(withNel, { collapse: true })).toBe(withNel)
    const withUnitSep = `a${U(0x1f)}  ${U(0x1f)}b`
    expect(cleanText(withUnitSep, { collapse: true })).toBe(withUnitSep)
  })

  it('counts an astral character as one non-space, not two surrogates', () => {
    expect(cleanText(U(GRINNING_FACE, EM_DASH, GRINNING_FACE), { punct: true })).toBe(
      `${U(GRINNING_FACE)} - ${U(GRINNING_FACE)}`,
    )
  })

  it('collapses inside lines but keeps indentation', () => {
    expect(cleanText('  indented  text  ', { collapse: true })).toBe('  indented text  ')
  })

  it('strips trailing whitespace at a line end and at the end of the text', () => {
    expect(cleanText('line \nnext', { trailing: true })).toBe('line\nnext')
    expect(cleanText('trail   ', { trailing: true })).toBe('trail')
    // The BOM is not a space, so the run before it is not trailing.
    expect(cleanText(`line ${U(BOM)}\nnext`, { trailing: true })).toBe('line \nnext')
  })
})

describe('positions are counted in codepoints', () => {
  it('does not double-count an astral character in a column', () => {
    const text = `${U(GRINNING_FACE)}${U(ZWSP)}x\n${U(MAN)}${U(ZWJ)}A`
    expect(find(text).map((hit) => [hit.line, hit.col, hit.cp, hit.kind, hit.flag])).toEqual([
      [1, 2, ZWSP, 'invisible', 'default'],
      [2, 2, ZWJ, 'glue', 'default'],
    ])
  })

  it('reports index as a codepoint offset usable with Array.from(text)', () => {
    const text = `${U(GRINNING_FACE)}${U(ZWSP)}x`
    const [finding] = find(text)
    expect(finding?.index).toBe(1)
    expect(toCodePoints(text)[finding?.index ?? -1]).toBe(ZWSP)
  })

  it('restarts the column on every LF', () => {
    const text = `a\nb${U(ZWSP)}`
    expect(find(text).map((hit) => [hit.line, hit.col])).toEqual([[2, 2]])
  })
})

describe('findings', () => {
  it('names what it finds, and falls back to U+XXXX', () => {
    const [finding] = find(`A${U(ZWSP)}B`)
    expect(finding?.name).toBe('ZERO WIDTH SPACE')
    expect(nameOf(0xfdd0)).toBe('U+FDD0')
    expect(formatCodepoint(ZWSP)).toBe('U+200B')
  })

  it('carries a replacement only when there is one', () => {
    const [invisible] = find(`A${U(ZWSP)}B`)
    expect(invisible).toBeDefined()
    expect(invisible && 'replacement' in invisible).toBe(false)
    const [space] = find(`A${U(NBSP)}B`)
    expect(space?.replacement).toBe(' ')
  })

  it('is flag-independent: the same text always yields the same findings', () => {
    const text = `${FAMILY}${U(ZWSP)}${U(NBSP)}`
    const shape = (findings: readonly Finding[]): unknown =>
      findings.map((hit) => [hit.index, hit.cp, hit.kind, hit.flag])
    expect(shape(clean(text, MAX_OPTIONS).findings)).toEqual(shape(find(text)))
  })
})

describe('actions and the summary tiles', () => {
  const text = `${FAMILY}${U(ZWSP)}${U(NBSP)}${U(ELLIPSIS)}`

  it('splits glue into kept-load-bearing and everything else into not-targeted', () => {
    const { summary, findings } = clean(text)
    expect(findings.map((hit) => hit.action)).toEqual([
      'kept-load-bearing', // ZWJ inside the family
      'kept-load-bearing',
      'removed', // ZWSP, no flag needed
      'found-not-targeted', // NBSP, wants -s
      'found-not-targeted', // ellipsis, wants --punct
    ])
    expect(summary).toEqual({ removed: 1, replaced: 0, keptLoadBearing: 2, foundNotTargeted: 2 })
  })

  it('moves everything into removed/replaced under --max', () => {
    const { summary } = clean(text, MAX_OPTIONS)
    expect(summary).toEqual({ removed: 3, replaced: 2, keptLoadBearing: 0, foundNotTargeted: 0 })
  })

  it('calls a bidi mark next to RTL kept-load-bearing, and one in Latin removed', () => {
    const bidiMark = (text: string): Finding | undefined =>
      clean(text).findings.find((hit) => hit.kind === 'bidi-mark')
    expect(bidiMark(`${HEBREW}${U(RLM)}`)?.action).toBe('kept-load-bearing')
    expect(bidiMark(`A${U(RLM)}B`)?.action).toBe('removed')
  })

  it('summarises nothing for clean text', () => {
    const result = clean('Perfectly ordinary prose.')
    expect(result.findings).toHaveLength(0)
    expect(result.summary).toEqual({ removed: 0, replaced: 0, keptLoadBearing: 0, foundNotTargeted: 0 })
    expect(result.text).toBe('Perfectly ordinary prose.')
  })
})

describe('options', () => {
  it('defaults every switch to off', () => {
    expect(resolveOptions()).toEqual(DEFAULT_OPTIONS)
    expect(resolveOptions({ punct: true })).toEqual({ ...DEFAULT_OPTIONS, punct: true })
    expect(Object.values(DEFAULT_OPTIONS).every((value) => value === false)).toBe(true)
  })

  it('exposes exactly the thirteen keys the CLI has', () => {
    expect([...CLEAN_OPTION_KEYS]).toEqual(Object.keys(DEFAULT_OPTIONS))
  })

  it('turns everything but --nfc on for --max, matching the Python MAX_FLAGS', () => {
    const on = CLEAN_OPTION_KEYS.filter((key: CleanOptionKey) => MAX_OPTIONS[key])
    expect([...on]).toEqual([
      'aggressive', 'spaces', 'newlines', 'bidi', 'controls', 'pua',
      'punct', 'confusables', 'nfkc', 'gutters', 'trailing', 'collapse',
    ])
  })

  it('maps the eight classifier options onto their CLI flags', () => {
    expect([...enabledFlags(DEFAULT_OPTIONS)]).toEqual(['default'])
    expect([...enabledFlags(resolveOptions({ spaces: true, punct: true }))].sort()).toEqual(
      ['--punct', '-s', 'default'].sort(),
    )
    // Pre-passes have no flag: they never gate the classifier.
    expect([...enabledFlags(resolveOptions({ nfkc: true, trailing: true, collapse: true, nfc: true }))]).toEqual([
      'default',
    ])
    // `--gutters` is the one pre-pass with a flag, and it only decides actions.
    expect([...enabledFlags(resolveOptions({ gutters: true }))]).toEqual(['default', '--gutters'])
  })
})

describe('--gutters: terminal quote bars', () => {
  const BAR = 0x258e
  const LIGHT = 0x2502
  const HEAVY = 0x2503
  const email = `${U(BAR)} Dear Mr Kirch,\n${U(BAR)}\n${U(BAR)} We apologise for the delay.\n`

  it('strips the bar and one space from each line, and a bare bar line goes empty', () => {
    expect(cleanText(email)).toBe(email)
    expect(cleanText(email, { gutters: true })).toBe('Dear Mr Kirch,\n\nWe apologise for the delay.\n')
  })

  it('keeps CRLF, indentation, and the second of two spaces', () => {
    expect(cleanText(`${U(BAR)} a\r\n${U(BAR)} b\r\n`, { gutters: true })).toBe('a\r\nb\r\n')
    expect(cleanText(`  ${U(LIGHT)} x\n\t${U(HEAVY)} y`, { gutters: true })).toBe('  x\n\ty')
    expect(cleanText(`${U(LIGHT)}  two`, { gutters: true })).toBe(' two')
    expect(cleanText(`${U(BAR)}x`, { gutters: true })).toBe('x')
  })

  it('leaves a box-drawn table row and a mid-line bar alone', () => {
    const row = `${U(LIGHT)} a ${U(LIGHT)} b ${U(LIGHT)}`
    expect(cleanText(row, { gutters: true })).toBe(row)
    expect(find(row)).toHaveLength(0)
    const mid = `mid ${U(BAR)} bar`
    expect(cleanText(mid, { gutters: true })).toBe(mid)
    expect(find(mid)).toHaveLength(0)
  })

  it('starts a line only after LF, never after a lone CR, U+2028 or NEL', () => {
    // A JavaScript `m` flag would start a line after all three. Python's does not.
    for (const separator of ['\r', U(0x2028), U(NEL)]) {
      const text = `${U(BAR)} a${separator}${U(BAR)} b`
      expect(cleanText(text, { gutters: true })).toBe(text)
    }
  })

  it('removes one bar per line and never loops', () => {
    expect(cleanText(`${U(LIGHT)} ${U(BAR)} x`, { gutters: true })).toBe(`${U(BAR)} x`)
  })

  it('runs before --trailing, so a bare bar with spaces trails clean', () => {
    expect(cleanText(`${U(BAR)}   \nx`, { gutters: true })).toBe('  \nx')
    expect(cleanText(`${U(BAR)}   \nx`, { gutters: true, trailing: true })).toBe('\nx')
  })

  it('reports every bar it removes as a gutter finding', () => {
    const off = clean(email)
    expect(off.findings.map((hit) => [hit.line, hit.col, hit.cp, hit.kind, hit.flag, hit.action])).toEqual([
      [1, 1, BAR, 'gutter', '--gutters', 'found-not-targeted'],
      [2, 1, BAR, 'gutter', '--gutters', 'found-not-targeted'],
      [3, 1, BAR, 'gutter', '--gutters', 'found-not-targeted'],
    ])
    const on = clean(email, { gutters: true })
    expect(on.findings.map((hit) => hit.action)).toEqual(['removed', 'removed', 'removed'])
    expect(on.summary.removed).toBe(3)
    expect(on.findings[0]?.name).toBe('LEFT ONE QUARTER BLOCK')
  })
})

describe('flag-tag sequences', () => {
  it('marks the indices inside a complete flag sequence and nothing else', () => {
    const cps = toCodePoints(`x${SCOTLAND_FLAG}y`)
    expect([...validFlagTagIndices(cps)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('marks nothing for a flag with no cancel tag', () => {
    expect(validFlagTagIndices(toCodePoints(U(BLACK_FLAG, 0xe0067))).size).toBe(0)
  })

  it('marks nothing for a bare black flag', () => {
    expect(validFlagTagIndices(toCodePoints(U(BLACK_FLAG, CANCEL_TAG))).size).toBe(0)
  })

  it('handles two flags in a row', () => {
    const cps = toCodePoints(SCOTLAND_FLAG + SCOTLAND_FLAG)
    expect(validFlagTagIndices(cps).size).toBe(12)
  })
})

describe('classify', () => {
  const noTags: ReadonlySet<number> = new Set()

  it('returns null for ordinary characters', () => {
    expect(classify(toCodePoints('abc'), 1, 0x61, noTags)).toBeNull()
  })

  it('returns null for an out-of-range index instead of throwing', () => {
    expect(classify(toCodePoints('abc'), 9, null, noTags)).toBeNull()
  })

  it('reports the flag a finding needs, not whether it is on', () => {
    expect(classify(toCodePoints(U(NBSP)), 0, null, noTags)).toEqual({
      kind: 'space',
      flag: '-s',
      replacement: ' ',
    })
  })
})

describe('mixed-script words', () => {
  const CYR_A = 0x0430
  const CYR_BE = 0x0431
  const CYR_ES = 0x0441
  const CYR_O = 0x043e
  const CYR_ER = 0x0440

  it.each([
    ['a look-alike a in "apple" is in a mixed word', `${U(CYR_A)}pple`, 0, true],
    ['a look-alike inside a pure Cyrillic word is not', U(CYR_ES, CYR_O, CYR_ER), 1, false],
    ['the last letter before a comma, Latin word after it, is not', `${U(CYR_ES, CYR_O, CYR_ER)}, ok`, 2, false],
    ['the first letter after a space, Latin word before it, is not', `ok ${U(CYR_A, CYR_BE)}`, 3, false],
    ['a letter between a Cyrillic letter and a Latin one is', `${U(CYR_BE, CYR_A)}c`, 1, true],
    ['a boundary index sees the word on either side', `${U(CYR_A)} b`, 1, true],
  ] as const)('%s', (_desc, text, index, want) => {
    const cps = toCodePoints(text)
    expect(inMixedScriptWord(cps, index)).toBe(want)
    expect(mixedScriptWords(cps)[index]).toBe(want)
  })

  it('answers the whole text exactly as it answers each index', () => {
    const samples = [
      '',
      U(CYR_A),
      `${U(CYR_A)}pple ${U(CYR_ES, CYR_O, CYR_ER)}, ok`,
      `1${U(0x041e)}0 %\n${U(CYR_A)}-b`,
      `${U(CYR_O)}t Mi${U(CYR_ES)}rosoft`,
      `${U(CYR_A, ZWSP)}pple`,
      `a b ${U(CYR_A)} . c`,
    ]
    for (const text of samples) {
      const cps = toCodePoints(text)
      expect(mixedScriptWords(cps)).toEqual(cps.map((_, i) => inMixedScriptWord(cps, i)))
    }
  })

  it.each([
    ['a 200,000-letter Cyrillic word', U(CYR_A).repeat(200_000), U(CYR_A).repeat(200_000), 0],
    ['200,000 look-alikes in one Latin word', `${U(CYR_A).repeat(200_000)}b`, `${'a'.repeat(200_000)}b`, 200_000],
  ] as const)('cleans and finds %s in linear time', (_desc, text, want, findings) => {
    const start = performance.now()
    const result = clean(text, { confusables: true })
    const hits = find(text)
    const took = performance.now() - start
    expect(result.text).toBe(want)
    expect(hits).toHaveLength(findings)
    expect(took).toBeLessThan(2000)
  })
})

describe('end to end', () => {
  it('cleans the realistic mixed paragraph the Python test uses', () => {
    const paragraph =
      `The${U(ZWSP)} results${U(EM_DASH)}which we${U(RIGHT_SINGLE_QUOTE)}ll discuss${U(ELLIPSIS)} ` +
      `${U(EM_DASH)} were ${U(LEFT_DOUBLE_QUOTE)}clear${U(RIGHT_DOUBLE_QUOTE)}. ` +
      `${FAMILY} ${U(RED_HEART, VS16)} ${PERSIAN} ${SCOTLAND_FLAG}${U(LRM)}\n` +
      `Se${U(SOFT_HYPHEN)}cond line ${U(0xe0048, 0xe0069)} hidden.`
    expect(cleanText(paragraph, { spaces: true, punct: true })).toBe(
      `The results - which we'll discuss... - were "clear". ` +
        `${FAMILY} ${U(RED_HEART, VS16)} ${PERSIAN} ${SCOTLAND_FLAG}\n` +
        `Second line  hidden.`,
    )
  })

  it('leaves ordinary prose untouched under every switch', () => {
    const prose = 'Nothing to see here.\nSecond line.\n'
    expect(cleanText(prose, MAX_OPTIONS)).toBe(prose)
  })

  it('handles empty input', () => {
    expect(clean('')).toEqual({
      text: '',
      findings: [],
      summary: { removed: 0, replaced: 0, keptLoadBearing: 0, foundNotTargeted: 0 },
    })
  })
})
