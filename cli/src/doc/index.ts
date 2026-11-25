/**
 * `dist/doc.js`: the zip reader and the three document formats, in a bundle the
 * text path never loads.
 *
 * WHY A SEPARATE ENTRY POINT. `clean` is the command an agent and a CI walk call
 * hundreds of times, and it must not pay to parse a zip reader, an inflater and
 * three XML passes for a file that is a Markdown page. `src/commands/clean.ts`
 * reaches this module through a dynamic import, and only after an extension has
 * already matched, so a plain-text run never opens this file at all.
 *
 * WHY IT RETURNS DATA AND NEVER PRINTS. `src/io.ts` owns both streams, and a
 * second copy of it would live in this bundle with its own private stdout
 * handle: in MCP mode the copy would not have been repointed at stderr, and one
 * document report would land in the middle of a JSON-RPC session. So nothing
 * here writes, reads a file, or sets an exit code. It takes bytes or a string,
 * and hands back numbers, findings and lines for the caller to print.
 *
 * WHY FAILURES COME BACK AS A VALUE. `readZip` throws `ZipFormatError` for a
 * broken archive and `ZipLimitError` for a hostile one, and the caller has to
 * tell them apart because the distinction is what says whether the file is
 * broken or dangerous. An `instanceof` check cannot cross a bundle boundary:
 * `dist/main.js` deliberately does not contain the zip module, so it does not
 * have the classes to compare against. The two are named here, where the
 * classes are real, and travel as a string in a result object.
 */
import { find } from '@ghostchars/engine'
import type { CleanOptions, Finding } from '@ghostchars/engine'
import { cleanDocxEntries, inspectDocxEntries } from '@ghostchars/engine/docx'
import type { DocumentExtras, DocxReport } from '@ghostchars/engine/docx'
import { cleanHtml, htmlText, inspectHtml } from '@ghostchars/engine/html'
import type { HtmlReport } from '@ghostchars/engine/html'
import { cleanOdtEntries, inspectOdtEntries } from '@ghostchars/engine/odt'
import type { OdtReport } from '@ghostchars/engine/odt'
import { ZipFormatError, ZipLimitError, readZip } from '@ghostchars/engine/zip'

import { namedAll } from '../names.js'
import * as strings from '../strings.js'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** The two zip-backed formats. `.html` is a string and needs no archive. */
export type PackageKind = 'docx' | 'odt'

/** Every format `clean` and `inspect` treat as a document rather than as text. */
export type DocKind = PackageKind | 'html'

export type { DocumentExtras }

/**
 * What one document inspection produces.
 *
 * `report` carries the format's own findings under `clean_file.py`'s snake_case
 * field names, so a payload printed by `inspect --json` diffs cleanly against
 * `golden.json`'s `documents[].inspect`. `reportLines` is the same data already
 * rendered, because the label for each field and the order they print in belong
 * with the format that produced them, not with the command that prints them.
 */
export interface DocumentInspection {
  /** The document's visible text, concatenated across its body parts. */
  readonly text: string
  /** Character findings in that text, positions relative to it. */
  readonly findings: readonly Finding[]
  /** Body part names, in package order. Empty for HTML, which has one body. */
  readonly textParts: readonly string[]
  readonly report: Readonly<Record<string, unknown>>
  readonly reportLines: readonly string[]
}

/** What one package clean produces. `text` is the document text BEFORE cleaning. */
export interface PackageCleanOutcome {
  readonly bytes: Uint8Array
  readonly changedNodes: number
  readonly changedParts: readonly string[]
  readonly text: string
}

/** Broken versus hostile. The caller words a different sentence for each. */
export type PackageFailure = 'expands-too-far' | 'bad-package'

export interface PackageOk<T> {
  readonly ok: true
  readonly value: T
}

export interface PackageBad {
  readonly ok: false
  readonly failure: PackageFailure
}

export type PackageResult<T> = PackageOk<T> | PackageBad

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

