/**
 * The human renderers: the `--show` block, the ASCII style report, and the
 * gate's failure listing.
 *
 * BYTE-IDENTITY IS A TEST, NOT A CLAIM. {@link showBlock} reproduces
 * `strip_invisible.py --show` character for character, padding included, and
 * `cli.inspect.test.ts` asserts it against the Python's real stdout. The two
 * column widths (15 and 20) and the tabs are not decoration; they are the
 * format somebody's grep already depends on.
 *
 * THE STYLE REPORT IS THE ONE DELIBERATE EXCEPTION. `style_report.py` separates
 * with a middle dot, prints the sentence-length range with an en dash, and puts
 * a multiplication sign between a tell and its count. We print `, `, ` to ` and
 * `x`. Measured: of those three only the en dash would be changed by our own
 * maximum clean, and we went fully ASCII anyway so that `src/strings.ts` needs
 * no hygiene pin and no shipped bundle holds a byte above 0x7F. Byte parity for
 * `report` lives in `--json`, where it belongs.
 *
 * WHAT MUST NOT BE STRIPPED: an observation's `detail` comes from the engine
 * and contains the engine's own U+00D7 in its `word x count` lists. That is
 * engine data, not our format string, it survives the maximum clean untouched,
 * and rewriting it would break `--json` parity. It is passed through exactly as
 * the engine produced it.
 */
import type { Finding } from '@ghostchars/engine'
import type { StyleReport } from '@ghostchars/engine/style'

import type { CheckFailureJson, CheckSkipJson } from './json.js'
import type { PayloadJson } from './payloads.js'
import { escapeMessage } from './payloads.js'
import { contextLine } from './positions.js'
import { styleFacts, styleTexts } from './pyjson.js'
import * as strings from './strings.js'

// ---------------------------------------------------------------------------
// inspect: the --show block
// ---------------------------------------------------------------------------

/** `{kind:<15}` in the Python format string. */
const KIND_WIDTH = 15
/** `{note:<20}` in the Python format string. */
const NOTE_WIDTH = 20

/** One finding row, exactly as `strip_invisible.py --show` prints it. */
export function showLine(finding: Finding): string {
  const note = strings.needsNote(finding.flag)
  const label = strings.codepointLabel(finding.cp)
  return (
    `  ${finding.line}:${finding.col}\t${label}\t` +
    `${finding.kind.padEnd(KIND_WIDTH)} ${note.padEnd(NOTE_WIDTH)} ${finding.name}`
  )
}

/**
 * The whole block for one input, including the clean case.
 *
 * `limit` caps the printed rows and appends the count of what was left out.
 * The flags do NOT change this output, exactly as in Python: `find()` is
 * flag-independent and the note column always names the flag that WOULD be
 * needed. Flags change only the JSON `action` field and the `byKind` rollup.
 * Stating that here prevents the most likely porting bug in the package.
 */
export function showBlock(label: string, findings: readonly Finding[], limit: number): string[] {
  if (findings.length === 0) return [strings.inspectClean(label)]
  const lines = [strings.inspectFound(label, findings.length)]
  const shown = findings.slice(0, Math.max(0, limit))
  for (const finding of shown) lines.push(showLine(finding))
  const remaining = findings.length - shown.length
  if (remaining > 0) lines.push(strings.inspectTruncated(remaining))
  return lines
}

// ---------------------------------------------------------------------------
// report: the ASCII style block
// ---------------------------------------------------------------------------

/** The histogram, in the fixed bucket order, as one bracketed run. */
function histogramText(report: StyleReport): string {
  const length = report.sentence_length
  if (length === undefined) return ''
  const histogram = length.histogram
  return [
    `1-8:${histogram['1-8']}`,
    `9-15:${histogram['9-15']}`,
    `16-25:${histogram['16-25']}`,
    `26-40:${histogram['26-40']}`,
    `41+:${histogram['41+']}`,
  ].join(' ')
}

/**
 * `Counter(tell_words) + Counter(tell_phrases)`, then `most_common(10)`.
 *
 * Counter addition keeps the left operand's key order and appends the right
 * one's new keys; `most_common` sorts by count descending and is stable, which
 * `Array.prototype.sort` has been since ES2019. Same order, same ten entries.
 */
