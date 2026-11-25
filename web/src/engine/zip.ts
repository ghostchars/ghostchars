/**
 * A minimal ZIP reader/writer: just enough of the format for DOCX and ODT.
 *
 * WHY HAND-ROLLED: this engine ships with no dependencies, and a zip library
 * would be the single largest thing in any bundle that carries it. What a
 * document cleaner actually needs is small: read the central directory,
 * inflate two or three XML parts, put them back, and write a package the
 * original application still opens. That is this file.
 *
 * WHAT IT SUPPORTS
 *   - methods 0 (stored) and 8 (deflate), the only two that appear in OOXML/ODF
 *   - entry ORDER preserved exactly as the central directory lists it (Word
 *     wants `[Content_Types].xml` first; ODF wants `mimetype` first and STORED)
 *   - CRC-32, uncompressed and compressed sizes written correctly
 *   - the DOS timestamp and the external attributes of each source entry, so a
 *     round-trip does not silently restamp every file
 *
 * WHAT IT DOES NOT SUPPORT (and rejects loudly rather than corrupting):
 *   Zip64, encryption, data descriptors on read (sizes are taken from the
 *   central directory, which is authoritative), multi-disk archives, and any
 *   compression method other than 0 and 8.
 *
 * WHAT IT REFUSES: an archive that inflates past `ZIP_LIMITS` (see below). The
 * threat model here is not a corrupt file, it is a deliberate one: the whole
 * pitch of this tool is "someone sent me a suspicious document, let me check
 * it", and the right answer to a hostile document is an error message, not a
 * dead tab.
 *
 * BYTE LAYOUT NOTE: the header fields are written with the same fixed values
 * CPython's `zipfile` uses (version 2.0, create-system 3 "Unix", no extra
 * fields, no archive comment). That is not cosmetic: it is what lets
 * `zip.test.ts` assert that re-writing a package read from the Python-generated
 * golden fixture reproduces the fixture BYTE FOR BYTE, which is a far stronger
 * check on this file than any hand-written assertion.
 *
 * Inflation uses `DecompressionStream('deflate-raw')`, deflation
 * `CompressionStream('deflate-raw')`: both are platform built-ins in every
 * browser we target and in Node ≥ 18, so there is no polyfill and no fallback
 * path to keep in sync.
 */

/** The two compression methods a DOCX/ODT package is allowed to use. */
export const ZIP_COMPRESSION = {
  stored: 'stored',
  deflate: 'deflate',
} as const
export type ZipCompression = (typeof ZIP_COMPRESSION)[keyof typeof ZIP_COMPRESSION]

/** Numeric method code per compression, and the reverse lookup for reading. */
const METHOD_CODE = { stored: 0, deflate: 8 } as const satisfies Record<ZipCompression, number>

function compressionForMethod(method: number): ZipCompression | null {
  if (method === METHOD_CODE.stored) return ZIP_COMPRESSION.stored
  if (method === METHOD_CODE.deflate) return ZIP_COMPRESSION.deflate
  return null
}

/**
 * One member of the archive. `data` is always the UNCOMPRESSED bytes;
 * `compression` records how it was stored (on read) or how it should be stored
 * (on write), which is how the cleaner preserves each part's method.
 */
export interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
  readonly compression: ZipCompression
  /** MS-DOS packed time/date, preserved verbatim so a round-trip is stable. */
  readonly dosTime: number
  readonly dosDate: number
  /** Unix mode << 16 (CPython writes `0o600 << 16` for `writestr`). */
  readonly externalAttr: number
}

/** 1980-01-01 00:00:00: the earliest timestamp the DOS format can express. */
export const DOS_EPOCH = { time: 0, date: 0x21 } as const

/** CPython's `writestr` default: `?rw-------`. */
export const DEFAULT_EXTERNAL_ATTR = 0o600 << 16

/** Thrown for anything this reader deliberately refuses to guess about. */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

/**
 * Ceilings that stop a hostile archive from taking the tab down with it.
 *
 * DEFLATE's theoretical ratio is about 1032:1, so a 300 kB file can legitimately
 * declare 300 MB, and a file at the largest size a caller is likely to hand this
 * reader can declare far more. Checking the CENTRAL DIRECTORY's declared size is
 * not a defence: the directory is attacker-controlled, and the existing
 * size-equality check (`readZip` below) can only run AFTER the buffer has been
 * allocated. So the bound is on the inflate itself, enforced chunk by chunk.
 *
 * The numbers are chosen against what a real document is, not against what the
 * format allows: the largest DOCX anyone hands this tool has a handful of
 * megabytes of XML and a few dozen parts, so 128 MB and 4096 entries are two
 * orders of magnitude of headroom and still a hard stop.
 */
