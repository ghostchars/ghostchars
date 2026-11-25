/**
 * `ghostchars check --sarif`: the run as a SARIF 2.1.0 log.
 *
 * SARIF is the one format GitHub code scanning, Azure DevOps and most IDE
 * problem panels ingest without an adapter, so a gate that speaks it shows its
 * findings inline on the pull request instead of in a build log somebody has to
 * open. Nothing here is computed twice: the log is a re-shaping of the same
 * `CheckFailureJson` records `--json` prints.
 *
 * ONE RULE PER KIND, NOT PER CODEPOINT. A rule is what a reader suppresses or
 * filters on, and "invisible" or "bidi-override" is the granularity a reviewer
 * thinks in. The codepoint and its name travel in the result message and in
 * `properties`, so nothing is lost.
 *
 * A PIN FAILURE IS A RESULT WITH NO REGION. `pin-mismatch` and `pin-stale` say
 * something about the file as a whole, so they carry a location with an
 * artifact and no region. Every hit carries a region, as line, column and the
 * source line as a snippet.
 */
import type { Kind } from '@ghostchars/engine'

import type { CheckFailureJson, CheckHitJson } from '../json.js'
import type { PayloadJson } from '../payloads.js'
import { escapeMessage } from '../payloads.js'
import * as strings from '../strings.js'

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
export const SARIF_VERSION = '2.1.0'
const INFORMATION_URI = 'https://ghostchars.com'

/**
 * The rules a run can emit, keyed by rule id. `status` rules describe the pin
 * failures; the rest are the engine's finding kinds, so a consumer sees the same
 * vocabulary as `--json`'s `kind`.
 */
const KIND_DESCRIPTIONS: Readonly<Record<Kind, string>> = {
  invisible: 'A format control that is contraband anywhere in prose.',
  'bidi-override': 'A bidi override or embedding, which reorders unrelated text.',
  'bidi-mark': 'A bidi mark or isolate away from right-to-left text.',
  glue: 'Invisible glue that is not binding to anything.',
  'format-control': 'A format control with no orthographic role here.',
  'private-use': 'A private-use codepoint.',
  space: 'A space character that is not U+0020.',
  'line-break': 'A line separator that is not a line feed.',
  control: 'A C0 or C1 control character.',
  punct: 'Typographic punctuation that reads as machine generated.',
  confusable: 'A look-alike letter from another script inside a mixed-script word.',
  gutter: 'A terminal quote bar at the start of a line, copied along with the quote.',
}

/**
 * The rule a decoded payload cites. One rule for every scheme: the scheme
 * travels in `properties`, and "a hidden message" is what a reviewer acts on.
 */
export const HIDDEN_MESSAGE_RULE = 'hidden-message'

const PAYLOAD_RULES: Readonly<Record<string, string>> = {
  [HIDDEN_MESSAGE_RULE]:
    'Hidden characters that decode to a payload: a message or a bit pattern someone embedded.',
}

const STATUS_RULES: Readonly<Record<'pin-mismatch' | 'pin-stale', string>> = {
  'pin-mismatch': 'The count of deliberate characters differs from the pin in ghostchars.json.',
  'pin-stale': 'The file is pinned in ghostchars.json but has nothing left to pin.',
}

interface SarifRule {
  readonly id: string
  readonly shortDescription: { readonly text: string }
  readonly defaultConfiguration: { readonly level: 'error' | 'warning' }
}

interface SarifLocation {
  readonly physicalLocation: {
    readonly artifactLocation: { readonly uri: string; readonly uriBaseId: 'ROOT' }
    readonly region?: {
      readonly startLine: number
      readonly startColumn: number
      readonly snippet?: { readonly text: string }
    }
  }
}

interface SarifResult {
  readonly ruleId: string
  readonly level: 'error' | 'warning'
  readonly message: { readonly text: string }
  readonly locations: readonly SarifLocation[]
  readonly properties?: Readonly<Record<string, string | number>>
}

export interface SarifLog {
  readonly $schema: string
  readonly version: string
  readonly runs: readonly [
    {
      readonly tool: {
        readonly driver: {
          readonly name: string
          readonly version: string
          readonly informationUri: string
          readonly rules: readonly SarifRule[]
        }
      }
      readonly originalUriBaseIds: { readonly ROOT: { readonly uri: string } }
      readonly results: readonly SarifResult[]
    },
  ]
}

