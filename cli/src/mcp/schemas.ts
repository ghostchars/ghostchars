/**
 * The MCP input and output schemas, and the shared field vocabulary.
 *
 * WHY RAW SHAPES AND NOT `z.object(...)`. `registerTool` in SDK 1.30 accepts
 * either, and the raw-shape form (`{ text: z.string() }`) is the 1.x idiom and
 * what `ZodRawShapeCompat` types. The SDK normalises a shape into an object
 * itself, validates the call arguments against it, and converts it to JSON
 * Schema for `tools/list`, so we get validation and the advertised schema from
 * one declaration instead of a zod schema plus a hand-written JSON Schema that
 * drifts from it.
 *
 * WHY EVERY DESCRIPTION LIVES IN `src/strings.ts`. These strings are read by a
 * model, which makes them user-facing copy, and the repository holds every
 * user-facing sentence to the maximum clean in one gated module. The
 * `.describe()` on {@link BAR} is the highest-leverage string in the package:
 * it is what an agent reads when it decides how hard to clean its own prose.
 *
 * WHY THE STYLE REPORT IS WRITTEN OUT FIELD BY FIELD. A passthrough object
 * would convert to a JSON Schema that either forbids the keys it does not know
 * or describes nothing at all, and a client's own validator would then reject a
 * perfectly good report. Every field of `StyleReport` is declared below, and
 * `mcp.inmemory.test.ts` validates all seventeen golden style fixtures against
 * it, so drift in either direction fails loudly.
 *
 * THERE IS NO `max` GATE BAR, here or anywhere. {@link GATE_BAR} has two
 * values. `max` folds look-alike Cyrillic and Greek letters and applies NFKC,
 * which rewrites letters: it would condemn legitimate content, and a gate that
 * fails on a repository's real text gets deleted by the people who installed
 * it.
 */
import { z } from 'zod'

import * as strings from '../strings.js'

// ---------------------------------------------------------------------------
// shared input vocabulary
// ---------------------------------------------------------------------------

/** How hard to clean, for the tools that change or examine text. */
export const BAR = z
  .enum(['default', 'text', 'max'])
  .default('text')
  .describe(strings.BAR_DESCRIPTION)

/** How hard the gate holds a file. Two values, and the description says why. */
export const GATE_BAR = z
  .enum(['default', 'text'])
  .default('default')
  .describe(strings.GATE_BAR_DESCRIPTION)

/**
 * The thirteen per-option overrides.
 *
 * They can only turn an option ON, exactly as the CLI's flags can: the
 * reference implementation has no `--no-punct`, so neither do we, and
 * subtracting from a bar would make the resolution order observable in a way
 * nobody could predict.
 */
export const OPTIONS = z
  .object({
    aggressive: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.aggressive),
    spaces: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.spaces),
    newlines: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.newlines),
    bidi: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.bidi),
    controls: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.controls),
    pua: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.pua),
    punct: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.punct),
    confusables: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.confusables),
    nfc: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.nfc),
    nfkc: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.nfkc),
    gutters: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.gutters),
    trailing: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.trailing),
    collapse: z.boolean().optional().describe(strings.OPTION_DESCRIPTIONS.collapse),
  })
  .optional()
  .describe(strings.OPTIONS_DESCRIPTION)

// ---------------------------------------------------------------------------
// shared output shapes
// ---------------------------------------------------------------------------

/**
 * One suspicious character. `cp` is the number a consumer compares against a
 * fixture; `u` is the `U+XXXX` string a person greps for. `replacement` is
 * absent, not empty, for a deletion.
 */
export const FINDING = z.object({
  line: z.number().int(),
  col: z.number().int(),
  cp: z.number().int(),
  u: z.string(),
  name: z.string(),
  kind: z.string(),
  flag: z.string(),
  action: z.string(),
  replacement: z.string().optional(),
})

/**
 * One hidden payload: what a run of hidden characters was carrying. `text` is
 * null for a fingerprint, and otherwise written by whoever hid it.
 */
