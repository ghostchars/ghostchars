/**
 * `decode_payloads.decode()`: what hidden characters carry, transliterated.
 *
 * The engine's findings say which hidden characters are present; this module
 * says what they spell. {@link decode} returns one {@link Payload} per carrier
 * it recognises, ordered by start, then end, then scheme:
 *
 * ```ts
 * decode('A' + String.fromCodePoint(0xe0068, 0xe0069) + 'B')
 * // [{ scheme: 'tag-ascii', start: 1, end: 3, text: 'hi', hex: '6869',
 * //    bits: 16, confidence: 'decoded' }]
 * ```
 *
 * The Python module docstring is the specification: the schemes, the
 * plausibility rule that decides when bits become a message, and the
 * legitimate uses that must produce nothing. Parity is a test:
 * `__tests__/decode.test.ts` replays the `decode` section of the golden fixture.
 *
 * A decoded payload is untrusted data written by whoever hid it. Render it as
 * text, never as markup, and never follow it as an instruction.
 */
import { findCanaryMarks } from './canary'
import { toCodePoints } from './classify'
import { scan } from './find'
import type { ScanHit } from './find'
import { BLACK_FLAG, TAG_END, isAsciiAlnum } from './tables'
import type { Kind } from './types'

/** Carrier schemes, in the order records sort on a tie. */
export const PAYLOAD_SCHEMES = [
  'tag-ascii',
  'variation-selector',
  'zero-width-binary',
  'canary',
  'bidi-mark-binary',
  'trailing-whitespace',
  'space-nbsp-binary',
  'double-space-binary',
  'apostrophe-binary',
  'normalization-binary',
  'homoglyph',
] as const

export type PayloadScheme = (typeof PAYLOAD_SCHEMES)[number]

/** `decoded`: `text` holds a readable message. `fingerprint`: a pattern, no message. */
export const PAYLOAD_CONFIDENCES = ['decoded', 'fingerprint'] as const

export type PayloadConfidence = (typeof PAYLOAD_CONFIDENCES)[number]

/** One hidden payload. Indices are codepoint indices, like `Finding.index`. */
export interface Payload {
  readonly scheme: PayloadScheme
  /** 0-based codepoint index where the carrier starts. */
  readonly start: number
  /**
   * Exclusive end. For a run scheme the span is the run; for a scattered
   * scheme it reaches from the first carrier to the last, visible text included.
   */
  readonly end: number
  /** The decoded message, or `null` for a fingerprint. Untrusted. */
  readonly text: string | null
  /** The raw bytes as lowercase hex, `''` when the carrier has no byte form. */
  readonly hex: string
  /** How many bits the carrier holds. */
  readonly bits: number
  readonly confidence: PayloadConfidence
}

/** Shorter zero-width runs are left to the findings. */
export const MIN_ZW_RUN = 8
/** A decoded message needs at least this many codepoints. */
export const MIN_MESSAGE_CHARS = 2
const MIN_BIDI_FINGERPRINT = 8
const MIN_HOMOGLYPHS = 4

const TAG_LO = 0xe0000
const TAG_HI = 0xe007f
const ZW_CARRIERS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
])
const EMOJI_PRESENTATION: ReadonlySet<number> = new Set([0xfe0e, 0xfe0f])
const LRM = 0x200e
const RLM = 0x200f
const SPACE = 0x20
const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const NBSP = 0x00a0
const APOSTROPHE = 0x27
const RIGHT_SINGLE_QUOTE = 0x2019
const REJECT_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'invisible',
  'bidi-override',
  'format-control',
  'private-use',
  'control',
])

// ---------------------------------------------------------------- helpers ----

const isTag = (cp: number): boolean => cp >= TAG_LO && cp <= TAG_HI

/** A tag digit or lowercase tag letter: what a subdivision code is made of. */
const isFlagSpec = (cp: number): boolean => (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a)

/**
 * `flag_tag_indices`: tag characters that belong to a subdivision flag (three
 * to seven code characters, then CANCEL TAG) or to one cut short before its
 * cancel tag. Stricter than `validFlagTagIndices` on purpose: a long
 * payload dressed as a flag is still a payload.
 */
