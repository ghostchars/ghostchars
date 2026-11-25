/**
 * The proxy's own policy on characters that draw nothing: stricter than the
 * engine's default clean, which `mcp-proxy` applies on top of it.
 *
 * WHY STRICTER. The default clean keeps a character that does real work in
 * ordinary text: a tag sequence that spells a subdivision flag, a variation
 * selector after an ideograph, a left-to-right mark between Hebrew letters, a
 * joiner between Arabic letters, a control or a private-use character when
 * their switches are off. Each of those can carry a message, one bit or one
 * byte per character, and a person pasting text has a reason to keep them. An
 * MCP server has no reason to send a train of them to a model. So the proxy
 * removes:
 *
 *  - every tag character outside the subdivision flags on Unicode's list of
 *    recommended emoji (England, Scotland, Wales);
 *  - every variation selector except one that changes how an emoji looks: VS16
 *    after a base whose default presentation is text, VS15 after a base whose
 *    default is emoji. A selector that restates the default changes nothing a
 *    reader sees, so alternating the two cannot carry a bit. The engine
 *    carries no table of registered ideographic variation sequences, so VS1
 *    to VS14 and VS17 to VS256 all go;
 *  - every bidi mark: LRM, RLM, ALM and the isolates;
 *  - all of a string's glue bound to letters (joiners between Arabic, Persian
 *    or Indic letters, Mongolian free variation selectors, Khmer inherent
 *    vowels, Hangul fillers, script format controls) when there is too much
 *    of it: in prose, {@link DENSITY_MIN} or more and more than one per
 *    {@link DENSITY_LETTERS} letters of its own script, over the string and
 *    over every stretch of {@link DENSITY_WINDOW} of those letters; in an
 *    exact field, more than {@link EXACT_GLUE_MAX}. Persian prose runs at one
 *    joiner per 15 to 40 letters, and the densest multi-joiner text in the
 *    engine's fixtures at one per 12; a message needs far more.
 *
 * Controls and private-use characters are handled by switching on the engine's
 * own `controls` and `pua` options for prose; for exact fields see
 * {@link exactDrops}.
 */
import { scan, toCodePoints } from '@ghostchars/engine'
import type { ScanHit } from '@ghostchars/engine'

/** Why the policy removed a character, as the notice and the log name it. */
export type PolicyCategory = 'tag-sequence' | 'variation-selector' | 'bidi-mark' | 'glue-density'

/** A text, split into codepoints and scanned once. */
export interface Analysis {
  readonly cps: readonly number[]
  readonly hits: ReadonlyMap<number, ScanHit>
}

export function analyse(text: string): Analysis {
  const cps = toCodePoints(text)
  return { cps, hits: new Map(scan(cps).map((hit) => [hit.index, hit])) }
}

const BLACK_FLAG = 0x1f3f4
const CANCEL_TAG = 0xe007f
const ZWNJ = 0x200c
const ZWJ = 0x200d

/** The subdivision flags on Unicode's list of recommended emoji, as tag letters. */
const RGI_SUBDIVISIONS: ReadonlySet<string> = new Set(['gbeng', 'gbsct', 'gbwls'])

/** Prose with fewer letter-bound glue characters than this is never judged dense. */
export const DENSITY_MIN = 3

/** Prose with more than one letter-bound glue character per this many script letters is dense. */
export const DENSITY_LETTERS = 8

/** The most letter-bound glue characters an exact field may hold. */
export const EXACT_GLUE_MAX = 2

/**
 * Script letters in one stretch of a long string: a window this wide, slid
 * along the letters of one script, must not hold more than one letter-bound
 * glue character per {@link DENSITY_LETTERS} letters either. Without it, a
 * dense train in the middle of a long string of plain letters would pass the
 * whole-string ratio.
 */
export const DENSITY_WINDOW = 64

/**
 * The blocks of the scripts whose letters bind glue, each with its script:
 * the classifier's joining scripts (Arabic, Indic, the other South Asian
 * scripts, Khmer, Mongolian), Hangul, Egyptian hieroglyphs and Duployan.
 */
