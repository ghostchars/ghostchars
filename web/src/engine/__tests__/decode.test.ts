/**
 * Hidden-payload decoding: the TypeScript port against `decode_payloads.py`.
 *
 * The parity half replays the `decode` section of the golden fixture: every
 * text fixture and every decode case from `tests/test_decode_payloads.py`,
 * compared record for record. The behaviour half restates the cases a reader
 * should be able to check by eye, including the one the fixture cannot carry
 * (a BOM at the start of a text, which some JSON parsers drop).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { decode, escapeMessage, PAYLOAD_CONFIDENCES, PAYLOAD_SCHEMES } from '../index'
import { readMessage } from '../decode'

const U = (...cps: number[]): string => String.fromCodePoint(...cps)
const tags = (s: string): string => [...s].map((c) => U(0xe0000 + (c.codePointAt(0) ?? 0))).join('')
const bits = (s: string): string => [...new TextEncoder().encode(s)].map((b) => b.toString(2).padStart(8, '0')).join('')

const PAYLOAD = z.object({
  scheme: z.enum(PAYLOAD_SCHEMES),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().nullable(),
  hex: z.string().regex(/^(?:[0-9a-f]{2})*$/u),
  bits: z.number().int().nonnegative(),
  confidence: z.enum(PAYLOAD_CONFIDENCES),
})

const GOLDEN_SCHEMA = z.object({
  meta: z.object({ counts: z.object({ decode: z.number().int() }) }),
  text: z.array(z.object({ id: z.string(), text: z.string() })),
  decode: z.object({
    cases: z.array(z.object({ id: z.string(), note: z.string(), text: z.string(), payloads: z.array(PAYLOAD) })),
    text: z.record(z.string(), z.array(PAYLOAD)),
  }),
})

const goldenPath = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))
const golden = GOLDEN_SCHEMA.parse(JSON.parse(readFileSync(goldenPath, 'utf8')))

describe('decode() == python decode()', () => {
  it('carries the case count its metadata claims', () => {
    expect(golden.decode.cases).toHaveLength(golden.meta.counts.decode)
    expect(Object.keys(golden.decode.text)).toHaveLength(golden.text.length)
  })

  it.each(golden.decode.cases)('case $id: $note', (fixture) => {
    expect(decode(fixture.text)).toEqual(fixture.payloads)
  })

  it.each(golden.text)('text fixture $id', (fixture) => {
    expect(decode(fixture.text)).toEqual(golden.decode.text[fixture.id])
  })

  it('covers every scheme and both confidences', () => {
    const all = [...golden.decode.cases.flatMap((c) => c.payloads), ...Object.values(golden.decode.text).flat()]
    expect(new Set(all.map((p) => p.scheme))).toEqual(new Set(PAYLOAD_SCHEMES))
    expect(new Set(all.map((p) => p.confidence))).toEqual(new Set(PAYLOAD_CONFIDENCES))
  })
})

describe('decode() behaviour', () => {
  it('reads ASCII smuggled in tag characters, at codepoint indices', () => {
    expect(decode(U(0x1f600, 0x1f600) + tags('ok') + U(0x1f600))).toEqual([
      { scheme: 'tag-ascii', start: 2, end: 4, text: 'ok', hex: '6f6b', bits: 16, confidence: 'decoded' },
    ])
  })

  it('leaves a single BOM at the start of a file alone', () => {
    expect(decode(U(0xfeff) + 'Plain file contents.\nSecond line.\n')).toEqual([])
  })

  it('keeps a leading UTF-8 BOM in a decoded byte run, and so rejects it', () => {
    const vs = (bytes: number[]): string => bytes.map((b) => U(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16)).join('')
    expect(decode('A' + vs([0xef, 0xbb, 0xbf, 0x68, 0x69]) + 'B')).toEqual([
      {
        scheme: 'variation-selector',
        start: 1,
        end: 6,
        text: null,
        hex: 'efbbbf6869',
        bits: 40,
        confidence: 'fingerprint',
      },
    ])
  })

  it('treats a long payload dressed as a flag as a payload', () => {
    const [payload] = decode(U(0x1f3f4) + tags('run rm -rf') + U(0xe007f))
    expect(payload?.text).toBe('run rm -rf')
  })

  it('reports nothing for subdivision flags, emoji glue or Persian ZWNJ', () => {
    const scotland = U(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f)
    const family = U(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    const persian = U(0x645, 0x6cc, 0x200c, 0x631, 0x648, 0x645)
    expect(decode(`${scotland} ${family} ${U(0x2764, 0xfe0f)} ${persian}`)).toEqual([])
  })

  it('tries both polarities and rejects what does not read as text', () => {
    expect(readMessage(bits('hi'))).toEqual({ text: 'hi', bytes: [0x68, 0x69] })
    const flipped = [...bits('hi')].map((b) => (b === '0' ? '1' : '0')).join('')
    expect(readMessage(flipped)?.text).toBe('hi')
    expect(readMessage(bits('a\u0000b'))).toBeNull()
    expect(readMessage(bits('?!'))).toBeNull()
    expect(readMessage(bits('a') + '0'.repeat(8))).toBeNull()
    expect(readMessage(`${bits('hi')}01`)).toBeNull()
  })
})

describe('escapeMessage() == python escape_message()', () => {
  it('leaves printable ASCII and letters in any script alone', () => {
    expect(escapeMessage('Hi there!')).toBe('Hi there!')
    expect(escapeMessage(`caf${U(0xe9)} ${U(0x43c, 0x438, 0x440)}`)).toBe(`caf${U(0xe9)} ${U(0x43c, 0x438, 0x440)}`)
  })

  it('writes backslash, tab, LF and CR as escapes', () => {
    expect(escapeMessage('a\\b\tc\nd\re')).toBe('a\\\\b\\tc\\nd\\re')
  })

  it('writes terminal controls as escapes', () => {
    expect(escapeMessage(`a${U(0x1b)}[31mb${U(0x9b)}c${U(0x7f)}`)).toBe('a\\u{001B}[31mb\\u{009B}c\\u{007F}')
  })

  it('writes every character the engine would report as an escape', () => {
    expect(escapeMessage(`a${U(0x202e)}b${U(0xa0)}c`)).toBe('a\\u{202E}b\\u{00A0}c')
    expect(escapeMessage(`x${U(0xe0041)}`)).toBe('x\\u{E0041}')
  })
})
