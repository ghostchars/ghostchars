import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  crc32,
  DEFAULT_EXTERNAL_ATTR,
  DOS_EPOCH,
  deflateRaw,
  inflateRaw,
  readZip,
  withOdtMimetypeFirst,
  writeZip,
  ZIP_COMPRESSION,
  ZIP_LIMITS,
  ZipFormatError,
  ZipLimitError,
  type ZipEntry,
} from '../zip'

/**
 * The zip layer, checked against a writer that is not this one.
 *
 * The strongest assertion in this file is `re-writing the golden package
 * reproduces it byte for byte`. `tools/gen_golden.py` normalised every package
 * in the fixture with CPython's `zipfile`: fixed 1980-01-01 timestamps, every
 * entry STORED, external attributes carried over. If `readZip` mis-parses one
 * offset, or `writeZip` writes one header field differently from CPython, the
 * output is not byte-identical and this test says so. No hand-written
 * expectation about ZIP internals could cover the format that thoroughly.
 */

const GOLDEN_PATH = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))

const packageEntrySchema = z.object({
  name: z.string(),
  compress: z.enum(['stored', 'deflate']),
  size: z.number().int().nonnegative(),
  crc32: z.number().int().nonnegative(),
})

const packageSchema = z.object({
  id: z.string(),
  kind: z.enum(['docx', 'odt']),
  entries: z.array(packageEntrySchema),
  parts: z.record(z.string(), z.string()),
  bytesB64: z.string(),
})

const goldenSchema = z.object({
  documents: z.array(z.looseObject({ kind: z.string() })),
})

function loadPackages(): readonly z.infer<typeof packageSchema>[] {
  const golden = goldenSchema.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))
  return golden.documents
    .filter((document) => document.kind !== 'html')
    .map((document) => packageSchema.parse(document))
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

const PACKAGES = loadPackages()

describe('crc32', () => {
  it('matches the known IEEE check value', () => {
    // The standard "123456789" check vector for CRC-32/ISO-HDLC.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('agrees with every CRC CPython recorded in the fixture', () => {
    for (const pkg of PACKAGES) {
      for (const entry of pkg.entries) {
        const part = pkg.parts[entry.name]
        expect(part, `${pkg.id}/${entry.name}`).toBeDefined()
        expect(crc32(new TextEncoder().encode(part ?? '')), `${pkg.id}/${entry.name}`).toBe(
          entry.crc32,
        )
      }
    }
  })
})

describe('readZip', () => {
  it('reads every fixture package: order, names, methods, sizes and payloads', async () => {
    for (const pkg of PACKAGES) {
      const entries = await readZip(fromBase64(pkg.bytesB64))
      expect(entries.map((entry) => entry.name), pkg.id).toEqual(
        pkg.entries.map((entry) => entry.name),
      )
      for (const entry of entries) {
        const expected = pkg.parts[entry.name]
        expect(expected, `${pkg.id}/${entry.name}`).toBeDefined()
        expect(new TextDecoder().decode(entry.data), `${pkg.id}/${entry.name}`).toBe(expected)
      }
      // The fixture is normalised to STORED; the METHOD each entry really used
      // is recorded separately and checked by the docx/odt suites.
      expect(
        entries.every((entry) => entry.compression === ZIP_COMPRESSION.stored),
        pkg.id,
      ).toBe(true)
    }
  })

  it('rejects a buffer that is not a zip', async () => {
    await expect(readZip(new TextEncoder().encode('not a zip'))).rejects.toBeInstanceOf(
      ZipFormatError,
    )
  })

  it('rejects a truncated archive rather than returning half a document', async () => {
    const bytes = fromBase64(PACKAGES[0]?.bytesB64 ?? '')
    await expect(readZip(bytes.subarray(0, bytes.length - 40))).rejects.toBeInstanceOf(
      ZipFormatError,
    )
  })
})