function ruleFor(id: string, text: string): SarifRule {
  return { id, shortDescription: { text }, defaultConfiguration: { level: 'error' } }
}

/** A file: URI for the root, with the trailing slash SARIF requires of a base. */
function rootUri(root: string): string {
  const posix = root.replace(/\\/g, '/')
  const withSlash = posix.endsWith('/') ? posix : `${posix}/`
  return `file://${withSlash.startsWith('/') ? '' : '/'}${encodeURI(withSlash)}`
}

/** Paths in the log are relative to the root, always with forward slashes. */
function relativeUri(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function hitResult(failure: CheckFailureJson, hit: CheckHitJson): SarifResult {
  return {
    ruleId: hit.kind,
    level: 'error',
    message: { text: `${hit.u} ${hit.name} (${hit.kind}) fails the ${failure.bar} bar` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: relativeUri(failure.path), uriBaseId: 'ROOT' },
          region: {
            startLine: hit.line,
            startColumn: hit.col,
            snippet: { text: hit.lineText },
          },
        },
      },
    ],
    properties: { codepoint: hit.cp, u: hit.u, flag: hit.flag, surface: failure.surface },
  }
}

/**
 * One decoded payload. The message text is escaped exactly as the human output
 * escapes it, so a log viewer that renders the message cannot be driven by it;
 * the raw bytes travel as hex in `properties`.
 */
function payloadResult(failure: CheckFailureJson, payload: PayloadJson): SarifResult {
  const text =
    payload.text === null
      ? strings.sarifHiddenPattern(payload.scheme, payload.bits)
      : strings.sarifHiddenMessage(payload.scheme, escapeMessage(payload.text))
  return {
    ruleId: HIDDEN_MESSAGE_RULE,
    level: 'error',
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: relativeUri(failure.path), uriBaseId: 'ROOT' },
          region: { startLine: payload.line, startColumn: payload.col },
        },
      },
    ],
    properties: {
      scheme: payload.scheme,
      confidence: payload.confidence,
      bits: payload.bits,
      hex: payload.hex,
      surface: failure.surface,
    },
  }
}

function pinResult(failure: CheckFailureJson): SarifResult {
  const text =
    failure.status === 'pin-stale'
      ? `pinned at ${failure.pinned} in ghostchars.json but nothing is left to pin`
      : `${failure.changed} deliberate characters, pinned at ${failure.pinned} in ghostchars.json`
  return {
    ruleId: failure.status,
    level: 'error',
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: relativeUri(failure.path), uriBaseId: 'ROOT' },
        },
      },
    ],
    properties: { changed: failure.changed, pinned: failure.pinned, surface: failure.surface },
  }
}

/**
 * Build the log. Only the rules a result actually cites are listed, so a clean
 * run carries an empty `rules` array and an empty `results` array, which is
 * what an ingester reads as "scanned, nothing to show".
 */
export function toSarif(failures: readonly CheckFailureJson[], root: string): SarifLog {
  const results: SarifResult[] = []
  for (const failure of failures) {
    if (failure.status !== 'changed') results.push(pinResult(failure))
    for (const hit of failure.hits) results.push(hitResult(failure, hit))
    for (const payload of failure.payloads) results.push(payloadResult(failure, payload))
  }
  const cited = new Set(results.map((result) => result.ruleId))
  const rules: SarifRule[] = []
  for (const [id, text] of Object.entries(KIND_DESCRIPTIONS)) {
    if (cited.has(id)) rules.push(ruleFor(id, text))
  }
  for (const [id, text] of Object.entries(PAYLOAD_RULES)) {
    if (cited.has(id)) rules.push(ruleFor(id, text))
  }
  for (const [id, text] of Object.entries(STATUS_RULES)) {
    if (cited.has(id)) rules.push(ruleFor(id, text))
  }
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'ghostchars',
            version: strings.VERSION,
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        originalUriBaseIds: { ROOT: { uri: rootUri(root) } },
        results,
      },
    ],
  }
}