/** Metadata entries as an ordered object, which is the shape the JSON wants. */
function metadataRecord(
  entries: readonly { readonly field: string; readonly value: string }[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) out[entry.field] = entry.value
  return out
}

/**
 * The nonzero count rows, in the order `clean_file.py` prints them.
 *
 * The label table lives in `src/strings.ts` keyed by the TypeScript field name,
 * so the words are gated by the repository's own hygiene check and this module
 * only decides which rows are worth a line.
 */
function countLines(
  labels: readonly (readonly [string, string])[],
  counts: Readonly<Record<string, number>>,
): string[] {
  const lines: string[] = []
  for (const [key, label] of labels) {
    const count = counts[key] ?? 0
    if (count !== 0) lines.push(strings.documentCount(count, label))
  }
  return lines
}

function metadataLines(
  metadata: readonly { readonly field: string; readonly value: string }[],
  width: number,
): string[] {
  if (metadata.length === 0) return []
  const lines = [strings.DOCUMENT_METADATA_HEADING]
  for (const entry of metadata) {
    lines.push(strings.documentMetadataRow(entry.field, entry.value, width))
  }
  return lines
}

function docxReportLines(report: DocxReport): string[] {
  const lines = [strings.DOCUMENT_SECTION]
  lines.push(
    ...countLines(strings.DOCX_REPORT_LABELS, {
      hiddenRuns: report.hiddenRuns,
      whiteTextRuns: report.whiteTextRuns,
      tinyTextRuns: report.tinyTextRuns,
      trackedInsertions: report.trackedInsertions,
      trackedDeletions: report.trackedDeletions,
      comments: report.comments,
      rsids: report.rsids,
      media: report.media,
      embeddings: report.embeddings,
    }),
  )
  if (report.macros) lines.push(strings.DOCUMENT_MACROS)
  if (report.customProps) lines.push(strings.DOCUMENT_CUSTOM_PROPS)
  lines.push(...metadataLines(report.metadata, strings.DOCX_METADATA_WIDTH))
  // One or two rsids across a whole document is the fingerprint of a paste, so
  // the note prints exactly there and nowhere else.
  if (report.rsids > 0 && report.rsids <= 2) lines.push(strings.DOCX_RSID_NOTE)
  return lines
}

function docxReportRecord(report: DocxReport): Record<string, unknown> {
  return {
    hidden_runs: report.hiddenRuns,
    white_text_runs: report.whiteTextRuns,
    tiny_text_runs: report.tinyTextRuns,
    tracked_ins: report.trackedInsertions,
    tracked_del: report.trackedDeletions,
    comments: report.comments,
    rsids: report.rsids,
    metadata: metadataRecord(report.metadata),
    custom_props: report.customProps,
    macros: report.macros,
    media: report.media,
    embeddings: report.embeddings,
  }
}

function odtReportLines(report: OdtReport): string[] {
  const lines = [strings.DOCUMENT_SECTION]
  lines.push(
    ...countLines(strings.ODT_REPORT_LABELS, {
      trackedChanges: report.trackedChanges,
      annotations: report.annotations,
      hiddenTextStyles: report.hiddenTextStyles,
      userDefined: report.userDefined,
    }),
  )
  lines.push(...metadataLines(report.metadata, strings.ODT_METADATA_WIDTH))
  return lines
}

function odtReportRecord(report: OdtReport): Record<string, unknown> {
  return {
    tracked_changes: report.trackedChanges,
    annotations: report.annotations,
    hidden_text_styles: report.hiddenTextStyles,
    metadata: metadataRecord(report.metadata),
    user_defined: report.userDefined,
  }
}

function htmlReportLines(report: HtmlReport): string[] {
  const lines = [strings.DOCUMENT_SECTION]
  lines.push(
    ...countLines(strings.HTML_REPORT_LABELS, {
      comments: report.comments,
      hiddenElements: report.hiddenElements,
      attributeHits: report.attributeHits,
    }),
  )
  const generator = report.generator
  if (generator !== null && generator !== '') lines.push(strings.documentGenerator(generator))
  return lines
}

