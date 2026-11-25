import { clean, type CleanOptions, find, type Finding } from '@/engine'

import {
  blankTags,
  cleanXmlTextNodes,
  findXmlText,
  tagText,
} from './html'
import { decodeUtf8, encodeUtf8, readZip, writeZip, type ZipEntry } from './zip'

/**
 * DOCX: the port of `clean_file.py`'s Word path.
 *
 * A .docx is a ZIP of XML parts. The cleaner rewrites the text of `<w:t>` nodes
 * in the body parts and nothing else: attributes, styles, relationships and
 * numbering are left byte-identical, because the point is to remove hidden
 * characters, not to re-author the document.
 *
 * The INSPECTION is the other half, and the more interesting one. A Word file
 * hides things the text cleaner deliberately will not touch: runs marked
 * `w:vanish`, white-on-white or 2-point text, tracked changes, reviewer
 * comments, the per-editing-session `rsid` fingerprint, and the authoring
 * metadata in `docProps`. Those are REPORTED, never silently removed: deleting
 * a hidden run changes what the document says, and that stays a human decision.
 * The two things that are pure fingerprint (authoring metadata and rsids) can
 * be removed on request, which is what `--metadata` and `--rsids` do.
 */

// ---------------------------------------------------------------------------
// Patterns (each one a direct port; the Python name is in the comment)
// ---------------------------------------------------------------------------

/** `W_T_RE`: one `<w:t>` text node: open tag, text, close tag. */
const W_T_RE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g

/** `DOCX_TEXT_PARTS`: the parts whose `<w:t>` nodes hold visible text. */
const DOCX_TEXT_PARTS_RE =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/

/** `RSID_ATTR_RE`: a single revision-save-id attribute anywhere in a part. */
const RSID_ATTR_RE = /\s+w:rsid(?:R|RPr|RDefault|Del|P|Sect|Tr)?="[0-9A-Fa-f]{8}"/g

/** `RSIDS_BLOCK_RE`: the `<w:rsids>` table in `settings.xml`. */
const RSIDS_BLOCK_RE = /<w:rsids>[\s\S]*?<\/w:rsids>|<w:rsids\/>/g

/** `VANISH_RE`: a run marked hidden. Reported only. */
const VANISH_RE = /<w:vanish(?:\s+w:val="(?:true|1|on)")?\s*\/>/g

/** `WHITE_RE`: a run coloured pure white. */
const WHITE_RE = /<w:color\s+w:val="(?:FFFFFF|ffffff)"[^>]*\/>/g

/** `TINY_RE`: run size in half-points; ≤ 4 means ≤ 2 pt. */
const TINY_RE = /<w:sz\s+w:val="([0-9]+)"/g

/** `<w:rsid w:val="...">` rows inside `settings.xml`. */
const SETTINGS_RSID_RE = /<w:rsid\s+w:val="([0-9A-Fa-f]{8})"/g

const PART_DOCUMENT = 'word/document.xml'
const PART_COMMENTS = 'word/comments.xml'
const PART_SETTINGS = 'word/settings.xml'
const PART_CORE = 'docProps/core.xml'
const PART_APP = 'docProps/app.xml'
const PART_CUSTOM = 'docProps/custom.xml'

/**
 * `CORE_FIELDS` / `APP_FIELDS`: the authoring fields `--metadata` blanks, in
 * report order. A typed tuple rather than loose strings: the union below is
 * what makes a metadata row in the UI impossible to mistype.
 */
export const DOCX_CORE_FIELDS = [
  'dc:creator',
  'cp:lastModifiedBy',
  'cp:revision',
  'dcterms:created',
  'dcterms:modified',
  'cp:lastPrinted',
  'dc:description',
  'cp:keywords',
  'cp:category',
  'cp:contentStatus',
] as const

export const DOCX_APP_FIELDS = [
  'Application',
  'AppVersion',
  'Company',
  'Manager',
  'TotalTime',
  'Template',
  'HyperlinkBase',
  'DocSecurity',
] as const

export type DocxMetadataField =
  | (typeof DOCX_CORE_FIELDS)[number]
  | (typeof DOCX_APP_FIELDS)[number]