describe('decompression limits', () => {
  /**
   * The bomb, built with this file's own writer so the archive is real: a
   * `word/document.xml` of zeroes, which DEFLATE compresses about 1000:1. A
   * caller that bounds the COMPRESSED bytes cannot bound the inflated ones,
   * so a small archive can declare hundreds of megabytes: the point of the
   * test is that the inflate itself stops, not that the declared size looks
   * wrong afterwards.
   */
  async function bomb(uncompressedBytes: number): Promise<Uint8Array> {
    return writeZip([
      {
        name: 'word/document.xml',
        data: new Uint8Array(uncompressedBytes),
        compression: ZIP_COMPRESSION.deflate,
        dosTime: DOS_EPOCH.time,
        dosDate: DOS_EPOCH.date,
        externalAttr: DEFAULT_EXTERNAL_ATTR,
      },
    ])
  }

  it('refuses an entry that inflates past the archive budget', async () => {
    const archive = await bomb(ZIP_LIMITS.totalUncompressedBytes + 1024 * 1024)
    // Small enough that a size-based gate on the compressed bytes would pass it.
    expect(archive.length).toBeLessThan(2 * 1024 * 1024)
    await expect(readZip(archive)).rejects.toBeInstanceOf(ZipLimitError)
  })

  it('still reads an archive that stays inside the budget', async () => {
    const entries = await readZip(await bomb(4 * 1024 * 1024))
    expect(entries[0]?.data.length).toBe(4 * 1024 * 1024)
  })

  it('refuses an archive that declares more entries than a document can have', async () => {
    // Only the EOCD count is patched: the check has to fire before a single
    // central-directory record is parsed, which is the whole point of it.
    const archive = await bomb(1024)
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    const eocd = archive.length - 22
    view.setUint16(eocd + 10, ZIP_LIMITS.entryCount + 1, true)
    await expect(readZip(archive)).rejects.toBeInstanceOf(ZipLimitError)
  })
})

describe('writeZip', () => {
  it('reproduces the CPython-written fixture package byte for byte', async () => {
    for (const pkg of PACKAGES) {
      const original = fromBase64(pkg.bytesB64)
      const entries = await readZip(original)
      const rewritten = await writeZip(entries)
      expect(rewritten.length, pkg.id).toBe(original.length)
      expect(Buffer.from(rewritten).equals(Buffer.from(original)), pkg.id).toBe(true)
    }
  })

  it('round-trips deflated entries through the platform codec', async () => {
    const body = 'zero-width joiners, repeated: ‍‍‍‍‍ '.repeat(40)
    const entries: ZipEntry[] = [
      {
        name: 'mimetype',
        data: new TextEncoder().encode('application/vnd.oasis.opendocument.text'),
        compression: ZIP_COMPRESSION.stored,
        dosTime: DOS_EPOCH.time,
        dosDate: DOS_EPOCH.date,
        externalAttr: DEFAULT_EXTERNAL_ATTR,
      },
      {
        name: 'content.xml',
        data: new TextEncoder().encode(body),
        compression: ZIP_COMPRESSION.deflate,
        dosTime: 0x4a10,
        dosDate: 0x5911,
        externalAttr: DEFAULT_EXTERNAL_ATTR,
      },
    ]
    const bytes = await writeZip(entries)
    const read = await readZip(bytes)
    expect(read.map((entry) => entry.name)).toEqual(['mimetype', 'content.xml'])
    expect(read[0]?.compression).toBe(ZIP_COMPRESSION.stored)
    expect(read[1]?.compression).toBe(ZIP_COMPRESSION.deflate)
    expect(new TextDecoder().decode(read[1]?.data)).toBe(body)
    expect(read[1]?.dosTime).toBe(0x4a10)
    expect(read[1]?.dosDate).toBe(0x5911)
    // Deflate has to have actually happened, or the codec silently stored it.
    expect(bytes.length).toBeLessThan(body.length)
  })

  it('is idempotent: write → read → write is byte-stable', async () => {
    const source = fromBase64(PACKAGES[0]?.bytesB64 ?? '')
    const once = await writeZip(await readZip(source))
    const twice = await writeZip(await readZip(once))
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true)
  })
})

describe('deflate-raw', () => {
  it('inflates what it deflates, including the empty input', async () => {
    for (const sample of ['', 'a', 'the quick brown fox '.repeat(500)]) {
      const bytes = new TextEncoder().encode(sample)
      const roundTripped = await inflateRaw(await deflateRaw(bytes))
      expect(new TextDecoder().decode(roundTripped)).toBe(sample)
    }
  })
})

describe('withOdtMimetypeFirst', () => {
  const entry = (name: string, compression = ZIP_COMPRESSION.deflate): ZipEntry => ({
    name,
    data: new Uint8Array(0),
    compression,
    dosTime: DOS_EPOCH.time,
    dosDate: DOS_EPOCH.date,
    externalAttr: DEFAULT_EXTERNAL_ATTR,
  })

  it('moves mimetype to the front and forces it stored', () => {
    const ordered = withOdtMimetypeFirst([entry('content.xml'), entry('mimetype'), entry('meta.xml')])
    expect(ordered.map((item) => item.name)).toEqual(['mimetype', 'content.xml', 'meta.xml'])
    expect(ordered[0]?.compression).toBe(ZIP_COMPRESSION.stored)
  })

  it('leaves a package without a mimetype part alone', () => {
    const input = [entry('word/document.xml'), entry('[Content_Types].xml')]
    expect(withOdtMimetypeFirst(input)).toBe(input)
  })
})
