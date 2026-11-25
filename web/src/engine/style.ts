/**
 * Prose habits: the port of `style_report.py`.
 *
 * THIS IS NOT A DETECTOR AND EMITS NO PROBABILITY. Detectors such as GPTZero
 * score perplexity and burstiness with a trained classifier; nothing here does
 * anything of the kind. What this measures is the set of habits that make a
 * draft READ as generated: uniform sentence length, uniform paragraph shape,
 * tell-words, stock transitions, em-dash density, "it's not X, it's Y" framing,
 * tricolons, and the absence of specifics, so a writer can edit them out. Every
 * number is computed from the text in front of you.
 *
 * SHAPE: the returned object is the exact JSON `style_report.py --json` prints,
 * snake_case keys and all. That is deliberate. The alternative (camelCase plus
 * a translation layer in the parity test) puts a hand-written mapping between
 * the two implementations, which is precisely where a parity bug would hide.
 *
 * PARITY NOTES, all of which are why this file is longer than the Python:
 *  - Python's `\w`/`\b` are Unicode-aware; JavaScript's are ASCII-only. Every
 *    boundary here is rebuilt from `\p{L}\p{N}_` lookarounds so a Turkish or
 *    Greek draft counts the same words in both implementations.
 *  - Python's `\s` includes U+001C–U+001F and U+0085 and excludes U+FEFF;
 *    JavaScript's does the opposite. The class is spelled out.
 *  - `round()` in Python is round-HALF-EVEN on the exact binary value;
 *    `toFixed` is half-up. `pyRound` below reproduces Python exactly, because a
 *    mean of 12.25 rounding to 12.3 instead of 12.2 is a visible parity failure.
 */

// ---------------------------------------------------------------------------
// Python-compatible primitives
// ---------------------------------------------------------------------------

/** Character-class BODY for Python's `\w` (`str.isalnum()` plus underscore). */
const WORD_CLASS = '\\p{L}\\p{N}_'
/** One word character. */
const W = `[${WORD_CLASS}]`
/** Python's `\b`, rebuilt so it is Unicode-aware in JavaScript too. */
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
/** Character-class BODY for Python's `\s`. */
const SPACE_CLASS = ' \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
/** Python's `\s` and `\S`. */
const S = `[${SPACE_CLASS}]`
const NS = `[^${SPACE_CLASS}]`
/** Python's `\d` for str patterns: Unicode decimal digits. */
const D = '\\p{Nd}'
/** Python's `^` and `$` under `re.MULTILINE` (JavaScript's also break on \r). */
const LINE_START = '(?<![^\\n])'
const LINE_END = '(?![^\\n])'

/** Python's `str.strip()`: see `html.ts` for why this is not `String.trim()`. */
const PY_STRIP_CHARS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
])

function pythonStrip(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && PY_STRIP_CHARS.has(text.charCodeAt(start))) start += 1
  while (end > start && PY_STRIP_CHARS.has(text.charCodeAt(end - 1))) end -= 1
  return text.slice(start, end)
}

/** Escape a literal for embedding in a RegExp source (Unicode mode: no `\-`). */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- exact decimal rounding ------------------------------------------------

/** Split a finite non-negative double into `mantissa × 2^exponent`, exactly. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const bits = (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4))
  const exponentBits = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & 0xfffffffffffffn
  if (exponentBits === 0) return { mantissa: fraction, exponent: -1074 }
  return { mantissa: fraction | (1n << 52n), exponent: exponentBits - 1075 }
}

/**
 * `round(x * 10^digits)` with ties going to the even neighbour, computed on the
 * EXACT value of the double rather than on a decimal approximation of it.
 * This is what makes `pyRound(12.25, 1) === 12.2` instead of 12.3.
 */
function scaledHalfEven(x: number, digits: number): bigint {
  let { mantissa, exponent } = decompose(x)
  if (mantissa === 0n) return 0n
  while (exponent < 0 && (mantissa & 1n) === 0n) {
    mantissa >>= 1n
    exponent += 1
  }
  const pow10 = 10n ** BigInt(digits)
  if (exponent >= 0) return mantissa * (1n << BigInt(exponent)) * pow10
  const k = BigInt(-exponent)
  // x = mantissa / 2^k, so x·10^digits = mantissa·5^k·10^digits / 10^k.
  const numerator = mantissa * 5n ** k * pow10
  const denominator = 10n ** k
  const quotient = numerator / denominator
  const remainder = (numerator % denominator) * 2n
  if (remainder > denominator) return quotient + 1n
  if (remainder < denominator) return quotient
  return (quotient & 1n) === 0n ? quotient : quotient + 1n
}