export const ZIP_LIMITS = {
  /** Total INFLATED bytes across every entry of one archive. */
  totalUncompressedBytes: 128 * 1024 * 1024,
  /** Members in the central directory (the format allows 65 535). */
  entryCount: 4096,
} as const

/**
 * Thrown when an archive is well-formed but too big to process: a separate
 * type from {@link ZipFormatError} so the UI can say "this file claims to
 * expand to N times its size" instead of "unreadable".
 */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipLimitError'
  }
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = buildCrcTable()

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
}

/** IEEE CRC-32 of `bytes`, as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// deflate-raw, via the platform
// ---------------------------------------------------------------------------

async function pipeThroughStream(
  bytes: Uint8Array,
  stream: TransformStream<BufferSource, Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  // A one-chunk ReadableStream and a manual drain rather than `Response`/`Blob`:
  // no extra copies, no fetch machinery, and identical behaviour in Node and the
  // browser (both of which have had these streams since 2022).
  // Copied into a freshly allocated buffer: `bytes` is usually a subarray view
  // of the whole archive, and `BufferSource` will not accept a view whose buffer
  // might be shared.
  const chunk = new Uint8Array(bytes.length)
  chunk.set(bytes)
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
  const reader = source.pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.length
    // Checked BEFORE the chunk is retained, so peak memory is bounded by
    // `maxBytes` plus one chunk: not by whatever the archive declared.
    if (total > maxBytes) {
      await reader.cancel()
      throw new ZipLimitError(`Entry expands past the ${maxBytes}-byte limit`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Raw DEFLATE decompression (no zlib/gzip wrapper): what ZIP method 8 is.
 * `maxBytes` aborts the stream mid-flight; see {@link ZIP_LIMITS}.
 */
export async function inflateRaw(
  bytes: Uint8Array,
  maxBytes: number = ZIP_LIMITS.totalUncompressedBytes,
): Promise<Uint8Array> {
  return pipeThroughStream(bytes, new DecompressionStream('deflate-raw'), maxBytes)
}

/**
 * Raw DEFLATE compression. The output of deflate is bounded by its input (plus
 * a few bytes of framing for incompressible data), so the cap here is only a
 * backstop against a pathological platform implementation.
 */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThroughStream(
    bytes,
    new CompressionStream('deflate-raw'),
    bytes.length + DEFLATE_OVERHEAD_BYTES,
  )
}

/** Slack for deflate's stored-block framing on incompressible input. */
const DEFLATE_OVERHEAD_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Signatures and fixed header fields
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22

/** ZIP spec version 2.0: the floor for deflate, and what CPython writes. */
const VERSION_20 = 20
/** "Unix" in the version-made-by high byte, matching CPython off Windows. */
const CREATE_SYSTEM_UNIX = 3
/** General-purpose bit 11: the file name is UTF-8. */
const FLAG_UTF8_NAME = 0x800

const ZIP64_SENTINEL = 0xffffffff

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse an archive into its entries, in central-directory order, with every
 * entry's payload already decompressed.
 *
 * Sizes and CRCs come from the CENTRAL directory, never from the local header:
 * a writer that used a data descriptor leaves zeroes in the local header, and
 * trusting them is the classic way to read a truncated document.
 */