function htmlReportRecord(report: HtmlReport): Record<string, unknown> {
  return {
    comments: report.comments,
    hidden_elements: report.hiddenElements,
    generator: report.generator,
    attr_hits: report.attributeHits,
  }
}

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

/**
 * The one place a zip failure is classified.
 *
 * Everything the reader can refuse is refused here, including an inflate that
 * runs past the ceiling halfway through a large archive, which is why the whole
 * operation and not only `readZip` sits inside the try.
 */
async function attempt<T>(work: () => Promise<T>): Promise<PackageResult<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (error instanceof ZipLimitError) return { ok: false, failure: 'expands-too-far' }
    if (error instanceof ZipFormatError) return { ok: false, failure: 'bad-package' }
    throw error
  }
}

/** Read a package and report what is hiding in it. Reads only. */
export async function inspectPackage(
  kind: PackageKind,
  bytes: Uint8Array,
): Promise<PackageResult<DocumentInspection>> {
  return await attempt(async () => {
    const entries = await readZip(bytes)
    if (kind === 'docx') {
      const inspection = inspectDocxEntries(entries)
      return {
        text: inspection.text,
        // `namedAll` here and below for the same reason it is applied to the
        // MCP clean result: the engine builds these findings with its own name
        // table, which has no name for a look-alike letter. Renaming at the one
        // boundary where a document inspection is built means no caller can
        // print the `U+XXXX` placeholder by forgetting to ask.
        findings: namedAll(inspection.findings),
        textParts: inspection.textParts,
        report: docxReportRecord(inspection.report),
        reportLines: docxReportLines(inspection.report),
      }
    }
    const inspection = inspectOdtEntries(entries)
    return {
      text: inspection.text,
      findings: namedAll(inspection.findings),
      textParts: inspection.textParts,
      report: odtReportRecord(inspection.report),
      reportLines: odtReportLines(inspection.report),
    }
  })
}

/**
 * Clean a package.
 *
 * The archive is read ONCE and both passes run over the same entry list: the
 * inspection is what supplies the document text a `-c` delta and a `--json`
 * summary are computed from, and re-reading the zip to get it would double the
 * inflate cost of every document clean.
 */
export async function cleanPackage(
  kind: PackageKind,
  bytes: Uint8Array,
  options: CleanOptions,
  extras: DocumentExtras,
): Promise<PackageResult<PackageCleanOutcome>> {
  return await attempt(async () => {
    const entries = await readZip(bytes)
    const inspection = kind === 'docx' ? inspectDocxEntries(entries) : inspectOdtEntries(entries)
    const cleaned =
      kind === 'docx'
        ? await cleanDocxEntries(entries, options, extras)
        : await cleanOdtEntries(entries, options, extras)
    return {
      bytes: cleaned.bytes,
      changedNodes: cleaned.changedNodes,
      changedParts: cleaned.changedParts,
      text: inspection.text,
    }
  })
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * Report what is hiding in an HTML page.
 *
 * The findings are located in the page's VISIBLE text, not in its source, so a
 * line and column here index the concatenated text nodes the way the document
 * report does everywhere else. That is the same string `cleanPage` rewrites.
 */
export function inspectPage(source: string): DocumentInspection {
  const text = htmlText(source)
  const report = inspectHtml(source)
  return {
    text,
    findings: namedAll(find(text)),
    textParts: [],
    report: htmlReportRecord(report),
    reportLines: htmlReportLines(report),
  }
}

/**
 * Clean an HTML page structurally: text nodes only.
 *
 * Tags, comments, scripts and styles pass through untouched. This differs
 * from the Python reference: `strip_invisible.py` would clean the markup too.
 * `--as text` restores that behaviour for anyone who wants it.
 */
export function cleanPage(source: string, options: CleanOptions): string {
  return cleanHtml(source, options)
}
