/**
 * `canary.py`: per-recipient invisible marks, transliterated.
 *
 * The reverse use of the cleaner. Each recipient of a confidential draft gets a
 * copy that carries their id in zero-width characters; when a copy turns up
 * where it should not, {@link detectCanary} reads the id back.
 *
 * ```ts
 * const marked = embedCanary(text, 'alice')        // looks identical to text
 * detectCanary(marked)                              // [{ id: 'alice', status: 'unkeyed', ... }]
 * detectCanary(embedCanary(text, 'bob', key), key)  // [{ id: 'bob', status: 'verified', ... }]
 * ```
 *
 * Any hidden-character cleaner removes the mark, this engine's own `clean()`
 * included: with the default options it turns a marked text back into the
 * original, byte for byte. A mark deters and traces casual leaks; it is not
 * tamper-proof.
 *
 * The Python module docstring is the specification: the frame, the carriers
 * and why they were chosen, placement and keyed mode. Parity is a test:
 * `__tests__/canary.test.ts` replays the `canary` section of the golden fixture.
 */
import { toCodePoints } from './classify'
import { scan } from './find'
import type { Kind } from './types'

/** Bit 0: ZERO WIDTH SPACE. */
export const CANARY_ZERO = 0x200b
/** Bit 1: ZERO WIDTH NON-JOINER. */
export const CANARY_ONE = 0x200c
const MAGIC = 0xa7
const VERSION_PLAIN = 0x10
const VERSION_KEYED = 0x11
/** The longest id, in UTF-8 bytes. */
export const CANARY_MAX_ID_BYTES = 64
const TAG_BYTES = 8
const CRC_BYTES = 4
/** A copy of the mark goes in front of every this many words. */
export const CANARY_EVERY = 10
const TAG_CONTEXT = [...new TextEncoder().encode('ghostchars-canary-v1'), 0]

const WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
])
const ID_ALLOWED_KINDS: ReadonlySet<Kind> = new Set<Kind>(['punct', 'confusable'])

/**
 * `unkeyed`: anyone could have written it. `verified`: keyed, and the key
 * matches. `unverified`: keyed, no key given. `rejected`: keyed, and the key
 * does not match, so the mark was forged or made with another key.
 */
export const CANARY_STATUSES = ['unkeyed', 'verified', 'unverified', 'rejected'] as const
export type CanaryStatus = (typeof CANARY_STATUSES)[number]

/** A key: bytes, or a string read as UTF-8. */
export type CanaryKey = string | Uint8Array

/** One distinct mark found by {@link detectCanary}. */
export interface CanaryResult {
  /** The id the mark names. For a `rejected` mark, only a claim. */
  readonly id: string
  readonly keyed: boolean
  readonly status: CanaryStatus
  /** How many whole copies of this mark the text holds. */
  readonly count: number
  /** Codepoint index where the first copy's run starts. */
  readonly start: number
  /** Exclusive end of the first copy's run. */
  readonly end: number
}

/** One whole mark, one per run, as {@link findCanaryMarks} returns it. */
export interface CanaryMark {
  readonly start: number
  readonly end: number
  readonly id: string
  readonly keyed: boolean
  /** The HMAC tag of a keyed mark, `null` for an unkeyed one. */
  readonly tag: readonly number[] | null
  /** The frame bytes. */
  readonly raw: readonly number[]
}

/** Thrown by {@link embedCanary} with the same message the Python raises. */
export class CanaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanaryError'
  }
}

// ---------------------------------------------------------------- helpers ----

const ENCODER = new TextEncoder()
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Codepoints back to a string, in chunks that stay under the argument limit. */
function fromCodePoints(cps: readonly number[]): string {
  let out = ''
  for (let i = 0; i < cps.length; i += 8192) out += String.fromCodePoint(...cps.slice(i, i + 8192))
  return out
}

function utf8Bytes(text: string): number[] {
  return [...ENCODER.encode(text)]
}

function asKey(key: CanaryKey | null | undefined): number[] | null {
  if (key === null || key === undefined) return null
  const raw = typeof key === 'string' ? utf8Bytes(key) : [...key]
  if (raw.length === 0) throw new CanaryError('the key is empty')
  return raw
}

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** CRC-32 as zlib computes it. */
export function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff
  for (const b of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ b) & 0xff] ?? 0)
  return (crc ^ 0xffffffff) >>> 0
}

const crcBytes = (bytes: readonly number[]): number[] => {
  const c = crc32(bytes)
  return [c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]
}