export async function readZip(bytes: Uint8Array): Promise<readonly ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view, bytes.length)
  const count = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (centralOffset === ZIP64_SENTINEL) {
    throw new ZipFormatError('Zip64 archives are not supported')
  }
  if (count > ZIP_LIMITS.entryCount) {
    throw new ZipLimitError(`Archive declares ${count} entries, more than ${ZIP_LIMITS.entryCount}`)
  }

  const entries: ZipEntry[] = []
  // One budget for the WHOLE archive, spent as entries are read: a bomb split
  // across a thousand parts is the same bomb.
  let budget = ZIP_LIMITS.totalUncompressedBytes
  let cursor = centralOffset
  for (let i = 0; i < count; i += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > bytes.length || view.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw new ZipFormatError(`Central directory entry ${i} is missing or malformed`)
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const dosTime = view.getUint16(cursor + 12, true)
    const dosDate = view.getUint16(cursor + 14, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const externalAttr = view.getUint32(cursor + 38, true)
    const localOffset = view.getUint32(cursor + 42, true)

    if ((flags & 0x1) !== 0) throw new ZipFormatError('Encrypted archives are not supported')
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ZipFormatError('Zip64 archives are not supported')
    }
    const compression = compressionForMethod(method)
    if (compression === null) {
      throw new ZipFormatError(`Unsupported compression method ${method}`)
    }

    const name = decodeName(bytes.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength))
    const payload = await readLocalPayload(
      bytes,
      view,
      localOffset,
      compressedSize,
      compression,
      name,
      budget,
    )
    budget -= payload.length
    if (payload.length !== uncompressedSize) {
      throw new ZipFormatError(
        `Entry ${name} is ${payload.length} bytes, central directory says ${uncompressedSize}`,
      )
    }
    entries.push({ name, data: payload, compression, dosTime, dosDate, externalAttr })
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
  }
  return entries
}

async function readLocalPayload(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  compressedSize: number,
  compression: ZipCompression,
  name: string,
  budget: number,
): Promise<Uint8Array> {
  if (offset + LOCAL_HEADER_SIZE > bytes.length || view.getUint32(offset, true) !== SIG_LOCAL) {
    throw new ZipFormatError(`Local header for ${name} is missing or malformed`)
  }
  // Only the two length fields are read here: the local name and extra blocks
  // may legitimately differ in size from the central ones.
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const start = offset + LOCAL_HEADER_SIZE + nameLength + extraLength
  const end = start + compressedSize
  if (end > bytes.length) throw new ZipFormatError(`Entry ${name} runs past the end of the archive`)
  const raw = bytes.subarray(start, end)
  // A stored entry cannot exceed the archive it lives in, so its size is
  // already bounded by the upload gate; it still spends from the budget.
  if (compression === ZIP_COMPRESSION.stored) {
    if (raw.length > budget) {
      throw new ZipLimitError(`Entry ${name} exceeds the remaining ${budget}-byte budget`)
    }
    return raw.slice()
  }
  return inflateRaw(raw, budget)
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  if (length < EOCD_SIZE) throw new ZipFormatError('Not a ZIP archive: too short')
  // The archive comment may be up to 0xFFFF bytes, so the record can sit that
  // far from the end. Scan backwards from the earliest legal position.
  const lowest = Math.max(0, length - EOCD_SIZE - 0xffff)
  for (let offset = length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === SIG_EOCD) return offset
  }
  throw new ZipFormatError('Not a ZIP archive: no end-of-central-directory record')
}

const NAME_DECODER = new TextDecoder('utf-8')
const NAME_ENCODER = new TextEncoder()