const GLUE_SCRIPT_BLOCKS: readonly (readonly [number, number, string])[] = [
  [0x0600, 0x08ff, 'arabic'],
  [0x0900, 0x0dff, 'indic'],
  [0x0f00, 0x109f, 'south-asian'],
  [0x1100, 0x11ff, 'hangul'],
  [0x1780, 0x17ff, 'khmer'],
  [0x1800, 0x18af, 'mongolian'],
  [0x3130, 0x318f, 'hangul'],
  [0xac00, 0xd7af, 'hangul'],
  [0xfb50, 0xfdff, 'arabic'],
  [0xfe70, 0xfeff, 'arabic'],
  [0x13000, 0x1345f, 'egyptian'],
  [0x1bc00, 0x1bc9f, 'duployan'],
]

/** The script of a letter that binds glue, or null for any other character. */
function glueScript(cp: number | undefined): string | null {
  if (cp === undefined || !isLetter(cp)) return null
  for (const [lo, hi, script] of GLUE_SCRIPT_BLOCKS) if (cp >= lo && cp <= hi) return script
  return null
}

/** Whether `glue` characters among `letters` letters of their script are too many. */
function tooDense(glue: number, letters: number): boolean {
  return glue >= DENSITY_MIN && glue * DENSITY_LETTERS > letters
}

/**
 * The letter-bound glue that is too dense, judged per script, so letters of
 * another script never dilute it. All of a script's glue goes when it is too
 * dense against all of that script's letters; a script with no more than
 * {@link DENSITY_WINDOW} letters is judged that way only. A longer one is also
 * read through every window of {@link DENSITY_WINDOW} of its letters, and the
 * glue inside a window that is too dense goes. Glue whose neighbours belong to
 * no such script is judged against no letters at all. All the glue together
 * is judged against all the letters of every glue script as well, so a train
 * split across scripts goes too.
 */
function denseGlue(cps: readonly number[], letterGlue: readonly number[]): number[] {
  const letters = new Map<string, number[]>()
  cps.forEach((cp, i) => {
    const script = glueScript(cp)
    if (script !== null) pushed(letters, script, i)
  })
  const glue = new Map<string, number[]>()
  for (const index of letterGlue) {
    pushed(glue, glueScript(cps[index - 1]) ?? glueScript(cps[index + 1]) ?? '', index)
  }
  // Spread over several scripts, no one script may reach the minimum, so all
  // of it is also judged against all the letters of every glue script.
  const allLetters = [...letters.values()].reduce((sum, own) => sum + own.length, 0)
  if (tooDense(letterGlue.length, allLetters)) return [...letterGlue]
  const dense: number[] = []
  for (const [script, marks] of glue) {
    const own = letters.get(script) ?? []
    if (tooDense(marks.length, own.length)) {
      dense.push(...marks)
      continue
    }
    if (own.length <= DENSITY_WINDOW) continue
    let lo = 0
    let hi = 0
    let marked = -1
    for (let i = 0; i + DENSITY_WINDOW <= own.length; i += 1) {
      const from = own[i] ?? 0
      const to = own[i + DENSITY_WINDOW - 1] ?? 0
      while (lo < marks.length && (marks[lo] ?? 0) < from) lo += 1
      while (hi < marks.length && (marks[hi] ?? 0) <= to) hi += 1
      if (!tooDense(hi - lo, DENSITY_WINDOW)) continue
      for (let k = Math.max(lo, marked + 1); k < hi; k += 1) dense.push(marks[k] ?? 0)
      marked = Math.max(marked, hi - 1)
    }
  }
  return dense
}

/** Append to the list under `key`, creating it, and return the list. */
function pushed(map: Map<string, number[]>, key: string, value: number): number[] {
  const list = map.get(key)
  if (list === undefined) {
    const created = [value]
    map.set(key, created)
    return created
  }
  list.push(value)
  return list
}

const EMOJI = /^\p{Emoji}$/u
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u

/** Whether VS15 or VS16 after `base` changes how it is drawn. */
function changesPresentation(selector: number, base: number | undefined): boolean {
  if (base === undefined) return false
  const ch = String.fromCodePoint(base)
  const emojiByDefault = EMOJI_PRESENTATION.test(ch)
  return selector === 0xfe0f ? EMOJI.test(ch) && !emojiByDefault : emojiByDefault
}

const LETTER = /^\p{L}$/u

function isLetter(cp: number | undefined): boolean {
  return cp !== undefined && LETTER.test(String.fromCodePoint(cp))
}

function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f
}

function isEmojiSelector(cp: number): boolean {
  return cp === 0xfe0e || cp === 0xfe0f
}

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
}

