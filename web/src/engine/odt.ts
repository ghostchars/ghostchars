import { clean, type CleanOptions, find, type Finding } from '@/engine'

import type { CleanedDocument, DocumentExtras } from './docx'
import { blankTags, cleanXmlTextNodes, findXmlText, tagText } from './html'
import {
  decodeUtf8,
  DEFAULT_EXTERNAL_ATTR,
  DOS_EPOCH,
  encodeUtf8,
  readZip,
  withOdtMimetypeFirst,
  writeZip,
  ZIP_COMPRESSION,
  type ZipEntry,
} from './zip'

/**
 * ODT (OpenDocument Text): the port of `clean_file.py`'s ODF path.
 *
 * Structurally simpler than DOCX: all the visible text lives in `content.xml`,
 * and ODF puts it directly inside `<text:p>`, `<text:span>`, `<text:h>` and
 * friends rather than in one dedicated element. So the node pattern is not a
 * tag name at all: it is "everything between a `>` and the next `<`", which is
 * safe precisely because it can never touch an attribute.
 *
 * The one format rule that is not optional: `mimetype` must be the first entry
 * of the package and must be STORED. `writeZip` is given an entry list that
 * already satisfies that (see `withOdtMimetypeFirst`); get it wrong and
 * LibreOffice refuses the file.
 */

/** `ODT_NODE_RE`: a text node is whatever sits between two tags. */
const ODT_NODE_RE = /(>)([^<]+)(<)/g

/** `ODT_META_FIELDS`: the authoring fields `--metadata` blanks, in report order. */
export const ODT_META_FIELDS = [
  'meta:initial-creator',
  'dc:creator',
  'meta:generator',
  'meta:editing-cycles',
  'meta:editing-duration',
  'meta:creation-date',
  'dc:date',
  'meta:printed-by',
  'meta:print-date',
  'dc:description',
  'meta:keyword',
] as const

export type OdtMetadataField = (typeof ODT_META_FIELDS)[number]

export interface OdtMetadataEntry {
  readonly field: OdtMetadataField
  readonly value: string
}

const PART_CONTENT = 'content.xml'
const PART_META = 'meta.xml'
const PART_MIMETYPE = 'mimetype'

const USER_DEFINED_RE = /<meta:user-defined\b[^>]*>[^<]*<\/meta:user-defined>/g

/** What `--show` prints for an .odt, as data. */
export interface OdtReport {
  /** `<text:changed-region>` blocks: the document carries its edit history. */
  readonly trackedChanges: number
  /** `<office:annotation>`: reviewer comments, invisible when printed. */
  readonly annotations: number
  /** Styles carrying `text:display="none"`. */
  readonly hiddenTextStyles: number
  readonly metadata: readonly OdtMetadataEntry[]
  /** Arbitrary author-defined meta fields: a common place to park a tag. */
  readonly userDefined: number
}

export interface OdtInspection {
  readonly text: string
  readonly findings: readonly Finding[]
  readonly report: OdtReport
  readonly textParts: readonly string[]
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

function partText(entries: readonly ZipEntry[], name: string): string {
  const entry = entries.find((candidate) => candidate.name === name)
  return entry === undefined ? '' : decodeUtf8(entry.data)
}

/** Port of `clean_file.inspect_odt`, plus the text pass. */
export async function inspectOdt(bytes: Uint8Array): Promise<OdtInspection> {
  const entries = await readZip(bytes)
  return inspectOdtEntries(entries)
}

export function inspectOdtEntries(entries: readonly ZipEntry[]): OdtInspection {
  const content = partText(entries, PART_CONTENT)
  const meta = partText(entries, PART_META)
  const hasContent = entries.some((entry) => entry.name === PART_CONTENT)
  const textParts = hasContent ? [PART_CONTENT] : []
  const text = hasContent ? findXmlText(content, ODT_NODE_RE) : ''

  const metadata: OdtMetadataEntry[] = []
  for (const field of ODT_META_FIELDS) {
    const value = tagText(meta, field)
    if (value !== null && value !== '') metadata.push({ field, value })
  }

  return {
    text,
    findings: find(text),
    textParts,
    report: {
      trackedChanges: countOccurrences(content, '<text:changed-region'),
      annotations: countOccurrences(content, '<office:annotation'),
      hiddenTextStyles: countOccurrences(content, 'text:display="none"'),
      metadata,
      userDefined: countOccurrences(meta, '<meta:user-defined'),
    },
  }
}

/**
 * Rewrite an .odt with cleaned text and, on request, blanked metadata.
 *
 * `clean_file.py` re-writes `mimetype` itself with a fresh STORED entry and
 * deflates everything else regardless of how the source stored it; this does
 * the same, so a package cleaned here and one cleaned by the CLI have the same
 * entry order and the same per-entry methods.
 */
export async function cleanOdt(
  bytes: Uint8Array,
  options: Partial<CleanOptions>,
  extras: DocumentExtras,
): Promise<CleanedDocument> {
  const entries = await readZip(bytes)
  return cleanOdtEntries(entries, options, extras)
}

export async function cleanOdtEntries(
  entries: readonly ZipEntry[],
  options: Partial<CleanOptions>,
  extras: DocumentExtras,
): Promise<CleanedDocument> {
  const cleanText = (text: string): string => clean(text, options).text
  const out: ZipEntry[] = []
  const changedParts: string[] = []
  let changedNodes = 0

  const mimetype = entries.find((entry) => entry.name === PART_MIMETYPE)
  if (mimetype !== undefined) {
    out.push({
      name: PART_MIMETYPE,
      data: mimetype.data,
      compression: ZIP_COMPRESSION.stored,
      dosTime: DOS_EPOCH.time,
      dosDate: DOS_EPOCH.date,
      externalAttr: DEFAULT_EXTERNAL_ATTR,
    })
  }

  for (const entry of entries) {
    if (entry.name === PART_MIMETYPE) continue
    let data = entry.data
    if (entry.name === PART_CONTENT) {
      const source = decodeUtf8(entry.data)
      const pass = cleanXmlTextNodes(source, ODT_NODE_RE, cleanText)
      changedNodes += pass.changed
      if (pass.xml !== source) changedParts.push(entry.name)
      data = encodeUtf8(pass.xml)
    } else if (entry.name === PART_META && extras.metadata) {
      const source = decodeUtf8(entry.data)
      const xml = blankTags(source, ODT_META_FIELDS).replace(USER_DEFINED_RE, '')
      if (xml !== source) changedParts.push(entry.name)
      data = encodeUtf8(xml)
    }
    out.push({ ...entry, data, compression: ZIP_COMPRESSION.deflate })
  }

  return {
    bytes: await writeZip(withOdtMimetypeFirst(out)),
    changedNodes,
    changedParts,
  }
}
