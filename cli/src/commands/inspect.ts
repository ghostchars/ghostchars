/**
 * `inspect`: the `--show` report, and the one output in this package whose bytes
 * are a contract.
 *
 * BYTE-IDENTICAL TO `strip_invisible.py --show`. The two column widths, the
 * tabs, the two leading spaces and the `U+XXXX` casing all live in
 * `src/format.ts`; this module decides what to hand it and when. The one place
 * the two can still part company is the Unicode NAME column: this engine ships
 * the NameAliases label for a C0 or C1 control and for a few noncharacters,
 * where `unicodedata.name()` has nothing and Python prints `<unnamed>`. That is
 * engine data rather than formatting, and `cli.inspect.test.ts` pins exactly
 * which fixtures it affects rather than papering over it.
 *
 * THE THIRTEEN FLAGS DO NOT CHANGE THIS OUTPUT, exactly as in Python. `scan()` is
 * flag-independent and the note column always names the flag that WOULD be
 * needed, so `inspect --punct` and `inspect` print the same block. Flags change
 * only the JSON `action` field and the `byKind` rollup. Getting this wrong is
 * the most likely porting bug in the package, so it is stated here, tested in
 * `cli.inspect.test.ts`, and stated again in `src/format.ts`.
 */
import { enabledFlags, scan, summarize, toCodePoints } from '@ghostchars/engine'
import type { Action, CleanOptions, Finding, Flag, Kind } from '@ghostchars/engine'

import { DEFAULT_INSPECT_LIMIT } from '../args.js'
import type { ParsedCommand } from '../args.js'
import type { DocumentInspection, PackageKind } from '../doc/index.js'
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, ExitAccumulator, UsageError } from '../exit.js'
import type { ExitCode } from '../exit.js'
import { showBlock } from '../format.js'
import { out, outLine, readStdin } from '../io.js'
import type { InspectResultJson, KindRollupJson, ResultError, SummaryJson } from '../json.js'
import { baseEnvelope, serializeJson, toFindingJson } from '../json.js'
import { nameOf, toFinding } from '../names.js'
import { payloadLines, payloadsIn, payloadsJson } from '../payloads.js'
import { optionNames, readBar, readCleanOptions } from '../options.js'
import type { Bar } from '../options.js'
import * as strings from '../strings.js'

import { kindOf, loadDocModule, readInputBytes, readInputText, reportPackageFailure } from './clean.js'

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

/**
 * Every suspicious character in a text, with the action the resolved options
 * would take on it.
 *
 * `find()` from the engine would do the same walk under the default flag set
 * only, so the `action` field would always read `found-not-targeted` for
 * anything a flag turns on. Running `scan` and `toFinding` here costs the same
 * walk and reports what would actually happen.
 *
 * `toFinding` is `src/names.ts`'s wrapper, not the engine's: it is the engine's
 * finding with the name column filled in for a look-alike letter, which the
 * engine's own name table does not carry.
 */
function findingsFor(text: string, options: CleanOptions): readonly Finding[] {
  const enabled = enabledFlags(options)
  return scan(toCodePoints(text)).map((hit) => toFinding(hit, enabled))
}

/**
 * The `byKind` rollup, in first-appearance order.
 *
 * An agent deciding whether to care needs the shape, not four hundred rows, so
 * this comes before `findings` in the payload. Document order is used rather
 * than a count sort because it is the order the findings themselves are in, and
 * two views of the same data that disagree about order are a small trap.
 */
