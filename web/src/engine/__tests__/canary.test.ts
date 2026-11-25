/**
 * Per-recipient marks: the TypeScript port against `canary.py`.
 *
 * The parity half replays the `canary` section of the golden fixture:
 * `embed()` output byte for byte, `detect()` records, and the reason an id is
 * refused. The behaviour half restates the promises a reader should be able
 * to check by eye: round trip, excerpts, damage, forgery and the clean.
 */
import { createHmac, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  CANARY_EVERY,
  CANARY_STATUSES,
  CanaryError,
  canaryIdError,
  clean,
  decode,
  detectCanary,
  embedCanary,
  findCanaryMarks,
} from '../index'
import { canaryChars, canaryFrame, crc32, hmacSha256, sha256 } from '../canary'

const ZWSP = '\u200b'
const ZWNJ = '\u200c'

const RESULT = z.object({
  id: z.string(),
  keyed: z.boolean(),
  status: z.enum(CANARY_STATUSES),
  count: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
})

const GOLDEN_SCHEMA = z.object({
  meta: z.object({ counts: z.object({ canary: z.number().int() }) }),
  canary: z.object({
    embed: z.array(
      z.object({
        id: z.string(),
        note: z.string(),
        text: z.string(),
        markId: z.string(),
        key: z.string().nullable(),
        marked: z.string(),
      }),
    ),
    detect: z.array(
      z.object({ id: z.string(), note: z.string(), text: z.string(), key: z.string().nullable(), marks: z.array(RESULT) }),
    ),
    ids: z.array(z.object({ markId: z.string(), error: z.string().nullable() })),
  }),
})

const goldenPath = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))
const golden = GOLDEN_SCHEMA.parse(JSON.parse(readFileSync(goldenPath, 'utf8'))).canary
const memo = golden.embed.find((c) => c.id === 'memo-unkeyed')?.text ?? ''

const strip = (s: string): string => s.replaceAll(ZWSP, '').replaceAll(ZWNJ, '')
const bytes = (s: string): number[] => [...new TextEncoder().encode(s)]
const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('')

describe('canary == python canary', () => {
  it('carries the case count its metadata claims', () => {
    const goldenAll = GOLDEN_SCHEMA.parse(JSON.parse(readFileSync(goldenPath, 'utf8')))
    expect(golden.embed.length + golden.detect.length).toBe(goldenAll.meta.counts.canary)
  })

  it.each(golden.embed)('embed $id: $note', (c) => {
    expect(embedCanary(c.text, c.markId, c.key)).toBe(c.marked)
  })

  it.each(golden.detect)('detect $id: $note', (c) => {
    expect(detectCanary(c.text, c.key)).toEqual(c.marks)
  })

  it.each(golden.ids)('id $markId', (c) => {
    expect(canaryIdError(c.markId)).toBe(c.error)
    if (c.error === null) expect(() => embedCanary('a b', c.markId)).not.toThrow()
    else expect(() => embedCanary('a b', c.markId)).toThrow(new CanaryError(c.error))
  })
})

describe('canary primitives', () => {
  it('computes SHA-256 and HMAC-SHA256 as node:crypto does', () => {
    for (const input of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)]) {
      expect(hex(sha256(bytes(input)))).toBe(createHash('sha256').update(input).digest('hex'))
    }
    for (const key of ['k', 'x'.repeat(64), 'y'.repeat(100)]) {
      expect(hex(hmacSha256(bytes(key), bytes('message')))).toBe(
        createHmac('sha256', key).update('message').digest('hex'),
      )
    }
  })

  it('computes CRC-32 as zlib does', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32([])).toBe(0)
  })
})

describe('canary behaviour', () => {
  const marked = embedCanary(memo, 'alice')

  it('round-trips and leaves the visible text alone', () => {
    expect(detectCanary(marked).map((r) => [r.id, r.status])).toEqual([['alice', 'unkeyed']])
    expect(strip(marked)).toBe(memo)
  })

  it('is removed by the default clean, which gives back the original bytes', () => {
    expect(clean(marked).text).toBe(memo)
    expect(clean(embedCanary(memo, 'bob', 'key')).text).toBe(memo)
    expect(detectCanary(clean(marked).text)).toEqual([])
  })

  it('survives an excerpt that spans EVERY + 1 words', () => {
    const words = marked.split(' ')
    for (let from = 0; from + CANARY_EVERY + 1 <= words.length; from += 1) {
      const part = words.slice(from, from + CANARY_EVERY + 1).join(' ')
      expect(detectCanary(part).map((r) => r.id)).toEqual(['alice'])
    }
  })

  it('never names an id from a damaged copy', () => {
    const run = canaryChars(canaryFrame('alice'))
    for (let bit = 0; bit < run.length; bit += 1) {
      const flipped = run.slice(0, bit) + (run[bit] === ZWSP ? ZWNJ : ZWSP) + run.slice(bit + 1)
      expect(detectCanary('a ' + flipped + 'b')).toEqual([])
    }
    expect(detectCanary('a ' + run.slice(1) + 'b')).toEqual([])
    expect(detectCanary('a ' + run + ZWSP + 'b')).toEqual([])
  })

  it('verifies keyed marks and rejects forgeries', () => {
    const keyed = embedCanary(memo, 'bob', 'right key')
    const status = (key?: string | Uint8Array): string[] => detectCanary(keyed, key).map((r) => r.status)
    expect(status()).toEqual(['unverified'])
    expect(status('right key')).toEqual(['verified'])
    expect(status(new TextEncoder().encode('right key'))).toEqual(['verified'])
    expect(status('wrong key')).toEqual(['rejected'])
    const forged = canaryChars(canaryFrame('bob', 'attacker key')) + memo
    expect(detectCanary(forged, 'right key').map((r) => r.status)).toEqual(['rejected'])
    expect(() => embedCanary(memo, 'bob', '')).toThrow(CanaryError)
  })

  it('replaces an existing mark', () => {
    expect(detectCanary(embedCanary(marked, 'carol')).map((r) => r.id)).toEqual(['carol'])
  })

  it('refuses a text with no word', () => {
    expect(() => embedCanary('  \n ', 'alice')).toThrow('the text has no word to put a mark in front of')
  })

  it('handles long texts', () => {
    const long = 'word '.repeat(60_000)
    const out = embedCanary(long, 'r')
    expect(findCanaryMarks(out)).toHaveLength(6000)
    expect(clean(out).text).toBe(long)
  })

  it('shows up in decode() as the canary scheme', () => {
    const records = decode(embedCanary('Draft for the board.', 'alice'))
    expect(records.map((r) => [r.scheme, r.text, r.confidence])).toEqual([['canary', 'alice', 'decoded']])
    const keyed = decode(embedCanary('Draft for the board.', 'alice', 'k'))
    expect(keyed.map((r) => [r.scheme, r.text, r.confidence])).toEqual([['canary', null, 'fingerprint']])
  })
})
