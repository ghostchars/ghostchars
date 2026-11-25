/**
 * `report --json`, byte for byte against `python3 style_report.py --json`.
 *
 * WHY BYTES AND NOT PARSED VALUES. The whole claim this suite defends is the
 * difference between `2` and `2.0`, and `JSON.parse` throws that away on the
 * first line. `golden.json` cannot help either: `gen_golden.py` stores the
 * reports already parsed AND with `sort_keys=True`, so it can prove neither the
 * int-versus-float rendering nor the key order. Only Python's real stdout can,
 * so this suite compares buffers.
 *
 * THE THREE TRAPS, EACH ONE A REAL INPUT. `Number.isInteger` looks like it
 * would decide int from float and does not:
 *
 *  1. Twenty-four two-word sentences and one one-word sentence give an exact
 *     mean of 1.96, and `round(1.96, 1)` is the FLOAT 2.0, which Python prints
 *     as `2.0` and `Number.isInteger` would call an int.
 *  2. Three two-word sentences give `statistics.mean([2,2,2])`, which is the
 *     INT 2 and prints as `2`, next to a `pstdev` that is always a float and
 *     prints as `0.0`.
 *  3. One hundred and eleven words with one em dash give
 *     `round(1000 * 1 / 111, 1)`, a per-thousand value that lands on a whole
 *     number and still prints as `9.0`, because `per_k` is always a float.
 *
 * A FOURTH CASE LOOKS REACHABLE AND IS NOT.
 * `cv = sd / mean if mean else 0` yields the INT `0` only when the mean of the
 * sentence word counts is zero, and that cannot happen: `sentences()` drops
 * every candidate with no word character in it, and any string containing a
 * word character produces at least one `\b[\w'-]+\b` match, so every counted
 * sentence has at least one word. `src/pyjson.ts` implements the branch anyway
 * (`cvIsInt: total === 0`), where it is correct and dead. There is no input to
 * pin it with, and inventing one would be a fixture that proves nothing.
 *
 * WHY THE PYTHON HELPER FAILS LOUDLY. A parity suite that silently skips itself
 * when `python3` is missing is worse than no parity suite: the reassurance
 * stays and the evidence goes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  HISTOGRAM_KEY_ORDER,
  OBSERVATION_KEY_ORDER,
  PARAGRAPH_SHAPE_KEY_ORDER,
  SENTENCE_LENGTH_KEY_ORDER,
  STYLE_KEY_ORDER,
  SUMMARY_KEY_ORDER,
} from '../src/pyjson.js'
import { golden } from './helpers/golden.js'
import { STYLE_REPORT, requirePython, runPythonScript } from './helpers/python.js'
import { requireBuild, runCli } from './helpers/run.js'

beforeAll(() => {
  requireBuild()
  requirePython()
})

/** A plain JSON object, narrowed without a cast so key ORDER survives intact. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('report --json did not print a JSON object')
  return value
}

/** The declared order, cut down to the keys this particular report carries. */
function expectedOrder(order: readonly string[], value: Record<string, unknown>): string[] {
  return order.filter((key) => key in value)
}

function pythonJson(input: string, args: readonly string[] = []): Buffer {
  return runPythonScript(STYLE_REPORT, ['--json', ...args], input).stdout
}

describe('the 17 golden style fixtures', () => {
  for (const sample of golden.style) {
    it(`prints byte-identical JSON to style_report.py for ${sample.id}`, () => {
      const result = runCli(['report', '--json'], { input: sample.text })
      expect(result.code).toBe(0)
      expect(result.stdoutBytes.equals(pythonJson(sample.text))).toBe(true)
    })

    it(`agrees with golden.json on every value for ${sample.id}`, () => {
      const parsed = parseObject(runCli(['report', '--json'], { input: sample.text }).stdout)
      expect(parsed).toEqual(sample.report)
    })

    it(`emits the keys in insertion order, not sorted, for ${sample.id}`, () => {
      const parsed = parseObject(runCli(['report', '--json'], { input: sample.text }).stdout)
      expect(Object.keys(parsed)).toEqual(expectedOrder(STYLE_KEY_ORDER, parsed))

      const length = parsed['sentence_length']
      if (isRecord(length)) {
        expect(Object.keys(length)).toEqual([...SENTENCE_LENGTH_KEY_ORDER])
        const histogram = length['histogram']
        if (isRecord(histogram)) expect(Object.keys(histogram)).toEqual([...HISTOGRAM_KEY_ORDER])
      }

      const shape = parsed['paragraph_shape']
      if (isRecord(shape)) expect(Object.keys(shape)).toEqual([...PARAGRAPH_SHAPE_KEY_ORDER])

      const summary = parsed['summary']
      if (isRecord(summary)) expect(Object.keys(summary)).toEqual([...SUMMARY_KEY_ORDER])

      const observations = parsed['observations']
      if (Array.isArray(observations)) {
        for (const observation of observations) {
          if (isRecord(observation)) {
            expect(Object.keys(observation)).toEqual([...OBSERVATION_KEY_ORDER])
          }
        }
      }
    })
  }

  it('proves the corpus is the size the fixture itself claims', () => {
    expect(golden.style.length).toBe(golden.meta.counts.style)
  })
})

