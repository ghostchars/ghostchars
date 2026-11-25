import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  analyzeStyle,
  HISTOGRAM_BUCKETS,
  paragraphs,
  pyRound,
  sentences,
  STYLE_SEVERITIES,
  wordCount,
} from '../style'

/**
 * Prose-report parity against `style_report.analyze`.
 *
 * The fixture records the FULL JSON Python produced for fifteen texts chosen to
 * fire every one of the seventeen observation branches. The comparison here is
 * structural and total: same keys, same key set, same integers, same strings
 * (observation titles AND their detail text, character for character), and
 * floats within the 0.05 the build spec allows.
 *
 * The float tolerance is a safety net, not the target: `pyRound` reproduces
 * CPython's round-half-even on the exact binary value, so `expectExactFloats`
 * below asserts the numbers are in fact identical. If that ever starts failing
 * while the tolerant check passes, the rounding port has drifted and the
 * failure message will say exactly which field.
 */

const GOLDEN_PATH = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))

const styleFixtureSchema = z.object({
  id: z.string(),
  group: z.string(),
  note: z.string(),
  text: z.string(),
  report: z.record(z.string(), z.unknown()),
})

const goldenSchema = z.object({ style: z.array(styleFixtureSchema) })

const FIXTURES = goldenSchema.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))).style

const FLOAT_TOLERANCE = 0.05

/** Structural diff, returned as `path: expected vs actual` strings. */
function diff(expected: unknown, actual: unknown, path: string, exactFloats: boolean): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [`${path}: array shape mismatch`]
    }
    if (expected.length !== actual.length) {
      return [`${path}: length ${String(actual.length)}, expected ${String(expected.length)}`]
    }
    return expected.flatMap((item, index) =>
      diff(item, actual[index], `${path}[${String(index)}]`, exactFloats),
    )
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isInteger(expected) && Number.isInteger(actual)) {
      return expected === actual ? [] : [`${path}: ${String(actual)} != ${String(expected)}`]
    }
    if (exactFloats) {
      return expected === actual ? [] : [`${path}: ${String(actual)} !== ${String(expected)}`]
    }
    return Math.abs(expected - actual) <= FLOAT_TOLERANCE
      ? []
      : [`${path}: ${String(actual)} is more than ${String(FLOAT_TOLERANCE)} from ${String(expected)}`]
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const expectedRecord: Record<string, unknown> = { ...expected }
    const actualRecord: Record<string, unknown> = { ...actual }
    const expectedKeys = Object.keys(expectedRecord).sort()
    const actualKeys = Object.keys(actualRecord).sort()
    if (expectedKeys.join(',') !== actualKeys.join(',')) {
      return [`${path}: keys [${actualKeys.join(', ')}], expected [${expectedKeys.join(', ')}]`]
    }
    return expectedKeys.flatMap((key) =>
      diff(expectedRecord[key], actualRecord[key], `${path}.${key}`, exactFloats),
    )
  }
  return expected === actual
    ? []
    : [`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`]
}

describe('analyzeStyle parity', () => {
  it('has fixtures covering every observation branch', () => {
    const titles = new Set<string>()
    for (const fixture of FIXTURES) {
      const observations = z
        .array(z.object({ title: z.string() }))
        .parse(fixture.report['observations'])
      for (const observation of observations) titles.add(observation.title)
    }
    // seventeen `obs.append(...)` calls in style_report.analyze
    expect(titles.size).toBe(17)
  })

  for (const fixture of FIXTURES) {
    it(`matches Python for ${fixture.id} (${fixture.note})`, () => {
      const problems = diff(fixture.report, analyzeStyle(fixture.text), 'report', false)
      expect(problems).toEqual([])
    })
  }

  it('produces byte-identical floats, not merely floats within tolerance', () => {
    const problems = FIXTURES.flatMap((fixture) =>
      diff(fixture.report, analyzeStyle(fixture.text), fixture.id, true),
    )
    expect(problems).toEqual([])
  })

  it('reproduces observation severity, title and detail exactly', () => {
    for (const fixture of FIXTURES) {
      expect(analyzeStyle(fixture.text).observations, fixture.id).toEqual(
        fixture.report['observations'],
      )
    }
  })
})

describe('segmentation', () => {
  it('splits paragraphs on blank lines and strips each', () => {
    expect(paragraphs('  one  \n\n  two\nstill two \n \n three ')).toEqual([
      'one',
      'two\nstill two',
      'three',
    ])
  })

  it('does not break a sentence on a listed abbreviation or a decimal', () => {
    // `e.g` is in ABBREV, so the full stop after it does not end the sentence;
    // `p.m` is not, so it does. Both verified against style_report.sentences.
    expect(sentences('Dr. Who left at 3.5 e.g. cats. Then rain.')).toEqual([
      'Dr. Who left at 3.5 e.g. cats.',
      'Then rain.',
    ])
    expect(sentences('Dr. Who left at 3.5 p.m. He came back.')).toEqual([
      'Dr. Who left at 3.5 p.m.',
      'He came back.',
    ])
  })

  it('counts words the way Python does, including non-ASCII letters', () => {
    // JavaScript's own `\b` is ASCII-only; a naive port scores this as 2.
    expect(wordCount('naïve Ελληνικά слово')).toBe(3)
    expect(wordCount("don't-stop 'quoted' --")).toBe(2)
  })
})

describe('pyRound', () => {
  it('rounds halves to even, like Python and unlike toFixed', () => {
    // 12.25 and 0.125 are exactly representable, so both are true ties.
    expect(pyRound(12.25, 1)).toBe(12.2)
    expect(pyRound(12.35, 1)).toBe(12.3) // 12.35 is really 12.3499999...
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(2.5, 0)).toBe(2)
    expect(pyRound(3.5, 0)).toBe(4)
    expect(pyRound(0, 1)).toBe(0)
    expect((12.25).toFixed(1)).toBe('12.3') // the trap this avoids
  })
})

describe('registries', () => {
  it('lists the severities and buckets the Python report uses', () => {
    expect([...STYLE_SEVERITIES]).toEqual(['high', 'medium', 'low'])
    expect([...HISTOGRAM_BUCKETS]).toEqual(['1-8', '9-15', '16-25', '26-40', '41+'])
  })
})