// SHA-256 (FIPS 180-4), synchronous so the engine stays free of async crypto.
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** SHA-256 of `bytes`. */
export function sha256(bytes: readonly number[]): number[] {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bitLength = bytes.length * 8
  const padded = [...bytes, 0x80]
  while (padded.length % 64 !== 56) padded.push(0)
  const hi = Math.floor(bitLength / 0x100000000)
  padded.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  padded.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff)
  const w = new Array<number>(64).fill(0)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t += 1) {
      const p = off + 4 * t
      w[t] = (((padded[p] ?? 0) << 24) | ((padded[p + 1] ?? 0) << 16) | ((padded[p + 2] ?? 0) << 8) | (padded[p + 3] ?? 0)) >>> 0
    }
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15] ?? 0
      const y = w[t - 2] ?? 0
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0
    }
    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let d = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + (K256[t] ?? 0) + (w[t] ?? 0)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const next = [a, b, c, d, e, f, g, hh]
    for (let k = 0; k < 8; k += 1) h[k] = ((h[k] ?? 0) + (next[k] ?? 0)) >>> 0
  }
  return h.flatMap((x) => [x >>> 24, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff])
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: readonly number[], message: readonly number[]): number[] {
  let k = key.length > 64 ? sha256(key) : [...key]
  k = [...k, ...new Array<number>(64 - k.length).fill(0)]
  const inner = sha256([...k.map((b) => b ^ 0x36), ...message])
  return sha256([...k.map((b) => b ^ 0x5c), ...inner])
}

/** The truncated HMAC that authenticates an id under a key. */
function tagFor(key: readonly number[], idBytes: readonly number[]): number[] {
  return hmacSha256(key, [...TAG_CONTEXT, ...idBytes]).slice(0, TAG_BYTES)
}

/** `canary.id_error()`: why `id` cannot be a mark id, or `null` when it can. */
export function canaryIdError(id: string): string | null {
  const cps = toCodePoints(id)
  // A lone surrogate counts three bytes, as Python's surrogatepass encodes it;
  // TextEncoder's U+FFFD replacement is three bytes too.
  const size = utf8Bytes(id).length
  if (size === 0) return 'the id is empty'
  if (size > CANARY_MAX_ID_BYTES) return `the id is longer than ${CANARY_MAX_ID_BYTES} bytes in UTF-8`
  if (cps.some((cp) => cp >= 0xd800 && cp <= 0xdfff)) return 'the id is not valid Unicode'
  if (cps.some((cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))) {
    return 'the id contains a control character or line break'
  }
  if (scan(cps).some((hit) => !ID_ALLOWED_KINDS.has(hit.kind))) {
    return 'the id contains a hidden or special character'
  }
  if (cps.every((cp) => WHITESPACE.has(cp))) return 'the id is blank'
  return null
}

/** The frame bytes of one mark. */
export function canaryFrame(id: string, key?: CanaryKey | null): number[] {
  const error = canaryIdError(id)
  if (error !== null) throw new CanaryError(error)
  const k = asKey(key)
  const idBytes = utf8Bytes(id)
  const body = [MAGIC, k === null ? VERSION_PLAIN : VERSION_KEYED, idBytes.length, ...idBytes]
  if (k !== null) body.push(...tagFor(k, idBytes))
  return [...body, ...crcBytes(body)]
}

/** Frame bytes as carrier characters, most significant bit first. */
export function canaryChars(raw: readonly number[]): string {
  let out = ''
  for (const b of raw) {
    for (let k = 7; k >= 0; k -= 1) out += String.fromCharCode((b >> k) & 1 ? CANARY_ONE : CANARY_ZERO)
  }
  return out
}

const isCarrier = (cp: number | undefined): boolean => cp === CANARY_ZERO || cp === CANARY_ONE