/** One populated authoring field. Absent fields are simply not in the list. */
export interface DocxMetadataEntry {
  readonly field: DocxMetadataField
  readonly value: string
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * What `--show` prints for a .docx, as data. Field names are the TypeScript
 * spelling of `inspect_docx`'s dict keys; `docx.test.ts` maps between the two
 * through one explicit table, so the parity check covers every field by name.
 */
export interface DocxReport {
  /** Runs marked `w:vanish`: present in the file, invisible on screen. */
  readonly hiddenRuns: number
  /** Runs coloured `FFFFFF`: invisible on a white page, copyable, searchable. */
  readonly whiteTextRuns: number
  /** Runs at 2 pt or smaller. */
  readonly tinyTextRuns: number
  readonly trackedInsertions: number
  readonly trackedDeletions: number
  readonly comments: number
  /**
   * Distinct editing-session ids. Word stamps one per save session, so a
    * document with 1 to 2 across the whole body was pasted in in one go rather than
   * typed over days.
   */
  readonly rsids: number
  readonly metadata: readonly DocxMetadataEntry[]
  /** A `docProps/custom.xml` part exists (arbitrary author-defined fields). */
  readonly customProps: boolean
  /** A `vbaProject` part exists: the document carries macros. */
  readonly macros: boolean
  readonly media: number
  readonly embeddings: number
}

/** Extra removals that are not character cleaning. */
export interface DocumentExtras {
  /** Blank the authoring metadata and drop `custom.xml`. */
  readonly metadata: boolean
  /** DOCX only: strip the per-session rsid fingerprint. */
  readonly rsids: boolean
}

/** Everything an inspection pass learns about one package. */
export interface DocxInspection {
  /** The document's visible text, concatenated across body parts. */
  readonly text: string
  /** Character findings in that text, positions relative to it. */
  readonly findings: readonly Finding[]
  readonly report: DocxReport
  /** Body parts in package order: what `text` was concatenated from. */
  readonly textParts: readonly string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function partIndex(entries: readonly ZipEntry[]): Map<string, ZipEntry> {
  const index = new Map<string, ZipEntry>()
  for (const entry of entries) index.set(entry.name, entry)
  return index
}

function partText(entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name)
  return entry === undefined ? '' : decodeUtf8(entry.data)
}

function countMatches(text: string, pattern: RegExp): number {
  let n = 0
  for (const _match of text.matchAll(pattern)) n += 1
  return n
}

function countOccurrences(text: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return n
    n += 1
    from = at + needle.length
  }
}

function collectMetadata(core: string, app: string): readonly DocxMetadataEntry[] {
  const out: DocxMetadataEntry[] = []
  for (const field of DOCX_CORE_FIELDS) {
    const value = tagText(core, field)
    if (value !== null && value !== '') out.push({ field, value })
  }
  for (const field of DOCX_APP_FIELDS) {
    const value = tagText(app, field)
    if (value !== null && value !== '') out.push({ field, value })
  }
  return out
}