/** Python's `round(x, digits)`. */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x
  const negative = x < 0
  const scaled = scaledHalfEven(Math.abs(x), digits)
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return x
  const value = Number(scaled) / Number(10n ** BigInt(digits))
  return negative ? -value : value
}

/** Python's `f"{x:.Nf}"`. */
function pyFormatFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x)
  const sign = x < 0 ? '-' : ''
  const scaled = scaledHalfEven(Math.abs(x), digits).toString()
  if (digits === 0) return sign + scaled
  const padded = scaled.padStart(digits + 1, '0')
  const cut = padded.length - digits
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`
}

/**
 * Python's `str(float)`. JavaScript prints `12` where Python prints `12.0`, and
 * these values are interpolated into observation text that the parity test
 * compares character for character.
 */
export function pyFloatText(x: number): string {
  const text = String(x)
  return text.includes('.') || text.includes('e') || text.includes('E') ? text : `${text}.0`
}

// --- counters --------------------------------------------------------------

/**
 * `collections.Counter.most_common()`: descending by count, ties in insertion
 * order. `Array.prototype.sort` has been stable since ES2019, which is exactly
 * the guarantee that makes those two statements the same statement.
 */
function mostCommon(counts: ReadonlyMap<string, number>): [string, number][] {
  const items = [...counts.entries()]
  items.sort((a, b) => b[1] - a[1])
  return items
}

/** `Counter.__add__`: self's keys first, then the other's new keys. */
function addCounters(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map(left)
  for (const [key, value] of right) out.set(key, (out.get(key) ?? 0) + value)
  return out
}

function toRecord(counts: Iterable<readonly [string, number]>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of counts) out[key] = value
  return out
}

function countMatches(text: string, pattern: RegExp): number {
  let n = 0
  for (const _match of text.matchAll(pattern)) n += 1
  return n
}

function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return n
    n += 1
    from = at + needle.length
  }
}

/**
 * Python's `text[-n:]`: the last `n` CODEPOINTS.
 *
 * `String.prototype.slice(-n)` counts UTF-16 CODE UNITS, so every astral
 * character in the tail (emoji, mathematical alphanumerics: exactly the styled
 * text this tool exists for, CJK ext-B, musical symbols) halves the window.
 * The sign-off test below looks for `in conclusion` inside 400 characters of the
 * end; on a draft ending in emoji the JavaScript window could be half the
 * Python one and the phrase falls outside it.
 *
 * The `2 * n` pre-slice keeps this O(n) rather than O(length): `2n` code units
 * always contain at least `n` codepoints, so dropping a leading half-surrogate
 * pair (which the spread yields as a lone surrogate, exactly as Python would
 * keep it) can never eat into the `n` we return.
 */
function lastCodepoints(text: string, n: number): string {
  const window = text.length <= 2 * n ? text : text.slice(-2 * n)
  return [...window].slice(-n).join('')
}

// ---------------------------------------------------------------------------
// Lexicon: transcribed from style_report.py, order preserved
// ---------------------------------------------------------------------------

/**
 * Words heavily over-represented in LLM prose relative to human writing, from
 * published corpus comparisons of pre/post-2023 text. Presence proves nothing;
 * DENSITY is the measurement.
 */
const TELL_WORDS = [
  'delve', 'delves', 'delving', 'tapestry', 'testament', 'landscape', 'navigate',
  'navigating', 'crucial', 'robust', 'leverage', 'leveraging', 'foster', 'fostering',
  'underscore', 'underscores', 'pivotal', 'multifaceted', 'realm', 'embark', 'unlock',
  'harness', 'seamless', 'seamlessly', 'holistic', 'elevate', 'resonate', 'intricate',
  'nuanced', 'meticulous', 'meticulously', 'vibrant', 'paramount', 'comprehensive',
  'streamline', 'transformative', 'groundbreaking', 'cutting-edge', 'ever-evolving',
  'game-changer', 'showcase', 'showcasing', 'myriad', 'plethora', 'utilize',
  'facilitate', 'endeavor', 'commendable', 'invaluable', 'unwavering', 'captivate',
  'captivating', 'enhance', 'enhancing', 'empower', 'empowering', 'innovative',
  'dynamic', 'synergy', 'bustling', 'beacon', 'journey', 'unleash', 'revolutionize',
] as const

const TELL_PHRASES = [
  "in today's", 'in the ever-evolving', "it's important to note", 'it is important to note',
  "it's worth noting", 'it is worth noting', 'in conclusion', 'in summary', 'to summarize',
  'ultimately,', 'furthermore,', 'moreover,', 'additionally,', 'that being said',
  'at the end of the day', 'plays a crucial role', 'plays a vital role', 'a wide range of',
  'a variety of', 'dive into', "let's explore", "let's dive", 'as an ai', 'in the realm of',
  'when it comes to', 'a testament to', 'the importance of', 'it is essential to',
  "it's essential to", 'not only', 'serves as a', 'in order to', 'look no further',
  "whether you're", "here's the thing", 'the bottom line', 'in a world where',
  'as we navigate', 'the world of', 'rich tapestry', 'shed light on', 'stands as',
  'i hope this helps', 'feel free to', 'certainly!', 'great question',
] as const

const TRANSITIONS = [
  'furthermore', 'moreover', 'additionally', 'however', 'therefore', 'thus',
  'consequently', 'in addition', 'on the other hand', 'nevertheless',
  'nonetheless', 'ultimately', 'overall', 'in essence', 'importantly',
] as const

const HEDGES = [
  'may', 'might', 'can', 'could', 'often', 'generally', 'typically', 'tend to',
  'tends to', 'in many cases', 'it is possible', 'potentially', 'arguably',
  'to some extent', 'in some ways', 'various', 'numerous', 'several',
] as const

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'u.s', 'u.k', 'no', 'fig', 'inc', 'ltd', 'co', 'approx', 'dept',
])

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const NOT_X_BUT_Y_RE = new RegExp(
  `${B}(?:it'?s|this is|that'?s|isn'?t|is not|not just|not only|not merely|not simply)${B}` +
    `[^.!?\\n]{2,80}?${B}(?:but|it'?s|rather|instead)${B}`,
  'giu',
)
const TRICOLON_RE = new RegExp(
  `${B}${W}[${WORD_CLASS}'-]*,${S}+${W}[${WORD_CLASS}'-]*,?${S}+(?:and|or)${S}+${W}[${WORD_CLASS}'-]*${B}`,
  'gu',
)
const CONTRACTION_RE = new RegExp(`${B}${W}+'(?:t|s|re|ve|ll|d|m)${B}`, 'giu')
const FIRST_PERSON_RE = new RegExp(
  `${B}(?:I|I'm|I've|I'd|I'll|me|my|mine|we|we're|we've|our|us)${B}`,
  'gu',
)
const NUMBER_RE = new RegExp(`${B}${D}[${D},.]*%?${B}`, 'gu')
/**
 * A capitalized word right after a lowercase one: a cheap proper-noun proxy.
 *
 * The trailing boundary is `B`, not `\b`, for the reason stated at the top of
 * this file: JavaScript's `\b` is ASCII-only. `[a-z,;]`, `[A-Z]` and `[a-z]` are
 * deliberately ASCII in the Python too and stay literal, but the boundary is
 * not: Python treats `é`, Cyrillic and Greek as word characters, so
 * `Renée` yields NO match there while a raw `\b` here would match the prefix
 * `Ren`. That difference inflates `proper_nouns_per_1000` on any draft full of
 * accented names and silently suppresses the "no specifics" observation, which
 * is gated on `properNouns < 5`.
 */