export const PAYLOAD = z.object({
  scheme: z.string(),
  confidence: z.enum(['decoded', 'fingerprint']),
  line: z.number().int(),
  col: z.number().int(),
  start: z.number().int(),
  end: z.number().int(),
  bits: z.number().int(),
  hex: z.string(),
  text: z.string().nullable(),
})

/** The `payloads` field every text-reading tool returns. */
const PAYLOADS = z.array(PAYLOAD).describe(strings.MCP_FIELDS.payloads)

/** The engine's four action buckets, in the snake_case the MCP surface uses. */
export const SUMMARY = z.object({
  removed: z.number().int(),
  replaced: z.number().int(),
  kept_load_bearing: z.number().int(),
  found_not_targeted: z.number().int(),
})

/**
 * A dash position where the mechanical substitution is correct and the sentence
 * still reads worse afterwards. Nothing else in this ecosystem reports these.
 */
export const REWRITE_SITE = z.object({
  line: z.number().int(),
  col: z.number().int(),
  u: z.string(),
  name: z.string(),
  hint: z.string(),
})

// ---------------------------------------------------------------------------
// clean_text
// ---------------------------------------------------------------------------

export const CLEAN_TEXT_INPUT = {
  text: z.string().describe(strings.MCP_FIELDS.text),
  bar: BAR,
  options: OPTIONS,
  max_findings: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(50)
    .describe(strings.MCP_FIELDS.maxFindingsClean),
}

export const CLEAN_TEXT_OUTPUT = {
  changed: z.boolean().describe(strings.MCP_FIELDS.changed),
  cleaned: z.string().optional().describe(strings.MCP_FIELDS.cleaned),
  chars_before: z.number().int(),
  chars_after: z.number().int(),
  options_applied: z.array(z.string()),
  summary: SUMMARY,
  rewrite_sites: z.array(REWRITE_SITE).describe(strings.MCP_FIELDS.rewriteSites),
  rewrite_sites_total: z.number().int().describe(strings.MCP_FIELDS.rewriteSitesTotal),
  rewrite_sites_truncated: z.boolean(),
  findings: z.array(FINDING).describe(strings.MCP_FIELDS.findings),
  findings_total: z.number().int(),
  findings_truncated: z.boolean(),
  payloads: PAYLOADS,
}

// ---------------------------------------------------------------------------
// inspect_text
// ---------------------------------------------------------------------------

export const INSPECT_TEXT_INPUT = {
  text: z.string().describe(strings.MCP_FIELDS.inspectText),
  bar: BAR,
  options: OPTIONS,
  max_findings: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe(strings.MCP_FIELDS.maxFindingsInspect),
}

export const INSPECT_TEXT_OUTPUT = {
  clean: z.boolean(),
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  summary: SUMMARY,
  by_kind: z.array(
    z.object({ kind: z.string(), flag: z.string(), count: z.number().int() }),
  ),
  findings: z.array(FINDING).describe(strings.MCP_FIELDS.findings),
  payloads: PAYLOADS,
}

// ---------------------------------------------------------------------------
// style_report
// ---------------------------------------------------------------------------

const OBSERVATION = z.object({
  severity: z.string(),
  title: z.string(),
  detail: z.string(),
})

const HISTOGRAM = z.object({
  '1-8': z.number().int(),
  '9-15': z.number().int(),
  '16-25': z.number().int(),
  '26-40': z.number().int(),
  '41+': z.number().int(),
})

const SENTENCE_LENGTH = z.object({
  mean: z.number(),
  stdev: z.number(),
  cv: z.number(),
  min: z.number().int(),
  max: z.number().int(),
  histogram: HISTOGRAM,
})

const PARAGRAPH_SHAPE = z.object({
  sentences_per_paragraph_mean: z.number(),
  stdev: z.number(),
})

/** A word-to-count tally. Open by construction: the words are the data. */
const COUNTS = z.record(z.string(), z.number().int())

