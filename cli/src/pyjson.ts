/**
 * `report --json`, byte-identical to `python3 style_report.py --json`.
 *
 * WHY THIS FILE EXISTS AT ALL. `JSON.stringify` cannot print Python's `12.0`,
 * and whether a value in this report is an int or a float is DATA-dependent,
 * not key-dependent:
 *
 * - `statistics.mean([2, 2])` returns the INT `2`, and `round(int, 1)` returns
 *   an int, so `sentence_length.mean` is an int exactly when the arithmetic
 *   mean of the sentence word counts is a whole number.
 * - `statistics.pstdev(...)` always returns a float, so `stdev` prints `0.0`,
 *   never `0`.
 * - `cv = sd / mean if mean else 0` is the INT `0` when the mean is zero, and a
 *   float otherwise.
 * - `per_k` is `round(1000 * n / words, 1) if words else 0.0`: always a float.
 *
 * THE NAIVE PROXY IS WRONG. `Number.isInteger(value)` looks like it would work
 * and does not: twenty-four sentences of two words and one of one word give an
 * exact mean of 1.96, and `round(1.96, 1)` is the FLOAT `2.0`, which Python
 * prints as `2.0` and `Number.isInteger` would call an int. So the decision is
 * taken from the DATA, by recomputing the sentence word counts and the
 * per-paragraph sentence counts from the engine's own exported helpers.
 *
 * The float text itself comes from the engine's `pyFloatText`, the same
 * function that already formats the numbers inside observation details. A
 * second copy of a parity-critical Python-float formatter in this repository is
 * exactly what the shared engine exists to prevent.
 *
 * KEY ORDER. Python dicts keep insertion order and `style_report.py` inserts
 * `observations` fourth and `summary` last, so {@link STYLE_KEY_ORDER} is that
 * order, written down. `golden.json` cannot prove this: `gen_golden.py` dumps
 * the reports with `sort_keys=True`.
 */
import {
  paragraphs,
  pyFloatText,
  sentences,
  wordCount,
  type StyleObservation,
  type StyleReport,
} from '@ghostchars/engine/style'

// ---------------------------------------------------------------------------
// the Python value model
// ---------------------------------------------------------------------------

type PyValue =
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'dict'; readonly entries: readonly (readonly [string, PyValue])[] }
  | { readonly kind: 'list'; readonly items: readonly PyValue[] }

const int = (value: number): PyValue => ({ kind: 'int', value })
const float = (value: number): PyValue => ({ kind: 'float', value })
const str = (value: string): PyValue => ({ kind: 'str', value })

/**
 * `json.dumps(obj, indent=1, ensure_ascii=False)`.
 *
 * With an indent, Python separates items with `,` and keys from values with
 * `: `, and prints an empty container as `{}` or `[]` with no newline inside.
 * String escaping is identical to `JSON.stringify`'s for every input this
 * report can produce: both escape the quote, the backslash and everything below
 * U+0020, and neither escapes anything above U+007E once `ensure_ascii` is off.
 */
export function dumps(value: PyValue, indent = 1): string {
  return render(value, indent, 0)
}

function render(value: PyValue, indent: number, depth: number): string {
  switch (value.kind) {
    case 'int':
      return String(value.value)
    case 'float':
      return pyFloatText(value.value)
    case 'str':
      return JSON.stringify(value.value)
    case 'list': {
      if (value.items.length === 0) return '[]'
      const pad = ' '.repeat(indent * (depth + 1))
      const body = value.items.map((item) => pad + render(item, indent, depth + 1)).join(',\n')
      return `[\n${body}\n${' '.repeat(indent * depth)}]`
    }
    case 'dict': {
      if (value.entries.length === 0) return '{}'
      const pad = ' '.repeat(indent * (depth + 1))
      const body = value.entries
        .map(([key, item]) => `${pad}${JSON.stringify(key)}: ${render(item, indent, depth + 1)}`)
        .join(',\n')
      return `{\n${body}\n${' '.repeat(indent * depth)}}`
    }
  }
}

// ---------------------------------------------------------------------------
// the report's key order
// ---------------------------------------------------------------------------