function rollup(findings: readonly Finding[]): KindRollupJson[] {
  const groups = new Map<string, { kind: Kind; flag: Flag; count: number; action: Action }>()
  for (const finding of findings) {
    const key = `${finding.kind} ${finding.flag}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { kind: finding.kind, flag: finding.flag, count: 1, action: finding.action })
    } else {
      existing.count += 1
    }
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// the document character summary
// ---------------------------------------------------------------------------

/**
 * `clean_file.py`'s `print_char_summary`, in ASCII.
 *
 * The kind rows are sorted by count descending, and Python's `sorted` is stable,
 * so a tie keeps the order the kinds were first seen in. The codepoint rows are
 * `Counter.most_common(8)`, which is the same rule. `Array.prototype.sort` has
 * been stable since ES2019, so building the two maps in document order and
 * sorting by count reproduces both.
 */
function charSummaryLines(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return [strings.charSummaryClean('text')]
  const lines = [strings.charSummaryTotal('text', findings.length)]

  const byKind = new Map<string, { kind: Kind; flag: Flag; count: number }>()
  const byCodepoint = new Map<number, number>()
  for (const finding of findings) {
    const key = `${finding.kind} ${finding.flag}`
    const group = byKind.get(key)
    if (group === undefined) byKind.set(key, { kind: finding.kind, flag: finding.flag, count: 1 })
    else group.count += 1
    byCodepoint.set(finding.cp, (byCodepoint.get(finding.cp) ?? 0) + 1)
  }

  for (const group of [...byKind.values()].sort((a, b) => b.count - a.count)) {
    lines.push(strings.charSummaryKind(group.count, group.kind, group.flag))
  }
  const top = [...byCodepoint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  for (const [cp, count] of top) {
    lines.push(strings.charSummaryCodepoint(cp, count, nameOf(cp)))
  }
  return lines
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

interface Settings {
  readonly bar: Bar
  readonly options: CleanOptions
  readonly json: boolean
  readonly limit: number
  readonly label: string
  readonly forceText: boolean
}

function readSettings(parsed: ParsedCommand): Settings {
  const values = parsed.values
  const bar = readBar(values)
  const mode = values.string('--as') ?? 'auto'
  if (mode !== 'auto' && mode !== 'text') throw new UsageError(strings.errBadAs(mode))
  return {
    bar,
    options: readCleanOptions(values, bar),
    json: values.bool('--json'),
    limit: values.integer('--limit', DEFAULT_INSPECT_LIMIT),
    label: values.string('--stdin-name') ?? strings.STDIN_LABEL,
    forceText: mode === 'text',
  }
}

// ---------------------------------------------------------------------------
// one input
// ---------------------------------------------------------------------------

interface Outcome {
  readonly code: ExitCode
  readonly result: InspectResultJson
}

function failure(path: string, error: ResultError): Outcome {
  return { code: EXIT_USAGE, result: { path, ok: false, error } }
}

/**
 * The half of a result that is the same whether the input was text or a document.
 *
 * `payloads` comes after the findings and before the document report: it is
 * additive, so every key an existing reader knows keeps its place, and it is
 * never capped, because a payload is the one thing in the result a reader must
 * not miss.
 */
function resultFor(
  label: string,
  text: string,
  findings: readonly Finding[],
  settings: Settings,
  document: Readonly<Record<string, unknown>> | undefined,
): InspectResultJson {
  const summary: SummaryJson = summarize(findings)
  const shown = findings.slice(0, Math.max(0, settings.limit))
  const base: InspectResultJson = {
    path: label,
    ok: true,
    clean: findings.length === 0,
    total: findings.length,
    summary,
    byKind: rollup(findings),
    findings: shown.map(toFindingJson),
    findingsTotal: findings.length,
    findingsTruncated: shown.length < findings.length,
    payloads: payloadsJson(text, payloadsIn(text)),
  }
  return document === undefined ? base : { ...base, document }
}

/** Read one input as text, or report why it could not be read. */
async function readInput(
  path: string | null,
  settings: Settings,
): Promise<{ text: string } | { outcome: Outcome }> {
  if (path === null) return { text: await readStdin(settings.label) }
  const read = readInputText(path)
  return read.ok ? { text: read.text } : { outcome: failure(path, read.error) }
}

async function handleText(path: string | null, settings: Settings): Promise<Outcome> {
  const label = path ?? settings.label
  const read = await readInput(path, settings)
  if ('outcome' in read) return read.outcome
  const findings = findingsFor(read.text, settings.options)
  if (!settings.json) {
    for (const line of showBlock(label, findings, settings.limit)) outLine(line)
    for (const line of payloadLines(read.text, payloadsIn(read.text))) outLine(line)
  }
  return {
    code: findings.length === 0 ? EXIT_OK : EXIT_FINDINGS,
    result: resultFor(label, read.text, findings, settings, undefined),
  }
}

/**
 * A document: the character summary over the concatenated document text, then
 * the format's own report.
 *
 * The exit status depends only on the character findings, matching
 * `clean_file.py`: a document with three tracked changes and no hidden
 * characters is reported and still exits 0, because nothing in it is wrong.
 */
function documentOutcome(
  path: string,
  inspection: DocumentInspection,
  settings: Settings,
): Outcome {
  const findings = findingsFor(inspection.text, settings.options)
  if (!settings.json) {
    outLine(strings.documentHeading(path))
    for (const line of charSummaryLines(findings)) outLine(line)
    for (const line of payloadLines(inspection.text, payloadsIn(inspection.text), '    ')) {
      outLine(line)
    }
    for (const line of inspection.reportLines) outLine(line)
  }
  return {
    code: findings.length === 0 ? EXIT_OK : EXIT_FINDINGS,
    result: resultFor(path, inspection.text, findings, settings, {
      // The format's own report first, under `clean_file.py`'s snake_case names,
      // so it diffs key for key against a payload from the reference tool. Then
      // the two things only this implementation can hand back: which parts the
      // text came from, and the text itself. The text goes last because it is
      // the one unbounded value in the payload and a reader that truncates
      // should still have every count.
      ...inspection.report,
      text_parts: inspection.textParts,
      text: inspection.text,
    }),
  }
}

async function handlePackage(
  path: string,
  kind: PackageKind,
  settings: Settings,
): Promise<Outcome> {
  const doc = await loadDocModule()
  const read = readInputBytes(path)
  if (!read.ok) return failure(path, read.error)
  const inspected = await doc.inspectPackage(kind, read.bytes)
  if (!inspected.ok) return failure(path, reportPackageFailure(path, kind, inspected.failure))
  return documentOutcome(path, inspected.value, settings)
}

async function handlePage(path: string, settings: Settings): Promise<Outcome> {
  const doc = await loadDocModule()
  const read = await readInput(path, settings)
  if ('outcome' in read) return read.outcome
  return documentOutcome(path, doc.inspectPage(read.text), settings)
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function totals(results: readonly InspectResultJson[]): SummaryJson & {
  filesClean: number
  filesDirty: number
  payloads: number
} {
  let removed = 0
  let replaced = 0
  let keptLoadBearing = 0
  let foundNotTargeted = 0
  let filesClean = 0
  let filesDirty = 0
  let payloads = 0
  for (const result of results) {
    if (!result.ok) continue
    payloads += result.payloads?.length ?? 0
    const summary = result.summary
    if (summary !== undefined) {
      removed += summary.removed
      replaced += summary.replaced
      keptLoadBearing += summary.keptLoadBearing
      foundNotTargeted += summary.foundNotTargeted
    }
    if (result.clean === true) filesClean += 1
    else filesDirty += 1
  }
  return { removed, replaced, keptLoadBearing, foundNotTargeted, filesClean, filesDirty, payloads }
}

export async function run(parsed: ParsedCommand): Promise<number> {
  const settings = readSettings(parsed)
  const paths = parsed.positionals
  const inputs: readonly (string | null)[] = paths.length === 0 ? [null] : paths

  const exit = new ExitAccumulator()
  const results: InspectResultJson[] = []
  for (const path of inputs) {
    const kind = kindOf(path, settings.forceText)
    const outcome =
      path === null || kind === 'text'
        ? await handleText(path, settings)
        : kind === 'html'
          ? await handlePage(path, settings)
          : await handlePackage(path, kind, settings)
    exit.add(outcome.code)
    results.push(outcome.result)
  }

  const code = exit.code
  if (settings.json) {
    out(
      serializeJson({
        ...baseEnvelope('inspect', code),
        bar: settings.bar,
        options: optionNames(settings.options),
        summary: totals(results),
        results,
      }),
    )
  }
  return code
}