function decodeName(bytes: Uint8Array): string {
  return NAME_DECODER.decode(bytes)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface StagedEntry {
  readonly entry: ZipEntry
  readonly nameBytes: Uint8Array
  readonly payload: Uint8Array
  readonly crc: number
  readonly flags: number
  readonly method: number
}

/**
 * Serialize entries into an archive, in the order given.
 *
 * The caller decides order and per-entry compression; this function only makes
 * the bytes. `withOdtMimetypeFirst` exists for the one ordering rule the FORMAT
 * imposes rather than the caller.
 */
export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const staged: StagedEntry[] = []
  for (const entry of entries) {
    const nameBytes = NAME_ENCODER.encode(entry.name)
    const isAscii = entry.name.split('').every((char) => char.charCodeAt(0) < 0x80)
    const payload =
      entry.compression === ZIP_COMPRESSION.stored ? entry.data : await deflateRaw(entry.data)
    staged.push({
      entry,
      nameBytes,
      payload,
      crc: crc32(entry.data),
      flags: isAscii ? 0 : FLAG_UTF8_NAME,
      method: METHOD_CODE[entry.compression],
    })
  }

  let total = 0
  for (const item of staged) {
    total += LOCAL_HEADER_SIZE + item.nameBytes.length + item.payload.length
    total += CENTRAL_HEADER_SIZE + item.nameBytes.length
  }
  total += EOCD_SIZE

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  const offsets: number[] = []
  let cursor = 0

  for (const item of staged) {
    offsets.push(cursor)
    view.setUint32(cursor, SIG_LOCAL, true)
    view.setUint16(cursor + 4, VERSION_20, true)
    view.setUint16(cursor + 6, item.flags, true)
    view.setUint16(cursor + 8, item.method, true)
    view.setUint16(cursor + 10, item.entry.dosTime, true)
    view.setUint16(cursor + 12, item.entry.dosDate, true)
    view.setUint32(cursor + 14, item.crc, true)
    view.setUint32(cursor + 18, item.payload.length, true)
    view.setUint32(cursor + 22, item.entry.data.length, true)
    view.setUint16(cursor + 26, item.nameBytes.length, true)
    view.setUint16(cursor + 28, 0, true)
    cursor += LOCAL_HEADER_SIZE
    out.set(item.nameBytes, cursor)
    cursor += item.nameBytes.length
    out.set(item.payload, cursor)
    cursor += item.payload.length
  }

  const centralStart = cursor
  for (let i = 0; i < staged.length; i += 1) {
    const item = staged[i]
    const offset = offsets[i]
    if (item === undefined || offset === undefined) continue
    view.setUint32(cursor, SIG_CENTRAL, true)
    view.setUint8(cursor + 4, VERSION_20)
    view.setUint8(cursor + 5, CREATE_SYSTEM_UNIX)
    view.setUint16(cursor + 6, VERSION_20, true)
    view.setUint16(cursor + 8, item.flags, true)
    view.setUint16(cursor + 10, item.method, true)
    view.setUint16(cursor + 12, item.entry.dosTime, true)
    view.setUint16(cursor + 14, item.entry.dosDate, true)
    view.setUint32(cursor + 16, item.crc, true)
    view.setUint32(cursor + 20, item.payload.length, true)
    view.setUint32(cursor + 24, item.entry.data.length, true)
    view.setUint16(cursor + 28, item.nameBytes.length, true)
    view.setUint16(cursor + 30, 0, true)
    view.setUint16(cursor + 32, 0, true)
    view.setUint16(cursor + 34, 0, true)
    view.setUint16(cursor + 36, 0, true)
    view.setUint32(cursor + 38, item.entry.externalAttr, true)
    view.setUint32(cursor + 42, offset, true)
    cursor += CENTRAL_HEADER_SIZE
    out.set(item.nameBytes, cursor)
    cursor += item.nameBytes.length
  }

  view.setUint32(cursor, SIG_EOCD, true)
  view.setUint16(cursor + 4, 0, true)
  view.setUint16(cursor + 6, 0, true)
  view.setUint16(cursor + 8, staged.length, true)
  view.setUint16(cursor + 10, staged.length, true)
  view.setUint32(cursor + 12, cursor - centralStart, true)
  view.setUint32(cursor + 16, centralStart, true)
  view.setUint16(cursor + 20, 0, true)
  return out
}

/**
 * The one ordering rule ODF imposes: `mimetype` must be the FIRST entry and
 * must be STORED, or the package is not a valid ODF document (OpenDocument
 * §3.3: it is how `file(1)` and every reader sniff the type without inflating
 * anything). `clean_file.py` does exactly this, and so does this helper.
 *
 * Entries other than `mimetype` keep their order. A package with no `mimetype`
 * is returned untouched rather than invented: that is a DOCX, or a broken ODT,
 * and neither is improved by adding a part.
 */
export function withOdtMimetypeFirst(entries: readonly ZipEntry[]): readonly ZipEntry[] {
  const mimetype = entries.find((entry) => entry.name === 'mimetype')
  if (mimetype === undefined) return entries
  const stored: ZipEntry =
    mimetype.compression === ZIP_COMPRESSION.stored
      ? mimetype
      : { ...mimetype, compression: ZIP_COMPRESSION.stored }
  return [stored, ...entries.filter((entry) => entry.name !== 'mimetype')]
}

// ---------------------------------------------------------------------------
// Text helpers shared by the document cleaners
// ---------------------------------------------------------------------------

const UTF8_DECODER = new TextDecoder('utf-8')
const UTF8_ENCODER = new TextEncoder()

/**
 * Decode a part as UTF-8, replacing malformed sequences rather than throwing:
 * the same forgiveness as `bytes.decode("utf-8", "replace")` in `clean_file.py`,
 * because a document with one bad byte should still be inspectable.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes)
}

export function encodeUtf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text)
}