/** The insertion order `style_report.py`'s `analyze()` produces, top level. */
export const STYLE_KEY_ORDER: readonly string[] = [
  'words',
  'sentences',
  'paragraphs',
  'observations',
  'sentence_length',
  'paragraph_shape',
  'tell_words',
  'tell_phrases',
  'tell_density_per_1000',
  'sentence_initial_transitions',
  'em_dashes_per_1000',
  'not_x_but_y',
  'tricolons',
  'hedges_per_1000',
  'bullets',
  'headings',
  'bold_lead_bullets',
  'contractions_per_1000',
  'first_person_per_1000',
  'numbers_per_1000',
  'proper_nouns_per_1000',
  'summary',
]

/** `sentence_length`'s own key order, and the histogram's. */
export const SENTENCE_LENGTH_KEY_ORDER: readonly string[] = [
  'mean',
  'stdev',
  'cv',
  'min',
  'max',
  'histogram',
]
export const HISTOGRAM_KEY_ORDER: readonly string[] = ['1-8', '9-15', '16-25', '26-40', '41+']
export const PARAGRAPH_SHAPE_KEY_ORDER: readonly string[] = [
  'sentences_per_paragraph_mean',
  'stdev',
]
export const OBSERVATION_KEY_ORDER: readonly string[] = ['severity', 'title', 'detail']
export const SUMMARY_KEY_ORDER: readonly string[] = ['high', 'medium', 'low']

// ---------------------------------------------------------------------------
// int versus float, decided from the data
// ---------------------------------------------------------------------------

/** What the text itself says about the two means Python may print as ints. */
export interface StyleFacts {
  /** Word count per sentence, in document order. */
  readonly sentenceLengths: readonly number[]
  /** Sentence count per paragraph, in document order. */
  readonly sentencesPerParagraph: readonly number[]
  /** `statistics.mean(lens)` is an int: `sum % n == 0`. */
  readonly meanIsInt: boolean
  /** `cv` is the int `0`, which happens only when the mean is zero. */
  readonly cvIsInt: boolean
  /** `statistics.mean(per_par)` is an int. */
  readonly paragraphMeanIsInt: boolean
}

const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0)

/** Recompute what `analyze()` computed, using the engine's own splitters. */
export function styleFacts(text: string): StyleFacts {
  const pars = paragraphs(text)
  const sents = pars.flatMap((paragraph) => sentences(paragraph))
  const lens = sents.map((sentence) => wordCount(sentence))
  const perPar = pars.map((paragraph) => sentences(paragraph).length)
  const total = sum(lens)
  return {
    sentenceLengths: lens,
    sentencesPerParagraph: perPar,
    meanIsInt: lens.length > 0 && total % lens.length === 0,
    cvIsInt: total === 0,
    paragraphMeanIsInt: perPar.length > 0 && sum(perPar) % perPar.length === 0,
  }
}

/**
 * The rendered text of every number the human report prints, so the ASCII
 * render and the JSON agree on `2` versus `2.0` without deciding twice.
 */
export interface StyleTexts {
  readonly mean: string
  readonly stdev: string
  readonly cv: string
  readonly tellDensity: string
  readonly emDashes: string
  readonly hedges: string
  readonly contractions: string
  readonly firstPerson: string
  readonly numbers: string
  readonly properNouns: string
  readonly paragraphMean: string
  readonly paragraphStdev: string
}

export function styleTexts(report: StyleReport, facts: StyleFacts): StyleTexts {
  const length = report.sentence_length
  const shape = report.paragraph_shape
  return {
    mean: length === undefined ? '' : numberText(length.mean, facts.meanIsInt),
    stdev: length === undefined ? '' : pyFloatText(length.stdev),
    cv: length === undefined ? '' : numberText(length.cv, facts.cvIsInt),
    tellDensity: pyFloatText(report.tell_density_per_1000),
    emDashes: pyFloatText(report.em_dashes_per_1000),
    hedges: pyFloatText(report.hedges_per_1000),
    contractions: pyFloatText(report.contractions_per_1000),
    firstPerson: pyFloatText(report.first_person_per_1000),
    numbers: pyFloatText(report.numbers_per_1000),
    properNouns: pyFloatText(report.proper_nouns_per_1000),
    paragraphMean:
      shape === undefined
        ? ''
        : numberText(shape.sentences_per_paragraph_mean, facts.paragraphMeanIsInt),
    paragraphStdev: shape === undefined ? '' : pyFloatText(shape.stdev),
  }
}

function numberText(value: number, isInt: boolean): string {
  return isInt ? String(value) : pyFloatText(value)
}

// ---------------------------------------------------------------------------
// the report as a Python value
// ---------------------------------------------------------------------------