/**
 * The three float traps, each one first shown to trigger in PYTHON (so the
 * fixture cannot quietly stop exercising the trap) and then compared byte for
 * byte.
 */
describe('the float traps', () => {
  /** Mean 49/25 = 1.96, which rounds to the float 2.0 and prints as `2.0`. */
  const INTEGER_VALUED_FLOAT_MEAN = `${'Aa bb. '.repeat(24)}Cc.`

  /** Mean 6/3 = the int 2, next to a pstdev that is always a float. */
  const INTEGER_MEAN_AND_ZERO_STDEV = 'Aa bb. Cc dd. Ee ff.'

  /** 111 words and one U+2014 EM DASH: 1000 * 1 / 111 rounds to 9.0. */
  const WHOLE_NUMBER_PER_THOUSAND = `${'Alpha beta gamma delta epsilon zeta eta theta iota kappa. '
    .repeat(10)
    .trimEnd()} Lambda\u2014mu nu xi omicron pi rho sigma tau upsilon phi.`

  const CASES: readonly (readonly [string, string, string])[] = [
    ['an integer-valued float mean', INTEGER_VALUED_FLOAT_MEAN, '"mean": 2.0'],
    ['a genuinely integer mean', INTEGER_MEAN_AND_ZERO_STDEV, '"mean": 2,'],
    ['a stdev that is always a float', INTEGER_MEAN_AND_ZERO_STDEV, '"stdev": 0.0'],
    ['a whole-number per-thousand', WHOLE_NUMBER_PER_THOUSAND, '"em_dashes_per_1000": 9.0'],
  ]

  for (const [name, text, needle] of CASES) {
    it(`still exercises ${name} in Python`, () => {
      expect(pythonJson(text).toString('utf8')).toContain(needle)
    })

    it(`renders ${name} exactly as Python does`, () => {
      const result = runCli(['report', '--json'], { input: text })
      expect(result.stdout).toContain(needle)
      expect(result.stdoutBytes.equals(pythonJson(text))).toBe(true)
    })
  }
})

describe('the unwrap rule', () => {
  let root = ''
  let first = ''
  let second = ''
  let missing = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ghostchars-style-'))
    first = join(root, 'a.md')
    second = join(root, 'b.md')
    missing = join(root, 'gone.md')
    writeFileSync(first, 'Aa bb. Cc dd. Ee ff.', 'utf8')
    writeFileSync(second, 'One two three. Four five six. Seven eight nine.', 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('unwraps a single result to a bare report', () => {
    const result = runCli(['report', '--json', first])
    expect(result.code).toBe(0)
    expect(Object.keys(parseObject(result.stdout))[0]).toBe('words')
    expect(result.stdoutBytes.equals(pythonJson('', [first]))).toBe(true)
  })

  it('wraps two results in a label-keyed object', () => {
    const result = runCli(['report', '--json', first, second])
    expect(result.code).toBe(0)
    expect(Object.keys(parseObject(result.stdout))).toEqual([first, second])
    expect(result.stdoutBytes.equals(pythonJson('', [first, second]))).toBe(true)
  })

  it('unwraps when two files produce ONE result, because a file failed to read', () => {
    const result = runCli(['report', '--json', first, missing])
    // The unwrap condition is on the number of RESULTS, not of arguments.
    expect(Object.keys(parseObject(result.stdout))[0]).toBe('words')
    expect(result.stdoutBytes.equals(pythonJson('', [first, missing]))).toBe(true)
    // The one divergence: Python always exits 0 here, we report the failure.
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(missing)
  })

  it('unwraps when the same file is named twice, exactly as a Python dict does', () => {
    const result = runCli(['report', '--json', first, first])
    expect(Object.keys(parseObject(result.stdout))[0]).toBe('words')
    expect(result.stdoutBytes.equals(pythonJson('', [first, first]))).toBe(true)
  })

  it('prints an empty object when every file failed', () => {
    const result = runCli(['report', '--json', missing])
    expect(result.code).toBe(2)
    expect(result.stdoutBytes.equals(pythonJson('', [missing]))).toBe(true)
  })
})
