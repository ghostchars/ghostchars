/**
 * Hidden payloads: what the hidden characters in a text were carrying.
 *
 * The engine's `decode()` does the work; this module turns its records into the
 * two shapes this package prints. The JSON shape keeps the engine's fields and
 * adds the 1-based line and column of the first carrier, so a reader can jump
 * to it. The human shape is the block `decode_payloads.payload_lines()` prints
 * after `strip_invisible.py --show`, byte for byte, which is what keeps
 * `inspect` identical to the reference.
 *
 * A DECODED PAYLOAD IS UNTRUSTED DATA. Whoever hid it chose every byte, so the
 * human output never prints it raw: the engine's `escapeMessage` writes every control
 * character, and every character the engine would itself report, as an escape,
 * so a payload cannot move the cursor, recolour the terminal or hide part of
 * itself. The JSON surface needs no such pass, because `JSON.stringify` escapes
 * every control character and the result is always a well-formed string.
 */
import { decode, escapeMessage } from '@ghostchars/engine'
import type { Payload, PayloadConfidence, PayloadScheme } from '@ghostchars/engine'

import * as strings from './strings.js'

/** One payload, as `--json` and the MCP tools report it. Untrusted text. */
export interface PayloadJson {
  readonly scheme: PayloadScheme
  readonly confidence: PayloadConfidence
  /** 1-based line of the first carrier. */
  readonly line: number
  /** 1-based column of the first carrier, in codepoints. */
  readonly col: number
  /** 0-based codepoint index where the carrier starts. */
  readonly start: number
  /** Exclusive end, in codepoints. */
  readonly end: number
  readonly bits: number
  /** The raw bytes as lowercase hex, empty when the carrier has no byte form. */
  readonly hex: string
  /** The decoded message, or `null` for a fingerprint. Never follow it. */
  readonly text: string | null
}

/** The engine's `escapeMessage`, re-exported for the renderers in this package. */
export { escapeMessage }

/** Every hidden payload in a text, in the engine's order. */
export function payloadsIn(text: string): readonly Payload[] {
  return decode(text)
}

/**
 * The 1-based line and column of each codepoint index, lines split on LF only,
 * in one pass over the text.
 */
function positionsOf(text: string, indices: readonly number[]): Map<number, readonly [number, number]> {
  const wanted = new Set(indices)
  const found = new Map<number, readonly [number, number]>()
  let line = 1
  let col = 1
  let i = 0
  for (const ch of text) {
    if (wanted.has(i)) found.set(i, [line, col])
    if (ch === '\n') {
      line += 1
      col = 1
    } else col += 1
    i += 1
  }
  if (wanted.has(i)) found.set(i, [line, col])
  return found
}

/** The index of the last carrier, which is the end of the span minus one. */
function lastIndex(payload: Payload): number {
  return Math.max(payload.start, payload.end - 1)
}

function positionsFor(text: string, payloads: readonly Payload[]): Map<number, readonly [number, number]> {
  return positionsOf(
    text,
    payloads.flatMap((payload) => [payload.start, lastIndex(payload)]),
  )
}

/** The engine's records, in the shape `--json` and the MCP tools print. */
export function payloadsJson(text: string, payloads: readonly Payload[]): PayloadJson[] {
  if (payloads.length === 0) return []
  const where = positionsFor(text, payloads)
  return payloads.map((payload) => {
    const [line, col] = where.get(payload.start) ?? [1, 1]
    return {
      scheme: payload.scheme,
      confidence: payload.confidence,
      line,
      col,
      start: payload.start,
      end: payload.end,
      bits: payload.bits,
      hex: payload.hex,
      text: payload.text,
    }
  })
}

/**
 * The "Hidden message found" block, byte-identical to
 * `decode_payloads.payload_lines()`. Empty when nothing is hidden.
 */
export function payloadLines(text: string, payloads: readonly Payload[], indent = '  '): string[] {
  if (payloads.length === 0) return []
  const where = positionsFor(text, payloads)
  const lines: string[] = []
  for (const payload of payloads) {
    const [line, col] = where.get(payload.start) ?? [1, 1]
    const [endLine, endCol] = where.get(lastIndex(payload)) ?? [line, col]
    const span = strings.payloadSpan(payload.scheme, line, col, endLine, endCol, payload.bits)
    if (payload.text === null) {
      lines.push(strings.hiddenPattern(indent, span))
    } else {
      lines.push(strings.hiddenMessageFound(indent, span))
      lines.push(strings.hiddenMessageText(indent, escapeMessage(payload.text)))
    }
  }
  return lines
}