const PROPER_RE = new RegExp(`(?<=[a-z,;] )[A-Z][a-z]{2,}${B}`, 'gu')
const BULLET_RE = new RegExp(`${LINE_START}${S}*(?:[-*•]|${D}+[.)])${S}+`, 'gmu')
const HEADING_RE = new RegExp(
  `${LINE_START}${S}*#{1,6}${S}+${NS}|${LINE_START}[A-Z][^\\n]{2,60}:${S}*${LINE_END}`,
  'gmu',
)
/** `**Term:** text`, `**Term**: text`, `**Term** — text`, optionally bulleted. */
const BOLD_LEAD_RE = new RegExp(
  `${LINE_START}${S}*(?:[-*•]${S}+|${D}+[.)]${S}+)?\\*\\*[^*\\n]{2,60}?(?::\\*\\*|\\*\\*${S}*[:—–-])`,
  'gmu',
)
const CONCLUSION_RE = new RegExp(`${B}in (?:conclusion|summary)${B}`, 'u')

const PARAGRAPH_SPLIT_RE = new RegExp(`\\n${S}*\\n`, 'u')
const WHITESPACE_RUN_RE = new RegExp(`${S}+`, 'gu')
const SENTENCE_END_RE = new RegExp(`[.!?]+(?=${S}+["'“(]?[A-Z0-9]|${S}*$)`, 'gu')
const LAST_WORD_RE = new RegExp(`(${W}[${WORD_CLASS}.]*)[.!?]+$`, 'u')
const HAS_WORD_RE = new RegExp(W, 'u')
const WORD_RUN_RE = new RegExp(`${B}[${WORD_CLASS}'-]+${B}`, 'gu')
const LEADING_QUOTE_CHARS = new Set(['"', "'", '“', '('])