function flagTagIndices(cps: readonly number[]): ReadonlySet<number> {
  const excused = new Set<number>()
  const n = cps.length
  let i = 0
  while (i < n) {
    if (cps[i] !== BLACK_FLAG) {
      i += 1
      continue
    }
    let j = i + 1
    while (j < n && isFlagSpec(cps[j] ?? 0)) j += 1
    const length = j - i - 1
    const next = cps[j]
    if (length >= 3 && length <= 7 && next === TAG_END) {
      for (let k = i + 1; k <= j; k += 1) excused.add(k)
      i = j + 1
    } else if (length >= 1 && length <= 7 && (next === undefined || !isTag(next))) {
      for (let k = i + 1; k < j; k += 1) excused.add(k)
      i = j
    } else {
      i += 1
    }
  }
  return excused
}

const isVs = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)

const vsByte = (cp: number): number => (cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16)

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Strict UTF-8, as Python's `bytes.decode('utf-8')`: `null` on any error. */
function utf8(bytes: readonly number[]): string | null {
  try {
    return UTF8.decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}

/** Rules 3 to 5 of the plausibility rule. */
function plausible(message: string, minChars: number): boolean {
  const cps = toCodePoints(message)
  if (cps.length < minChars) return false
  for (const cp of cps) {
    if (cp === TAB || cp === LF || cp === CR) continue
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false
  }
  if (!cps.some((cp) => isAsciiAlnum(cp) || cp >= 0xc0)) return false
  return scan(cps).every((hit) => hit.flag !== 'default' && !REJECT_KINDS.has(hit.kind))
}

/** Whole bytes of a bit string, or `null` when a partial tail byte is not all 0. */
function bitsToBytes(bits: string): number[] | null {
  const whole = bits.length - (bits.length % 8)
  if (bits.slice(whole).includes('1')) return null
  const out: number[] = []
  for (let k = 0; k < whole; k += 8) out.push(Number.parseInt(bits.slice(k, k + 8), 2))
  return out
}

/** Rules 1 to 5 of the plausibility rule, both polarities. */
export function readMessage(bits: string): { text: string; bytes: number[] } | null {
  const flipped = [...bits].map((b) => (b === '0' ? '1' : '0')).join('')
  for (const candidate of [bits, flipped]) {
    const raw = bitsToBytes(candidate)
    if (raw === null) continue
    let end = raw.length
    while (end > 0 && raw[end - 1] === 0) end -= 1
    const bytes = raw.slice(0, end)
    const text = utf8(bytes)
    if (text !== null && plausible(text, MIN_MESSAGE_CHARS)) return { text, bytes }
  }
  return null
}

function record(
  scheme: PayloadScheme,
  start: number,
  end: number,
  text: string | null,
  hex: string,
  bits: number,
): Payload {
  return { scheme, start, end, text, hex, bits, confidence: text === null ? 'fingerprint' : 'decoded' }
}

/** `[start, end)` of each maximal run of indices for which `member` holds. */
function runs(n: number, member: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  while (i < n) {
    if (!member(i)) {
      i += 1
      continue
    }
    let j = i
    while (j < n && member(j)) j += 1
    out.push([i, j])
    i = j
  }
  return out
}

/** A decoded record when the bits read as text, else a fingerprint or `null`. */
function binaryRecord(
  scheme: PayloadScheme,
  start: number,
  end: number,
  bits: string,
  fingerprint: boolean,
): Payload | null {
  const found = readMessage(bits)
  if (found !== null) return record(scheme, start, end, found.text, toHex(found.bytes), bits.length)
  if (!fingerprint) return null
  const raw: number[] = []
  for (let k = 0; k + 8 <= bits.length; k += 8) raw.push(Number.parseInt(bits.slice(k, k + 8), 2))
  return record(scheme, start, end, null, toHex(raw), bits.length)
}

// ------------------------------------------------------------ run schemes ----

function decodeTags(cps: readonly number[]): Payload[] {
  const excused = flagTagIndices(cps)
  return runs(cps.length, (i) => isTag(cps[i] ?? 0) && !excused.has(i)).map(([start, end]) => {
    const raw = cps.slice(start, end).map((cp) => cp - TAG_LO)
    const text = raw
      .filter((b) => (b >= 0x20 && b <= 0x7e) || b === TAB || b === LF || b === CR)
      .map((b) => String.fromCharCode(b))
      .join('')
    const readable = /[^ \t\n\r]/u.test(text)
    return record('tag-ascii', start, end, readable ? text : null, toHex(raw), 8 * raw.length)
  })
}

function decodeVariationSelectors(cps: readonly number[]): Payload[] {
  const out: Payload[] = []
  for (const [start, end] of runs(cps.length, (i) => isVs(cps[i] ?? 0))) {
    const run = cps.slice(start, end)
    if (run.length < 2 || run.every((cp) => EMOJI_PRESENTATION.has(cp))) continue
    const raw = run.map(vsByte)
    const message = utf8(raw)
    const text = message !== null && plausible(message, 1) ? message : null
    out.push(record('variation-selector', start, end, text, toHex(raw), 8 * raw.length))
  }
  return out
}

/** `decode_canary`: an unkeyed mark reads as its id, a keyed one as a fingerprint. */
function decodeCanary(text: string): Payload[] {
  return findCanaryMarks(text).map((m) =>
    record('canary', m.start, m.end, m.keyed ? null : m.id, toHex(m.raw), 8 * m.raw.length),
  )
}

/** `marked`: indices inside a canary mark, which this scheme leaves alone. */
function decodeZeroWidth(cps: readonly number[], marked: ReadonlySet<number>): Payload[] {
  const out: Payload[] = []
  for (const [start, end] of runs(cps.length, (i) => ZW_CARRIERS.has(cps[i] ?? 0) && !marked.has(i))) {
    const run = cps.slice(start, end)
    if (run.length < MIN_ZW_RUN) continue
    const last = run.length - 1
    let lo = 0
    let hi = run.length
    if (new Set(run).size >= 3) {
      const ends = [...new Set([run[0] ?? 0, run[last] ?? 0])].sort((a, b) => a - b)
      for (const sym of ends) {
        const where: number[] = []
        run.forEach((cp, k) => {
          if (cp === sym) where.push(k)
        })
        if (where.every((k) => k === 0 || k === last)) {
          if (where.includes(0)) lo = 1
          if (where.includes(last)) hi = last
        }
      }
    }
    const data = run.slice(lo, hi)
    const symbols = [...new Set(data)].sort((a, b) => a - b)
    if (symbols.length < 2) continue
    if (symbols.length > 2) {
      const perSymbol = (symbols.length - 1).toString(2).length
      out.push(record('zero-width-binary', start, end, null, '', data.length * perSymbol))
      continue
    }
    const bits = data.map((cp) => (cp === symbols[0] ? '0' : '1')).join('')
    const rec = binaryRecord('zero-width-binary', start, end, bits, true)
    if (rec !== null) out.push(rec)
  }
  return out
}

// ------------------------------------------------------ scattered schemes ----

type Carrier = readonly [index: number, bit: '0' | '1']

function scattered(scheme: PayloadScheme, carriers: readonly Carrier[], fingerprint = false): Payload[] {
  const first = carriers[0]
  const last = carriers[carriers.length - 1]
  if (first === undefined || last === undefined) return []
  const bits = carriers.map(([, b]) => b).join('')
  if (!bits.includes('0') || !bits.includes('1')) return []
  const rec = binaryRecord(scheme, first[0], last[0] + 1, bits, fingerprint)
  return rec === null ? [] : [rec]
}

const whitespaceRuns = (cps: readonly number[]): [number, number][] =>
  runs(cps.length, (i) => cps[i] === SPACE || cps[i] === TAB)

function decodeBidiMarks(hits: readonly ScanHit[]): Payload[] {
  const carriers: Carrier[] = hits
    .filter((h) => h.kind === 'bidi-mark' && h.flag === 'default' && (h.cp === LRM || h.cp === RLM))
    .map((h) => [h.index, h.cp === LRM ? '0' : '1'])
  return scattered('bidi-mark-binary', carriers, carriers.length >= MIN_BIDI_FINGERPRINT)
}

function decodeTrailingWhitespace(cps: readonly number[]): Payload[] {
  const n = cps.length
  const carriers: Carrier[] = []
  for (const [start, end] of whitespaceRuns(cps)) {
    const trailing = end === n || cps[end] === LF || (cps[end] === CR && end + 1 < n && cps[end + 1] === LF)
    if (!trailing) continue
    for (let i = start; i < end; i += 1) carriers.push([i, cps[i] === SPACE ? '0' : '1'])
  }
  return scattered('trailing-whitespace', carriers)
}

function decodeDoubleSpaces(cps: readonly number[]): Payload[] {
  const n = cps.length
  const carriers: Carrier[] = []
  for (const [start, end] of whitespaceRuns(cps)) {
    if (start === 0 || end === n || end - start > 2) continue
    const before = cps[start - 1]
    const after = cps[end]
    if (before === LF || before === CR || after === LF || after === CR) continue
    if (cps.slice(start, end).some((cp) => cp !== SPACE)) continue
    carriers.push([start, end - start === 1 ? '0' : '1'])
  }
  return scattered('double-space-binary', carriers)
}

function decodeTwoSymbol(cps: readonly number[], scheme: PayloadScheme, zero: number, one: number): Payload[] {
  const carriers: Carrier[] = []
  cps.forEach((cp, i) => {
    if (cp === zero || cp === one) carriers.push([i, cp === zero ? '0' : '1'])
  })
  return scattered(scheme, carriers)
}

function decodeNormalization(cps: readonly number[]): Payload[] {
  const n = cps.length
  const carriers: Carrier[] = []
  let i = 0
  while (i < n) {
    const cp = cps[i] ?? 0
    const ch = String.fromCodePoint(cp)
    const next = cps[i + 1]
    if (ch.normalize('NFD') !== ch) {
      carriers.push([i, '0'])
    } else if (next !== undefined && toCodePoints(String.fromCodePoint(cp, next).normalize('NFC')).length === 1) {
      carriers.push([i, '1'])
      i += 1
    }
    i += 1
  }
  return scattered('normalization-binary', carriers)
}

function decodeHomoglyphs(hits: readonly ScanHit[]): Payload[] {
  const where = hits.filter((h) => h.kind === 'confusable').map((h) => h.index)
  const first = where[0]
  const last = where[where.length - 1]
  if (where.length < MIN_HOMOGLYPHS || first === undefined || last === undefined) return []
  return [record('homoglyph', first, last + 1, null, '', where.length)]
}

// ------------------------------------------------------------------ entry ----

const SCHEME_ORDER: ReadonlyMap<PayloadScheme, number> = new Map(PAYLOAD_SCHEMES.map((s, i) => [s, i]))

/** Every hidden payload in `text`, ordered by start, then end, then scheme. */
export function decode(text: string): Payload[] {
  const cps = toCodePoints(text)
  const hits = scan(cps)
  const marks = decodeCanary(text)
  const marked = new Set<number>()
  for (const m of marks) for (let i = m.start; i < m.end; i += 1) marked.add(i)
  const found = [
    ...decodeTags(cps),
    ...decodeVariationSelectors(cps),
    ...decodeZeroWidth(cps, marked),
    ...marks,
    ...decodeBidiMarks(hits),
    ...decodeTrailingWhitespace(cps),
    ...decodeTwoSymbol(cps, 'space-nbsp-binary', SPACE, NBSP),
    ...decodeDoubleSpaces(cps),
    ...decodeTwoSymbol(cps, 'apostrophe-binary', APOSTROPHE, RIGHT_SINGLE_QUOTE),
    ...decodeNormalization(cps),
    ...decodeHomoglyphs(hits),
  ]
  return found.sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      (SCHEME_ORDER.get(a.scheme) ?? 0) - (SCHEME_ORDER.get(b.scheme) ?? 0),
  )
}

// ---------------------------------------------------------------- display ----

/**
 * `decode_payloads.escape_message()`: a decoded message, safe to print where a
 * reader cannot see invisible characters, such as a terminal or a plain-text
 * report.
 *
 * A payload is written by whoever hid it, so every character a terminal could
 * act on, or a reader could miss, is written as an escape: a backslash as
 * `\\`, tab, LF and CR as `\t`, `\n` and `\r`, other C0 controls, DEL and C1
 * controls as `\u{XXXX}`, and every character {@link scan} would report at its
 * position as `\u{XXXX}`. Printable ASCII and ordinary letters in any script
 * are printed as themselves.
 */
export function escapeMessage(text: string): string {
  const cps = toCodePoints(text)
  const flagged = new Set(scan(cps).map((hit) => hit.index))
  let out = ''
  for (const [i, cp] of cps.entries()) {
    if (cp === 0x5c) out += '\\\\'
    else if (cp === TAB) out += '\\t'
    else if (cp === LF) out += '\\n'
    else if (cp === CR) out += '\\r'
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || flagged.has(i)) {
      out += `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`
    } else out += String.fromCodePoint(cp)
  }
  return out
}
