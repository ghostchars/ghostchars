/**
 * The golden fixture loader.
 *
 * WHY `readFileSync` PLUS ZOD, AND NEVER AN `import`. The file is 314 KB. A
 * `resolveJsonModule` import would slow every typecheck down for an inferred
 * type far wider than the handful of fields these tests read, and would bundle
 * the whole corpus into a test build. Parsing also means a regenerated fixture
 * with a different shape fails here, loudly, instead of silently comparing
 * `undefined` to `undefined` in twenty assertions.
 *
 * WHY THE COUNTS ARE READ FROM THE FILE. `meta.counts` is the fixture's own
 * statement about itself: 139 text fixtures, 17 style, 4 documents, 14 combos
 * at the time of writing. Hardcoding a count here would pin a test to a stale
 * document rather than to the data.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { CLEAN_OPTION_KEYS, FLAGS, KINDS } from '@ghostchars/engine'
import type { CleanOptionKey, CleanOptions } from '@ghostchars/engine'

import { OPTION_FLAGS } from '../../src/options.js'

/** `[line, col, cp, kind, flag]`, 1-based and counted in codepoints. */
const FINDING_TUPLE = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int().nonnegative(),
  z.enum(KINDS),
  z.enum(FLAGS),
])

/**
 * The style report is carried through as an opaque record rather than field by
 * field. `z.record` keeps every key, where an object schema would silently drop
 * the ones it does not know, and dropping a key from a parity fixture is the
 * one failure mode a fixture loader must not have.
 */
const OPAQUE = z.record(z.string(), z.unknown())

const GOLDEN_SCHEMA = z.object({
  meta: z.object({
    generator: z.string(),
    unicodeVersion: z.string(),
    note: z.string(),
    sources: z.array(z.string()),
    counts: z.object({
      text: z.number().int(),
      style: z.number().int(),
      documents: z.number().int(),
      combos: z.number().int(),
    }),
  }),
  combos: z.array(z.object({ id: z.string().min(1), options: z.array(z.enum(CLEAN_OPTION_KEYS)) })),
  docFlagSets: z.array(z.object({ id: z.string().min(1), options: z.array(z.string()) })),
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
  style: z.array(
    z.object({
      id: z.string().min(1),
      group: z.string().min(1),
      note: z.string(),
      text: z.string(),
      report: OPAQUE,
    }),
  ),
  /**
   * The four document fixtures do not share one shape, and the schema says so
   * rather than papering over it: a package fixture (`docx`, `odt`) carries
   * `bytesB64`, `entries`, `textParts` and a `parts` map, and each cleaned
   * result is an object. The `html` fixture carries a `source` string and each
   * cleaned result IS the cleaned string.
   */
  documents: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(['docx', 'odt', 'html']),
      note: z.string(),
      textParts: z.array(z.string()).optional(),
      text: z.string(),
      findings: z.array(FINDING_TUPLE),
      inspect: OPAQUE,
      entries: z.array(z.object({ name: z.string(), compress: z.string() })).optional(),
      parts: OPAQUE.optional(),
      bytesB64: z.string().optional(),
      source: z.string().optional(),
      cleaned: z.record(z.string(), z.union([OPAQUE, z.string()])),
    }),
  ),
})

export type Golden = z.infer<typeof GOLDEN_SCHEMA>
export type TextFixture = Golden['text'][number]
export type StyleFixture = Golden['style'][number]
export type DocumentFixture = Golden['documents'][number]
export type Combo = Golden['combos'][number]

const GOLDEN_PATH = fileURLToPath(
  new URL('../../../web/src/engine/__fixtures__/golden.json', import.meta.url),
)

export const golden: Golden = GOLDEN_SCHEMA.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))

/** A combo's option-name list, widened back into the full twelve switches. */
export function optionsFor(names: readonly CleanOptionKey[]): CleanOptions {
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

/**
 * The command-line flags that turn a combo on, long spellings only.
 *
 * The parity replay builds one invocation per combo from this, so the flags the
 * test passes are the flags the package documents rather than a second list
 * that can drift from the first.
 */
export function comboFlags(names: readonly CleanOptionKey[]): string[] {
  const enabled = new Set<CleanOptionKey>(names)
  return OPTION_FLAGS.filter((spec) => enabled.has(spec.key)).map((spec) => spec.long)
}

/**
 * The two fixtures that are NOT a fixed point under a second `--max` clean, in
 * fixture order, and the reasons.
 *
 * `gutter-nested`: `--gutters` removes one quote bar per line and does not
 * loop, so a line quoted with two different bars loses the outer one on the
 * first run and the inner one on the second. That is the rule, by design.
 *
 * `prose-realistic-mixed`: `--collapse` is a pre-pass that runs BEFORE invisible characters
 * are deleted, so a tag-smuggled payload sitting between two spaces is not
 * collapsed on the first pass (there is nothing visible to collapse yet), is
 * then deleted, and leaves a double space that only collapses on a second run.
 * Python behaves identically. It is inherited and pinned, not fixed.
 */
export const NOT_IDEMPOTENT_UNDER_MAX = new Set(['gutter-nested', 'prose-realistic-mixed'])