function tellsText(report: StyleReport): string {
  const merged = new Map<string, number>()
  for (const [word, count] of Object.entries(report.tell_words)) {
    merged.set(word, (merged.get(word) ?? 0) + count)
  }
  for (const [phrase, count] of Object.entries(report.tell_phrases)) {
    merged.set(phrase, (merged.get(phrase) ?? 0) + count)
  }
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  return top.map(([word, count]) => `${word}x${count}`).join(', ')
}

/**
 * One file's block. `text` is needed because whether Python prints `2` or `2.0`
 * for the mean depends on the sentence word counts, not on the value.
 */
export function styleBlock(label: string, text: string, report: StyleReport): string[] {
  const facts = styleFacts(text)
  const numbers = styleTexts(report, facts)
  const lines = [strings.reportHead(label, report.words, report.sentences, report.paragraphs)]

  const length = report.sentence_length
  if (length !== undefined) {
    lines.push(
      strings.reportSentenceLength(
        numbers.mean,
        numbers.stdev,
        numbers.cv,
        length.min,
        length.max,
        histogramText(report),
      ),
    )
  }

  lines.push(
    strings.reportPerThousand(
      numbers.tellDensity,
      numbers.emDashes,
      numbers.hedges,
      numbers.contractions,
      numbers.firstPerson,
      numbers.numbers,
    ),
  )

  const tells = tellsText(report)
  if (tells !== '') lines.push(strings.reportTells(tells))

  if (report.observations.length === 0) {
    lines.push(strings.REPORT_NO_OBSERVATIONS)
    return lines
  }

  lines.push(
    strings.reportObservationCounts(
      report.summary.high,
      report.summary.medium,
      report.summary.low,
    ),
  )
  for (const observation of report.observations) {
    lines.push(
      strings.reportObservation(observation.severity, observation.title, observation.detail),
    )
  }
  return lines
}

// ---------------------------------------------------------------------------
// check: the failure listing
// ---------------------------------------------------------------------------

/**
 * One failing file.
 *
 * The source line is printed once per distinct line number, stripped and cut,
 * because a file with twelve findings on one line should quote that line once.
 * The two pin statuses get their own single-line form: there is no character to
 * point at when the count is simply wrong.
 */
export function checkFailureBlock(failure: CheckFailureJson): string[] {
  return [...checkFailureLines(failure), ...checkPayloadLines(failure.path, failure.payloads)]
}

/**
 * The hidden payloads in a failing file, one line each, after its hits. The
 * message is escaped exactly as `inspect` escapes it.
 */
export function checkPayloadLines(path: string, payloads: readonly PayloadJson[]): string[] {
  return payloads.map((payload) =>
    payload.text === null
      ? strings.checkHiddenPattern(path, payload.line, payload.col, payload.scheme, payload.bits)
      : strings.checkHiddenMessage(
          path,
          payload.line,
          payload.col,
          payload.scheme,
          escapeMessage(payload.text),
        ),
  )
}

function checkFailureLines(failure: CheckFailureJson): string[] {
  if (failure.status === 'pin-mismatch') {
    return [strings.checkPinMismatch(failure.path, failure.changed, failure.pinned)]
  }
  if (failure.status === 'pin-stale') {
    return [strings.checkPinStale(failure.path, failure.pinned)]
  }
  if (failure.hits.length === 0) {
    return [strings.checkUnattributed(failure.path)]
  }
  const lines = [strings.checkFailureHead(failure.path, failure.bar)]
  const quoted = new Set<number>()
  for (const hit of failure.hits) {
    lines.push(strings.checkHit(failure.path, hit.line, hit.col, hit.u, hit.name))
    if (!quoted.has(hit.line)) {
      quoted.add(hit.line)
      const source = contextLine(hit.lineText)
      if (source !== '') lines.push(strings.checkContext(source))
    }
  }
  return lines
}

/**
 * `2 binary, 2 not UTF-8`, in a stable order, for the summary line.
 *
 * The counting happens AFTER the machine code is turned into words, so
 * `binary-ext` and `binary` add up to one "binary" total rather than appearing
 * as two entries that say the same word twice.
 */
export function skipReasonText(skipped: readonly CheckSkipJson[]): string {
  const counts = new Map<string, number>()
  for (const entry of skipped) {
    const word = strings.SKIP_REASON_WORDS[entry.reason] ?? entry.reason
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const ordered = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return ordered.map(([word, count]) => `${count} ${word}`).join(', ')
}