const TELL_WORD_PATTERNS: readonly (readonly [string, RegExp])[] = TELL_WORDS.map((word) => [
  word,
  new RegExp(`${B}${escapeLiteral(word)}${B}`, 'gu'),
])
const HEDGE_PATTERNS: readonly RegExp[] = HEDGES.map(
  (hedge) => new RegExp(`${B}${escapeLiteral(hedge)}${B}`, 'gu'),
)

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/** Port of `style_report.paragraphs`. */
export function paragraphs(text: string): string[] {
  return text
    .split(PARAGRAPH_SPLIT_RE)
    .map((part) => pythonStrip(part))
    .filter((part) => part !== '')
}

/**
 * Port of `style_report.sentences`: forgiving of abbreviations and decimals.
 * A terminator only ends a sentence when what follows looks like a new one, and
 * "Dr." / "e.g." never do.
 */
export function sentences(paragraph: string): string[] {
  const flat = pythonStrip(paragraph.replace(WHITESPACE_RUN_RE, ' '))
  const out: string[] = []
  let start = 0
  for (const match of flat.matchAll(SENTENCE_END_RE)) {
    const end = match.index + match[0].length
    const previous = flat.slice(start, end)
    const last = LAST_WORD_RE.exec(previous)
    if (last !== null && ABBREV.has((last[1] ?? '').toLowerCase().replace(/\.+$/, ''))) continue
    out.push(pythonStrip(previous))
    start = end
  }
  const tail = pythonStrip(flat.slice(start))
  if (tail !== '') out.push(tail)
  return out.filter((sentence) => HAS_WORD_RE.test(sentence))
}

/** Port of `style_report.word_count`. */
export function wordCount(sentence: string): number {
  return countMatches(sentence, WORD_RUN_RE)
}

/** Port of `style_report.per_k`. */
function perThousand(n: number, words: number): number {
  return words !== 0 ? pyRound((1000 * n) / words, 1) : 0
}

/**
 * Population standard deviation. Computed as `(n·Σx² − (Σx)²) / n²` on integer
 * inputs so the only floating-point rounding is the final division: the same
 * guarantee CPython's `statistics` gets from its exact-Fraction path.
 */