/** `canary.parse_frame()`: the frame a run of carriers spells, or `null`. */
function parseFrame(run: readonly number[]): Omit<CanaryMark, 'start' | 'end'> | null {
  const n = run.length
  if (n % 8 !== 0 || n < 8 * (3 + 1 + CRC_BYTES)) return null
  const raw: number[] = []
  for (let k = 0; k < n; k += 8) {
    let byte = 0
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | (run[k + b] === CANARY_ONE ? 1 : 0)
    raw.push(byte)
  }
  if (raw[0] !== MAGIC || (raw[1] !== VERSION_PLAIN && raw[1] !== VERSION_KEYED)) return null
  const keyed = raw[1] === VERSION_KEYED
  const size = raw[2] ?? 0
  if (size < 1 || size > CANARY_MAX_ID_BYTES) return null
  if (raw.length !== 3 + size + (keyed ? TAG_BYTES : 0) + CRC_BYTES) return null
  const body = raw.slice(0, -CRC_BYTES)
  const want = crcBytes(body)
  if (raw.slice(-CRC_BYTES).some((b, i) => b !== want[i])) return null
  let id: string
  try {
    id = UTF8.decode(new Uint8Array(raw.slice(3, 3 + size)))
  } catch {
    return null
  }
  if (canaryIdError(id) !== null) return null
  return { id, keyed, tag: keyed ? raw.slice(3 + size, 3 + size + TAG_BYTES) : null, raw }
}

function marksIn(cps: readonly number[]): CanaryMark[] {
  const out: CanaryMark[] = []
  const n = cps.length
  let i = 0
  while (i < n) {
    if (!isCarrier(cps[i])) {
      i += 1
      continue
    }
    let j = i
    while (j < n && isCarrier(cps[j])) j += 1
    const parsed = parseFrame(cps.slice(i, j))
    if (parsed !== null) out.push({ start: i, end: j, ...parsed })
    i = j
  }
  return out
}

/** `canary.find_marks()`: every whole mark in `text`, in order, one per run. */
export function findCanaryMarks(text: string): CanaryMark[] {
  return marksIn(toCodePoints(text))
}

/** Where a mark may go: a word's first character, never a carrier. */
function wordStarts(cps: readonly number[]): number[] {
  const out: number[] = []
  cps.forEach((cp, i) => {
    if (WHITESPACE.has(cp) || isCarrier(cp)) return
    if (i === 0 || WHITESPACE.has(cps[i - 1] ?? 0)) out.push(i)
  })
  return out
}

// ------------------------------------------------------------------ entry ----

/**
 * `canary.embed()`: `text` with a mark for `id` in front of every
 * {@link CANARY_EVERY}-th word. Marks already in `text` are replaced. Throws
 * {@link CanaryError} for an id {@link canaryIdError} rejects, an empty key,
 * or a text with no word to put a mark in front of.
 */
export function embedCanary(text: string, id: string, key?: CanaryKey | null): string {
  const chars = canaryChars(canaryFrame(id, key))
  let cps = toCodePoints(text)
  const old = marksIn(cps)
  if (old.length > 0) {
    const drop = new Set<number>()
    for (const mark of old) for (let i = mark.start; i < mark.end; i += 1) drop.add(i)
    cps = cps.filter((_, i) => !drop.has(i))
  }
  const where = wordStarts(cps).filter((_, k) => k % CANARY_EVERY === 0)
  if (where.length === 0) throw new CanaryError('the text has no word to put a mark in front of')
  const parts: string[] = []
  let last = 0
  for (const i of where) {
    parts.push(fromCodePoints(cps.slice(last, i)), chars)
    last = i
  }
  parts.push(fromCodePoints(cps.slice(last)))
  return parts.join('')
}

function statusOf(mark: CanaryMark, key: readonly number[] | null): CanaryStatus {
  if (!mark.keyed) return 'unkeyed'
  if (key === null) return 'unverified'
  const good = tagFor(key, utf8Bytes(mark.id))
  const tag = mark.tag ?? []
  let diff = good.length ^ tag.length
  for (let i = 0; i < good.length; i += 1) diff |= (good[i] ?? 0) ^ (tag[i] ?? 0)
  return diff === 0 ? 'verified' : 'rejected'
}

/**
 * `canary.detect()`: the marks in `text`, one {@link CanaryResult} per
 * distinct id and status, in order. An empty list means no whole mark: the
 * text was never marked, or its marks were cleaned out or cut apart.
 */
export function detectCanary(text: string, key?: CanaryKey | null): CanaryResult[] {
  const k = asKey(key)
  const out: { id: string; keyed: boolean; status: CanaryStatus; count: number; start: number; end: number }[] = []
  const seen = new Map<string, (typeof out)[number]>()
  for (const mark of findCanaryMarks(text)) {
    const status = statusOf(mark, k)
    const group = JSON.stringify([mark.id, mark.keyed, status])
    const prior = seen.get(group)
    if (prior !== undefined) {
      prior.count += 1
      continue
    }
    const rec = { id: mark.id, keyed: mark.keyed, status, count: 1, start: mark.start, end: mark.end }
    seen.set(group, rec)
    out.push(rec)
  }
  return out
}