/** The indices of the tag characters that spell a recommended subdivision flag. */
function rgiFlagTags(cps: readonly number[]): ReadonlySet<number> {
  const kept = new Set<number>()
  for (let i = 0; i < cps.length; i += 1) {
    if (cps[i] !== BLACK_FLAG) continue
    let j = i + 1
    let spelled = ''
    while (j < cps.length && (cps[j] ?? 0) >= 0xe0020 && (cps[j] ?? 0) <= 0xe007e) {
      spelled += String.fromCharCode((cps[j] ?? 0) - 0xe0000)
      j += 1
    }
    if (cps[j] === CANCEL_TAG && RGI_SUBDIVISIONS.has(spelled)) {
      for (let k = i + 1; k <= j; k += 1) kept.add(k)
      i = j
    }
  }
  return kept
}

/**
 * Glue the classifier binds to a letter rather than to an emoji: a joiner with
 * a letter on both sides, or any other bound glue that is neither a variation
 * selector nor a tag character.
 */
function isLetterGlue(cps: readonly number[], hit: ScanHit): boolean {
  if (hit.kind !== 'glue' || hit.flag !== '-a') return false
  const cp = hit.cp
  if (isVariationSelector(cp) || isTag(cp)) return false
  if (cp === ZWJ || cp === ZWNJ) return isLetter(cps[hit.index - 1]) && isLetter(cps[hit.index + 1])
  return true
}

/**
 * What the policy removes from `analysis` on top of the engine's default
 * clean, by codepoint index. `exact` applies the cap for exact fields in
 * place of the density rule for prose.
 */
export function policyDrops(analysis: Analysis, exact = false): Map<number, PolicyCategory> {
  const { cps, hits } = analysis
  const drops = new Map<number, PolicyCategory>()
  const flags = rgiFlagTags(cps)
  const letterGlue: number[] = []
  for (const hit of hits.values()) {
    const cp = hit.cp
    if (isTag(cp)) {
      if (!flags.has(hit.index)) drops.set(hit.index, 'tag-sequence')
    } else if (isVariationSelector(cp)) {
      const bound = hit.kind === 'glue' && hit.flag === '-a'
      if (!(isEmojiSelector(cp) && bound && changesPresentation(cp, cps[hit.index - 1]))) drops.set(hit.index, 'variation-selector')
    } else if (hit.kind === 'bidi-mark') {
      drops.set(hit.index, 'bidi-mark')
    } else if (isLetterGlue(cps, hit)) {
      letterGlue.push(hit.index)
    }
  }
  const dense = exact ? (letterGlue.length > EXACT_GLUE_MAX ? letterGlue : []) : denseGlue(cps, letterGlue)
  for (const index of dense) drops.set(index, 'glue-density')
  return drops
}

/** The finding kinds that draw nothing. */
const INVISIBLE_KINDS: ReadonlySet<string> = new Set([
  'invisible',
  'bidi-override',
  'bidi-mark',
  'glue',
  'format-control',
  'control',
])

/** A supplementary private-use plane: 15 or 16. */
function isPlanePrivateUse(cp: number): boolean {
  return cp >= 0xf0000
}

/**
 * What an exact field (a key, a protocol field, an enum member, `_meta`)
 * loses: every invisible, bidi, format and control character the engine
 * flags, except glue the classifier binds, plus everything
 * {@link policyDrops} removes, plus supplementary private-use characters.
 * Visible characters, private-use ones in the BMP included, stay.
 */
export function exactDrops(analysis: Analysis): Map<number, string> {
  const drops = new Map<number, string>()
  for (const hit of analysis.hits.values()) {
    const boundGlue = hit.kind === 'glue' && hit.flag === '-a'
    if ((INVISIBLE_KINDS.has(hit.kind) && !boundGlue) || (hit.kind === 'private-use' && isPlanePrivateUse(hit.cp))) {
      drops.set(hit.index, hit.kind)
    }
  }
  for (const [index] of policyDrops(analysis, true)) drops.set(index, analysis.hits.get(index)?.kind ?? 'invisible')
  return drops
}

/**
 * Whether a text holds any character that draws nothing, bound glue included:
 * the test for an id the host matches, which must hold none at all.
 */
export function hasHidden(analysis: Analysis): boolean {
  for (const hit of analysis.hits.values()) {
    if (INVISIBLE_KINDS.has(hit.kind) || hit.kind === 'private-use') return true
  }
  return false
}