export const STYLE_REPORT_INPUT = {
  text: z.string().describe(strings.MCP_FIELDS.styleText),
}

/**
 * The whole report, field by field, in the insertion order `analyzeStyle`
 * produces. Two fields are genuinely optional: `sentence_length` is absent for
 * a text with fewer than two sentences and `paragraph_shape` for one with
 * fewer than four paragraphs.
 */
export const STYLE_REPORT_OUTPUT = {
  words: z.number().int(),
  sentences: z.number().int(),
  paragraphs: z.number().int(),
  observations: z.array(OBSERVATION),
  sentence_length: SENTENCE_LENGTH.optional(),
  paragraph_shape: PARAGRAPH_SHAPE.optional(),
  tell_words: COUNTS,
  tell_phrases: COUNTS,
  tell_density_per_1000: z.number(),
  sentence_initial_transitions: COUNTS,
  em_dashes_per_1000: z.number(),
  not_x_but_y: z.number().int(),
  tricolons: z.number().int(),
  hedges_per_1000: z.number(),
  bullets: z.number().int(),
  headings: z.number().int(),
  bold_lead_bullets: z.number().int(),
  contractions_per_1000: z.number(),
  first_person_per_1000: z.number(),
  numbers_per_1000: z.number(),
  proper_nouns_per_1000: z.number(),
  summary: z.object({
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }),
}

/** The same shape as a parseable object, for tests and in-process validation. */
export const STYLE_REPORT_SCHEMA = z.object(STYLE_REPORT_OUTPUT)

// ---------------------------------------------------------------------------
// check_paths
// ---------------------------------------------------------------------------

export const CHECK_PATHS_INPUT = {
  paths: z.array(z.string()).min(1).describe(strings.MCP_FIELDS.paths),
  bar: GATE_BAR,
  options: OPTIONS,
  config: z.string().optional().describe(strings.MCP_FIELDS.config),
  max_files: z.number().int().min(1).max(20_000).default(2000).describe(strings.MCP_FIELDS.maxFiles),
  max_findings_per_file: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe(strings.MCP_FIELDS.maxFindingsPerFile),
}

export const CHECK_PATHS_OUTPUT = {
  ok: z.boolean(),
  root: z.string(),
  // Which ghostchars.json governed the run, or null when none did. An agent
  // reading a failure needs to know whether a config chose that bar and those
  // pins, or whether it is looking at the tool's own defaults.
  config: z.string().nullable().describe(strings.MCP_FIELDS.configUsed),
  files_scanned: z.number().int(),
  files_skipped: z.number().int(),
  files_failing: z.number().int(),
  truncated: z.boolean(),
  failures: z.array(
    z.object({
      path: z.string(),
      bar: z.string(),
      status: z.string(),
      changed: z.number().int(),
      pinned: z.number().int(),
      hits: z.array(
        z.object({
          line: z.number().int(),
          col: z.number().int(),
          u: z.string(),
          name: z.string(),
          line_text: z.string(),
        }),
      ),
      payloads: PAYLOADS,
    }),
  ),
}

// ---------------------------------------------------------------------------
// clean_files
// ---------------------------------------------------------------------------

export const CLEAN_FILES_INPUT = {
  paths: z.array(z.string()).min(1).describe(strings.MCP_FIELDS.cleanPaths),
  bar: BAR,
  options: OPTIONS,
  dry_run: z.boolean().default(false).describe(strings.MCP_FIELDS.dryRun),
}

export const CLEAN_FILES_OUTPUT = {
  changed: z.array(
    z.object({
      path: z.string(),
      removed: z.number().int(),
      replaced: z.number().int(),
      chars_delta: z.number().int(),
      rewrite_sites: z.array(REWRITE_SITE),
      rewrite_sites_total: z.number().int().describe(strings.MCP_FIELDS.rewriteSitesTotal),
    }),
  ),
  unchanged: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
}