/** The body parts of the package, in package order. */
export function docxTextParts(entries: readonly ZipEntry[]): readonly string[] {
  return entries.map((entry) => entry.name).filter((name) => DOCX_TEXT_PARTS_RE.test(name))
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/** Port of `clean_file.inspect_docx`, plus the text pass `--show` runs first. */
export async function inspectDocx(bytes: Uint8Array): Promise<DocxInspection> {
  const entries = await readZip(bytes)
  return inspectDocxEntries(entries)
}

/** The same inspection from already-parsed entries (used by the clean path). */
export function inspectDocxEntries(entries: readonly ZipEntry[]): DocxInspection {
  const parts = partIndex(entries)
  const names = entries.map((entry) => entry.name)
  const document = partText(parts, PART_DOCUMENT)
  const settings = partText(parts, PART_SETTINGS)
  const comments = partText(parts, PART_COMMENTS)

  const rsids = new Set<string>()
  for (const match of document.matchAll(RSID_ATTR_RE)) {
    const value = match[0].split('"')[1]
    if (value !== undefined) rsids.add(value)
  }
  for (const match of settings.matchAll(SETTINGS_RSID_RE)) {
    const value = match[1]
    if (value !== undefined) rsids.add(value)
  }

  let tinyTextRuns = 0
  for (const match of document.matchAll(TINY_RE)) {
    const halfPoints = Number.parseInt(match[1] ?? '', 10)
    if (Number.isFinite(halfPoints) && halfPoints <= 4) tinyTextRuns += 1
  }

  const textParts = docxTextParts(entries)
  let text = ''
  for (const name of textParts) {
    text += findXmlText(partText(parts, name), W_T_RE)
  }

  return {
    text,
    findings: find(text),
    textParts,
    report: {
      hiddenRuns: countMatches(document, VANISH_RE),
      whiteTextRuns: countMatches(document, WHITE_RE),
      tinyTextRuns,
      trackedInsertions: countOccurrences(document, '<w:ins '),
      trackedDeletions: countOccurrences(document, '<w:del '),
      comments: countOccurrences(comments, '<w:comment '),
      rsids: rsids.size,
      metadata: collectMetadata(partText(parts, PART_CORE), partText(parts, PART_APP)),
      customProps: names.includes(PART_CUSTOM),
      macros: names.some((name) => name.startsWith('word/vbaProject')),
      media: names.filter((name) => name.startsWith('word/media/')).length,
      embeddings: names.filter((name) => name.startsWith('word/embeddings/')).length,
    },
  }
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

/** A cleaned package plus how many text nodes actually changed. */
export interface CleanedDocument {
  readonly bytes: Uint8Array
  readonly changedNodes: number
  /** Parts rewritten, in package order: what the UI reports as "touched". */
  readonly changedParts: readonly string[]
}

/**
 * Rewrite a .docx with cleaned text, optionally blanked metadata and stripped
 * rsids. Every entry keeps its position and its compression method, so the
 * output differs from the input only where something was actually cleaned.
 */
export async function cleanDocx(
  bytes: Uint8Array,
  options: Partial<CleanOptions>,
  extras: DocumentExtras,
): Promise<CleanedDocument> {
  const entries = await readZip(bytes)
  return cleanDocxEntries(entries, options, extras)
}

/** The entry-level clean, so a caller that already parsed the zip pays once. */
export async function cleanDocxEntries(
  entries: readonly ZipEntry[],
  options: Partial<CleanOptions>,
  extras: DocumentExtras,
): Promise<CleanedDocument> {
  const cleanText = (text: string): string => clean(text, options).text
  const out: ZipEntry[] = []
  const changedParts: string[] = []
  let changedNodes = 0

  for (const entry of entries) {
    const name = entry.name
    if (DOCX_TEXT_PARTS_RE.test(name)) {
      const source = decodeUtf8(entry.data)
      const pass = cleanXmlTextNodes(source, W_T_RE, cleanText)
      changedNodes += pass.changed
      const xml = extras.rsids ? pass.xml.replace(RSID_ATTR_RE, '') : pass.xml
      if (xml !== source) changedParts.push(name)
      out.push({ ...entry, data: encodeUtf8(xml) })
      continue
    }
    if (name === PART_SETTINGS && extras.rsids) {
      const source = decodeUtf8(entry.data)
      const xml = source.replace(RSIDS_BLOCK_RE, '')
      if (xml !== source) changedParts.push(name)
      out.push({ ...entry, data: encodeUtf8(xml) })
      continue
    }
    if (name === PART_CORE && extras.metadata) {
      const source = decodeUtf8(entry.data)
      const xml = blankTags(source, DOCX_CORE_FIELDS)
      if (xml !== source) changedParts.push(name)
      out.push({ ...entry, data: encodeUtf8(xml) })
      continue
    }
    if (name === PART_APP && extras.metadata) {
      const source = decodeUtf8(entry.data)
      const xml = blankTags(source, DOCX_APP_FIELDS)
      if (xml !== source) changedParts.push(name)
      out.push({ ...entry, data: encodeUtf8(xml) })
      continue
    }
    if (name === PART_CUSTOM && extras.metadata) {
      // Dropped outright. The dangling relationship and content-type override
      // are tolerated by Word: `clean_file.py` makes the same trade.
      changedParts.push(name)
      continue
    }
    out.push(entry)
  }

  return { bytes: await writeZip(out), changedNodes, changedParts }
}
