/**
 * Golden parity: the TypeScript engine against the Python CLI.
 *
 * `tools/gen_golden.py` runs `strip_invisible.py` over every text fixture: the 26
 * listed codepoints, every context-aware case in `tests/test_strip_invisible.py`,
 * the eleven stego payloads, terminal quote bars, punctuation, normalisation, confusables, CRLF, a
 * 2 700-character realistic essay, and records, per fixture, the findings once
 * and the cleaned text once per flag combination. This file replays all of it.
 *
 * The fixture is parsed with zod rather than imported: it is about 320 KB, so a
 * `resolveJsonModule` import would slow `tsc` down for an inferred type far
 * wider than the four fields this test reads. Parsing also means a malformed or
 * regenerated-with-a-different-shape fixture fails here, loudly, instead of
 * silently comparing `undefined` to `undefined`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { clean, cleanText, find, summarize } from '../index'
import { TABLES_UNICODE_VERSION } from '../tables'
import { CLEAN_OPTION_KEYS, FLAGS, KINDS } from '../types'
import type { CleanOptionKey, CleanOptions } from '../types'

const FINDING_TUPLE = z.tuple([
  z.number().int().positive(), // line, 1-based, counted in codepoints
  z.number().int().positive(), // col, 1-based, counted in codepoints
  z.number().int().nonnegative(), // codepoint
  z.enum(KINDS),
  z.enum(FLAGS),
])

const GOLDEN_SCHEMA = z.object({
  meta: z.object({
    unicodeVersion: z.string(),
    counts: z.object({ combos: z.number().int(), text: z.number().int() }),
  }),
  combos: z.array(
    z.object({
      id: z.string().min(1),
      options: z.array(z.enum(CLEAN_OPTION_KEYS)),
    }),
  ),
  text: z.array(
    z.object({
      id: z.string().min(1),
      group: z.string().min(1),
      note: z.string(),
      text: z.string(),
      findings: z.array(FINDING_TUPLE),
      cleaned: z.record(z.string(), z.string()),
    }),
  ),
})

const goldenPath = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))
const golden = GOLDEN_SCHEMA.parse(JSON.parse(readFileSync(goldenPath, 'utf8')))

/** A combo's option-name list, widened back into the full thirteen switches. */
function optionsFor(names: readonly CleanOptionKey[]): CleanOptions {
  const enabled = new Set<CleanOptionKey>(names)
  return {
    aggressive: enabled.has('aggressive'),
    spaces: enabled.has('spaces'),
    newlines: enabled.has('newlines'),
    bidi: enabled.has('bidi'),
    controls: enabled.has('controls'),
    pua: enabled.has('pua'),
    punct: enabled.has('punct'),
    confusables: enabled.has('confusables'),
    nfc: enabled.has('nfc'),
    nfkc: enabled.has('nfkc'),
    gutters: enabled.has('gutters'),
    trailing: enabled.has('trailing'),
    collapse: enabled.has('collapse'),
  }
}

const COMBOS = golden.combos.map((combo) => ({ id: combo.id, options: optionsFor(combo.options) }))

describe('golden fixture', () => {
  it('was generated from the same UCD version the tables were', () => {
    expect(golden.meta.unicodeVersion).toBe(TABLES_UNICODE_VERSION)
  })

  it('carries the fixture and combo counts its own metadata claims', () => {
    expect(golden.text).toHaveLength(golden.meta.counts.text)
    expect(golden.combos).toHaveLength(golden.meta.counts.combos)
  })

  it('covers every kind and every flag the classifier can return', () => {
    const kinds = new Set(golden.text.flatMap((f) => f.findings.map((hit) => hit[3])))
    const flags = new Set(golden.text.flatMap((f) => f.findings.map((hit) => hit[4])))
    expect([...kinds].sort()).toEqual([...KINDS].sort())
    // `-s`, `-n`, `--punct`, `--confusables`, `--controls`, `--pua`, `--bidi`,
    // `--gutters`, `-a` and `default`: every flag a finding can carry.
    expect([...flags].sort()).toEqual([...FLAGS].sort())
  })
})

describe('find() == python find()', () => {
  it.each(golden.text)('$group/$id: $note', (fixture) => {
    const actual = find(fixture.text).map((hit) => [hit.line, hit.col, hit.cp, hit.kind, hit.flag])
    expect(actual).toEqual(fixture.findings)
  })
})

describe('clean() == python clean(), every flag combination', () => {
  it.each(golden.text)('$group/$id: $note', (fixture) => {
    const actual: Record<string, string> = {}
    for (const combo of COMBOS) actual[combo.id] = cleanText(fixture.text, combo.options)
    expect(actual).toEqual(fixture.cleaned)
  })
})

describe('clean() self-consistency', () => {
  it.each(golden.text)('$group/$id', (fixture) => {
    for (const combo of COMBOS) {
      const result = clean(fixture.text, combo.options)
      expect(result.text, `${fixture.id} / ${combo.id}: text`).toBe(cleanText(fixture.text, combo.options))
      expect(result.summary, `${fixture.id} / ${combo.id}: summary`).toEqual(summarize(result.findings))
      expect(result.findings.length, `${fixture.id} / ${combo.id}: finding count`).toBe(
        fixture.findings.length,
      )
    }
  })

  /**
   * `--max` is idempotent for every fixture but two, and the exceptions are the
   * Python's behaviour too (verified against the CLI, not assumed).
   *
   * `--collapse` is a *pre-pass*: it runs before any invisible character is
   * deleted. In `prose-realistic-mixed` a tag-smuggled payload sits between two
   * spaces, so the first run collapses nothing and then deletes the payload,
   * leaving `line  hidden`; a second run collapses that pair. Matching the
   * Python matters more than a tidier fixed point, so the port keeps the
   * ordering, and pins the exception here so neither side can drift silently.
   *
   * `gutter-nested` is the second, and by design: `--gutters` removes one bar
   * per line and does not loop, so `\u2502 \u258e mixed` loses its outer bar on
   * the first run and its inner one on the second.
   */
  const NOT_IDEMPOTENT_UNDER_MAX: ReadonlySet<string> = new Set(['prose-realistic-mixed', 'gutter-nested'])

  it.each(golden.text)('$group/$id reaches a fixed point under --max', (fixture) => {
    const maxCombo = COMBOS.find((combo) => combo.id === '--max')
    expect(maxCombo).toBeDefined()
    if (maxCombo === undefined) return
    const once = cleanText(fixture.text, maxCombo.options)
    const twice = cleanText(once, maxCombo.options)
    expect(twice === once).toBe(!NOT_IDEMPOTENT_UNDER_MAX.has(fixture.id))
    expect(cleanText(twice, maxCombo.options)).toBe(twice)
  })
})