function populationStdev(values: readonly number[]): number {
  const n = values.length
  if (n === 0) return 0
  let sum = 0
  let sumSquares = 0
  for (const value of values) {
    sum += value
    sumSquares += value * value
  }
  return Math.sqrt(Math.max((n * sumSquares - sum * sum) / (n * n), 0))
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

// ---------------------------------------------------------------------------
// Report shape: the JSON `style_report.py --json` prints
// ---------------------------------------------------------------------------

export const STYLE_SEVERITIES = ['high', 'medium', 'low'] as const
export type StyleSeverity = (typeof STYLE_SEVERITIES)[number]

export interface StyleObservation {
  readonly severity: StyleSeverity
  /** Short label, e.g. `uniform sentence length`. */
  readonly title: string
  /** One or two sentences saying what to change. */
  readonly detail: string
}

export const HISTOGRAM_BUCKETS = ['1-8', '9-15', '16-25', '26-40', '41+'] as const
export type HistogramBucket = (typeof HISTOGRAM_BUCKETS)[number]

export interface SentenceLengthStats {
  readonly mean: number
  readonly stdev: number
  /** Coefficient of variation: the burstiness number, and the headline signal. */
  readonly cv: number
  readonly min: number
  readonly max: number
  readonly histogram: Record<HistogramBucket, number>
}

export interface ParagraphShapeStats {
  readonly sentences_per_paragraph_mean: number
  readonly stdev: number
}

export interface StyleReport {
  readonly words: number
  readonly sentences: number
  readonly paragraphs: number
  readonly observations: readonly StyleObservation[]
  /** Absent for a text with fewer than two sentences. */
  readonly sentence_length?: SentenceLengthStats
  /** Absent for a text with fewer than four paragraphs. */
  readonly paragraph_shape?: ParagraphShapeStats
  readonly tell_words: Record<string, number>
  readonly tell_phrases: Record<string, number>
  readonly tell_density_per_1000: number
  readonly sentence_initial_transitions: Record<string, number>
  readonly em_dashes_per_1000: number
  readonly not_x_but_y: number
  readonly tricolons: number
  readonly hedges_per_1000: number
  readonly bullets: number
  readonly headings: number
  readonly bold_lead_bullets: number
  readonly contractions_per_1000: number
  readonly first_person_per_1000: number
  readonly numbers_per_1000: number
  readonly proper_nouns_per_1000: number
  readonly summary: Record<StyleSeverity, number>
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

function bucketFor(n: number): HistogramBucket {
  if (n <= 8) return '1-8'
  if (n <= 15) return '9-15'
  if (n <= 25) return '16-25'
  if (n <= 40) return '26-40'
  return '41+'
}

function topTellsText(combined: ReadonlyMap<string, number>): string {
  return mostCommon(combined)
    .slice(0, 6)
    .map(([key, value]) => `${key}×${value}`)
    .join(', ')
}

/** Port of `style_report.analyze`. Returns the same JSON, key for key. */
export function analyzeStyle(text: string): StyleReport {
  const pars = paragraphs(text)
  const sents = pars.flatMap((paragraph) => sentences(paragraph))
  const lens = sents.map((sentence) => wordCount(sentence))
  const words = lens.reduce((total, n) => total + n, 0)
  const low = text.toLowerCase()

  const observations: StyleObservation[] = []

  // -- sentence length / burstiness
  let sentenceLength: SentenceLengthStats | null = null
  if (lens.length >= 2) {
    const lensMean = mean(lens)
    const stdev = populationStdev(lens)
    const cv = lensMean !== 0 ? stdev / lensMean : 0
    const buckets = new Map<HistogramBucket, number>()
    for (const n of lens) {
      const bucket = bucketFor(n)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
    const histogram: Record<HistogramBucket, number> = {
      '1-8': buckets.get('1-8') ?? 0,
      '9-15': buckets.get('9-15') ?? 0,
      '16-25': buckets.get('16-25') ?? 0,
      '26-40': buckets.get('26-40') ?? 0,
      '41+': buckets.get('41+') ?? 0,
    }
    sentenceLength = {
      mean: pyRound(lensMean, 1),
      stdev: pyRound(stdev, 1),
      cv: pyRound(cv, 2),
      min: Math.min(...lens),
      max: Math.max(...lens),
      histogram,
    }
    if (lens.length >= 5) {
      if (cv < 0.35) {
        observations.push({
          severity: 'high',
          title: 'uniform sentence length',
          detail:
            `sentences average ${pyFormatFixed(lensMean, 0)} words with very little variation ` +
            `(cv ${pyFormatFixed(cv, 2)}). Human prose usually mixes very short and long ` +
            `sentences; this is the single strongest 'generated' signal.`,
        })
      } else if (cv < 0.5) {
        observations.push({
          severity: 'medium',
          title: 'fairly uniform sentence length',
          detail: `cv ${pyFormatFixed(cv, 2)}; a few deliberately short or long sentences would help.`,
        })
      }
      if (histogram['1-8'] === 0) {
        observations.push({
          severity: 'medium',
          title: 'no short sentences',
          detail: 'not one sentence under nine words. Add a punchy one.',
        })
      }
    }
  }

  // -- paragraph shape
  const perPar = pars.map((paragraph) => sentences(paragraph).length)
  let paragraphShape: ParagraphShapeStats | null = null
  if (perPar.length >= 4) {
    const parStdev = populationStdev(perPar)
    paragraphShape = {
      sentences_per_paragraph_mean: pyRound(mean(perPar), 1),
      stdev: pyRound(parStdev, 1),
    }
    if (parStdev < 0.8) {
      observations.push({
        severity: 'medium',
        title: 'uniform paragraph shape',
        detail:
          `every paragraph has about ${pyFormatFixed(mean(perPar), 0)} sentences. ` +
          'Generated drafts are metronomic; let one paragraph run long and one be a line.',
      })
    }
  }

  // -- tells
  const tellWordCounts = new Map<string, number>()
  for (const [word, pattern] of TELL_WORD_PATTERNS) {
    const n = countMatches(low, pattern)
    if (n > 0) tellWordCounts.set(word, n)
  }
  const tellPhraseCounts = new Map<string, number>()
  for (const phrase of TELL_PHRASES) {
    const n = countOccurrences(low, phrase)
    if (n > 0) tellPhraseCounts.set(phrase, n)
  }
  const tellTotal =
    [...tellWordCounts.values()].reduce((a, b) => a + b, 0) +
    [...tellPhraseCounts.values()].reduce((a, b) => a + b, 0)
  const tellDensity = perThousand(tellTotal, words)
  if (words >= 80) {
    const combined = addCounters(tellWordCounts, tellPhraseCounts)
    if (tellDensity >= 12) {
      observations.push({
        severity: 'high',
        title: 'dense LLM vocabulary',
        detail:
          `${tellTotal} tell-words/phrases in ${words} words ` +
          `(${pyFloatText(tellDensity)}/1000): ${topTellsText(combined)}`,
      })
    } else if (tellDensity >= 5) {
      observations.push({
        severity: 'medium',
        title: 'noticeable LLM vocabulary',
        detail: topTellsText(combined),
      })
    }
  }

  // -- transitions at sentence start
  const starts = new Map<string, number>()
  for (const sentence of sents) {
    let head = sentence.toLowerCase()
    let cut = 0
    while (cut < head.length && LEADING_QUOTE_CHARS.has(head.charAt(cut))) cut += 1
    head = head.slice(cut)
    for (const transition of TRANSITIONS) {
      if (head.startsWith(transition)) starts.set(transition, (starts.get(transition) ?? 0) + 1)
    }
  }
  const startsTotal = [...starts.values()].reduce((a, b) => a + b, 0)
  if (sents.length > 0 && startsTotal / sents.length >= 0.15 && startsTotal >= 3) {
    observations.push({
      severity: 'medium',
      title: 'stock transitions',
      detail:
        `${startsTotal} of ${sents.length} sentences open with ` +
        `${[...starts.keys()].join('/')}. Cut most; the logic usually survives without them.`,
    })
  }

  // -- punctuation habits
  const emDashes = countOccurrences(text, '—') + countOccurrences(text, '–')
  const emDashDensity = perThousand(emDashes, words)
  if (words >= 80 && emDashes >= 4 && emDashDensity >= 15) {
    observations.push({
      severity: 'medium',
      title: 'em-dash habit',
      detail:
        `${emDashes} dashes in ${words} words — one every ${Math.floor(words / emDashes)} ` +
        'words. Humans use them; models lean on them. Replace most with commas, colons or ' +
        'full stops.',
    })
  }
  const notXButY = countMatches(text, NOT_X_BUT_Y_RE)
  if (notXButY >= 2) {
    observations.push({
      severity: 'high',
      title: "'it's not X, it's Y' framing",
      detail:
        `${notXButY} instances. This contrast template is one of the most ` +
        'recognizable generated rhythms.',
    })
  }
  const tricolons = countMatches(text, TRICOLON_RE)
  if (sents.length > 0 && tricolons / sents.length >= 0.25 && tricolons >= 3) {
    observations.push({
      severity: 'medium',
      title: 'tricolon habit',
      detail: `${tricolons} three-item lists ('a, b, and c'). Vary to two or four, or drop the list.`,
    })
  }
  let hedges = 0
  for (const pattern of HEDGE_PATTERNS) hedges += countMatches(low, pattern)
  const hedgeDensity = perThousand(hedges, words)
  if (words >= 80 && hedgeDensity >= 25) {
    observations.push({
      severity: 'low',
      title: 'heavy hedging',
      detail: `${hedges} hedges (may/might/often/typically/various…). Commit to claims.`,
    })
  }

  // -- structure
  const bullets = countMatches(text, BULLET_RE)
  const headings = countMatches(text, HEADING_RE)
  const boldLeads = countMatches(text, BOLD_LEAD_RE)
  if (boldLeads >= 3) {
    observations.push({
      severity: 'high',
      title: "'**Term:** explanation' bullets",
      detail: `${boldLeads} bold-lead bullets. This exact shape is a chatbot default.`,
    })
  }
  if (pars.length > 0 && bullets >= 6 && bullets >= pars.length) {
    observations.push({
      severity: 'medium',
      title: 'bullet-heavy',
      detail: `${bullets} bullets across ${pars.length} paragraphs. Prose that should be prose.`,
    })
  }
  const tail = lastCodepoints(low, 400)
  if (CONCLUSION_RE.test(tail) || tail.includes('to summarize')) {
    observations.push({
      severity: 'medium',
      title: 'summarizing sign-off',
      detail:
        "the text ends with 'In conclusion / In summary'. Essays for teachers end " +
        'that way; almost nothing else does.',
    })
  }

  // -- specificity / voice (the ABSENCE of these is the signal)
  const contractions = perThousand(countMatches(text, CONTRACTION_RE), words)
  const firstPerson = perThousand(countMatches(text, FIRST_PERSON_RE), words)
  const numbers = perThousand(countMatches(text, NUMBER_RE), words)
  const properNouns = perThousand(countMatches(text, PROPER_RE), words)
  if (words >= 150) {
    if (contractions === 0) {
      observations.push({
        severity: 'low',
        title: 'no contractions',
        detail:
          'zero contractions in the whole text: reads formal-generic. Fine for a ' +
          'legal brief; a tell in a blog post or essay.',
      })
    }
    if (numbers < 3 && properNouns < 5) {
      observations.push({
        severity: 'medium',
        title: 'no specifics',
        detail:
          'almost no numbers, names or places. Generated text is generic by ' +
          'construction; one concrete detail per paragraph changes the read entirely.',
      })
    }
    if (firstPerson === 0) {
      observations.push({
        severity: 'low',
        title: 'no first person',
        detail:
          'no I/we anywhere. Not wrong, but a stance or an experience is the ' +
          'cheapest way to sound like a person.',
      })
    }
  }

  const summary: Record<StyleSeverity, number> = { high: 0, medium: 0, low: 0 }
  for (const observation of observations) summary[observation.severity] += 1

  // Key order mirrors the Python dict, so a copied `--json` payload from either
  // implementation diffs cleanly against the other.
  return {
    words,
    sentences: sents.length,
    paragraphs: pars.length,
    observations,
    ...(sentenceLength !== null ? { sentence_length: sentenceLength } : {}),
    ...(paragraphShape !== null ? { paragraph_shape: paragraphShape } : {}),
    tell_words: toRecord(mostCommon(tellWordCounts)),
    tell_phrases: toRecord(mostCommon(tellPhraseCounts)),
    tell_density_per_1000: tellDensity,
    sentence_initial_transitions: toRecord(starts),
    em_dashes_per_1000: emDashDensity,
    not_x_but_y: notXButY,
    tricolons,
    hedges_per_1000: hedgeDensity,
    bullets,
    headings,
    bold_lead_bullets: boldLeads,
    contractions_per_1000: contractions,
    first_person_per_1000: firstPerson,
    numbers_per_1000: numbers,
    proper_nouns_per_1000: properNouns,
    summary,
  }
}