function recordValue(record: Readonly<Record<string, number>>): PyValue {
  return { kind: 'dict', entries: Object.entries(record).map(([key, n]) => [key, int(n)]) }
}

function observationValue(observation: StyleObservation): PyValue {
  return {
    kind: 'dict',
    entries: [
      ['severity', str(observation.severity)],
      ['title', str(observation.title)],
      ['detail', str(observation.detail)],
    ],
  }
}

/** One report, as the exact tree `style_report.py` hands to `json.dumps`. */
export function styleReportValue(report: StyleReport, facts: StyleFacts): PyValue {
  const entries: (readonly [string, PyValue])[] = [
    ['words', int(report.words)],
    ['sentences', int(report.sentences)],
    ['paragraphs', int(report.paragraphs)],
    ['observations', { kind: 'list', items: report.observations.map(observationValue) }],
  ]

  const length = report.sentence_length
  if (length !== undefined) {
    const histogram = HISTOGRAM_KEY_ORDER.map((bucket): readonly [string, PyValue] => [
      bucket,
      int(bucketCount(length.histogram, bucket)),
    ])
    entries.push([
      'sentence_length',
      {
        kind: 'dict',
        entries: [
          ['mean', facts.meanIsInt ? int(length.mean) : float(length.mean)],
          ['stdev', float(length.stdev)],
          ['cv', facts.cvIsInt ? int(length.cv) : float(length.cv)],
          ['min', int(length.min)],
          ['max', int(length.max)],
          ['histogram', { kind: 'dict', entries: histogram }],
        ],
      },
    ])
  }

  const shape = report.paragraph_shape
  if (shape !== undefined) {
    entries.push([
      'paragraph_shape',
      {
        kind: 'dict',
        entries: [
          [
            'sentences_per_paragraph_mean',
            facts.paragraphMeanIsInt
              ? int(shape.sentences_per_paragraph_mean)
              : float(shape.sentences_per_paragraph_mean),
          ],
          ['stdev', float(shape.stdev)],
        ],
      },
    ])
  }

  entries.push(
    ['tell_words', recordValue(report.tell_words)],
    ['tell_phrases', recordValue(report.tell_phrases)],
    ['tell_density_per_1000', float(report.tell_density_per_1000)],
    ['sentence_initial_transitions', recordValue(report.sentence_initial_transitions)],
    ['em_dashes_per_1000', float(report.em_dashes_per_1000)],
    ['not_x_but_y', int(report.not_x_but_y)],
    ['tricolons', int(report.tricolons)],
    ['hedges_per_1000', float(report.hedges_per_1000)],
    ['bullets', int(report.bullets)],
    ['headings', int(report.headings)],
    ['bold_lead_bullets', int(report.bold_lead_bullets)],
    ['contractions_per_1000', float(report.contractions_per_1000)],
    ['first_person_per_1000', float(report.first_person_per_1000)],
    ['numbers_per_1000', float(report.numbers_per_1000)],
    ['proper_nouns_per_1000', float(report.proper_nouns_per_1000)],
    [
      'summary',
      {
        kind: 'dict',
        entries: [
          ['high', int(report.summary.high)],
          ['medium', int(report.summary.medium)],
          ['low', int(report.summary.low)],
        ],
      },
    ],
  )

  return { kind: 'dict', entries }
}

function bucketCount(histogram: Readonly<Record<string, number>>, bucket: string): number {
  return histogram[bucket] ?? 0
}

/** One analyzed file, as `report` collected it. */
export interface StyleResult {
  readonly label: string
  readonly text: string
  readonly report: StyleReport
}

/**
 * The whole `report --json` payload.
 *
 * THE UNWRAP CONDITION IS ON THE NUMBER OF RESULTS, not the number of file
 * arguments: `json.dumps(results if len(results) != 1 else the-only-value)`.
 * Two files where one fails to read therefore produce an unwrapped bare object,
 * and a test pins exactly that case.
 */
export function stringifyStyleJson(results: readonly StyleResult[]): string {
  const values = results.map(
    (result): readonly [string, PyValue] => [
      result.label,
      styleReportValue(result.report, styleFacts(result.text)),
    ],
  )
  const only = values.length === 1 ? values[0] : undefined
  const payload: PyValue = only === undefined ? { kind: 'dict', entries: values } : only[1]
  return `${dumps(payload)}\n`
}
