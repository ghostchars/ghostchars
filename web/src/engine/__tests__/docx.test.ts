import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CLEAN_OPTION_KEYS, type CleanOptions } from '@/engine'

import {
  cleanDocxEntries,
  type DocumentExtras,
  type DocxReport,
  inspectDocxEntries,
} from '../docx'
import { readZip, ZIP_COMPRESSION, type ZipEntry } from '../zip'

/**
 * DOCX parity against `clean_file.py`.
 *
 * The comparison is on the XML STRINGS, not on zip bytes. `tools/gen_golden.py`
 * re-serialises every package STORED with a fixed timestamp because deflate
 * output differs between zlib builds, so comparing bytes would test the
 * compressor, not the cleaner. What actually has to match is: which parts exist,
 * in which order, and what is inside each of them, which is what this checks,
 * character for character, for all three flag sets.
 */

const GOLDEN_PATH = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))

const entrySchema = z.object({
  name: z.string(),
  compress: z.enum(['stored', 'deflate']),
})

const cleanedSchema = z.object({
  changedNodes: z.number().int().nonnegative(),
  entries: z.array(entrySchema),
  parts: z.record(z.string(), z.string()),
})

const packageSchema = z.object({
  id: z.string(),
  kind: z.literal('docx'),
  note: z.string(),
  textParts: z.array(z.string()),
  text: z.string(),
  findings: z.array(z.tuple([z.number(), z.number(), z.number(), z.string(), z.string()])),
  inspect: z.object({
    hidden_runs: z.number(),
    white_text_runs: z.number(),
    tiny_text_runs: z.number(),
    tracked_ins: z.number(),
    tracked_del: z.number(),
    comments: z.number(),
    rsids: z.number(),
    metadata: z.record(z.string(), z.string()),
    custom_props: z.boolean(),
    macros: z.boolean(),
    media: z.number(),
    embeddings: z.number(),
  }),
  entries: z.array(entrySchema),
  bytesB64: z.string(),
  cleaned: z.record(z.string(), cleanedSchema),
})

const flagSetSchema = z.object({ id: z.string(), options: z.array(z.string()) })

const goldenSchema = z.object({
  docFlagSets: z.array(flagSetSchema),
  documents: z.array(z.looseObject({ kind: z.string() })),
})

const GOLDEN = goldenSchema.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))
const PACKAGES = GOLDEN.documents
  .filter((document) => document.kind === 'docx')
  .map((document) => packageSchema.parse(document))

/**
 * Split a fixture flag set into the twelve character options and the two
 * document extras. `--metadata` and `--rsids` are not cleaning flags: they
 * remove authoring fingerprints, not characters.
 */
function splitFlagSet(options: readonly string[]): {
  clean: Partial<CleanOptions>
  extras: DocumentExtras
} {
  const clean: Partial<CleanOptions> = {}
  for (const key of CLEAN_OPTION_KEYS) {
    if (options.includes(key)) clean[key] = true
  }
  return {
    clean,
    extras: { metadata: options.includes('metadata'), rsids: options.includes('rsids') },
  }
}

/**
 * The one place the two spellings of a report field meet. Pairs rather than an
 * object so the loop below keeps the field name as a literal union: indexing
 * `DocxReport` with a widened `string` would need a cast, and casts are banned.
 */
const REPORT_FIELDS = [
  ['hiddenRuns', 'hidden_runs'],
  ['whiteTextRuns', 'white_text_runs'],
  ['tinyTextRuns', 'tiny_text_runs'],
  ['trackedInsertions', 'tracked_ins'],
  ['trackedDeletions', 'tracked_del'],
  ['comments', 'comments'],
  ['rsids', 'rsids'],
  ['customProps', 'custom_props'],
  ['macros', 'macros'],
  ['media', 'media'],
  ['embeddings', 'embeddings'],
] as const satisfies readonly (readonly [Exclude<keyof DocxReport, 'metadata'>, string])[]

function toPythonReport(report: DocxReport): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, pythonKey] of REPORT_FIELDS) {
    out[pythonKey] = report[field]
  }
  const metadata: Record<string, string> = {}
  for (const entry of report.metadata) metadata[entry.field] = entry.value
  out['metadata'] = metadata
  return out
}

async function entriesOf(base64: string): Promise<readonly ZipEntry[]> {
  return readZip(new Uint8Array(Buffer.from(base64, 'base64')))
}

async function partsOf(bytes: Uint8Array): Promise<Record<string, string>> {
  const decoder = new TextDecoder()
  const parts: Record<string, string> = {}
  for (const entry of await readZip(bytes)) parts[entry.name] = decoder.decode(entry.data)
  return parts
}

describe('inspectDocx', () => {
  for (const pkg of PACKAGES) {
    it(`reports what Python reports for ${pkg.id} (${pkg.note})`, async () => {
      const inspection = inspectDocxEntries(await entriesOf(pkg.bytesB64))
      expect(inspection.textParts).toEqual(pkg.textParts)
      expect(inspection.text).toBe(pkg.text)
      expect(
        inspection.findings.map((finding) => [
          finding.line,
          finding.col,
          finding.cp,
          finding.kind,
          finding.flag,
        ]),
      ).toEqual(pkg.findings)
      expect(toPythonReport(inspection.report)).toEqual(pkg.inspect)
    })
  }

  it('keeps the authoring metadata in the order the CLI prints it', async () => {
    const pkg = PACKAGES[0]
    expect(pkg).toBeDefined()
    const inspection = inspectDocxEntries(await entriesOf(pkg?.bytesB64 ?? ''))
    // core fields first, then app fields: the report order in clean_file.py
    expect(inspection.report.metadata.map((entry) => entry.field)).toEqual([
      'dc:creator',
      'cp:lastModifiedBy',
      'cp:revision',
      'dcterms:created',
      'dcterms:modified',
      'Application',
      'AppVersion',
      'Company',
      'TotalTime',
    ])
  })
})

describe('cleanDocx', () => {
  for (const pkg of PACKAGES) {
    for (const flagSet of GOLDEN.docFlagSets) {
      it(`cleans ${pkg.id} exactly like the CLI with [${flagSet.id}]`, async () => {
        const expected = pkg.cleaned[flagSet.id]
        expect(expected, flagSet.id).toBeDefined()
        if (expected === undefined) return
        const { clean, extras } = splitFlagSet(flagSet.options)
        const result = await cleanDocxEntries(await entriesOf(pkg.bytesB64), clean, extras)

        expect(result.changedNodes).toBe(expected.changedNodes)
        const parts = await partsOf(result.bytes)
        expect(Object.keys(parts)).toEqual(expected.entries.map((entry) => entry.name))
        for (const [name, xml] of Object.entries(expected.parts)) {
          expect(parts[name], `${pkg.id} ${flagSet.id} ${name}`).toBe(xml)
        }
      })
    }
  }

  it('preserves the compression method of every entry, as clean_file.py does', async () => {
    const pkg = PACKAGES[0]
    expect(pkg).toBeDefined()
    if (pkg === undefined) return
    // The fixture is normalised to STORED, so this asserts preservation against
    // the input we actually have...
    const input = await entriesOf(pkg.bytesB64)
    const result = await cleanDocxEntries(input, {}, { metadata: false, rsids: false })
    const output = await readZip(result.bytes)
    expect(output.map((entry) => entry.compression)).toEqual(
      input.map((entry) => entry.compression),
    )
    // ...and this asserts that preservation is what Python did too, by checking
    // the methods it recorded for the real (deflated) source and its output.
    const cleaned = pkg.cleaned['none']
    expect(cleaned).toBeDefined()
    expect(cleaned?.entries.map((entry) => entry.compress)).toEqual(
      pkg.entries.map((entry) => entry.compress),
    )
    expect(pkg.entries.every((entry) => entry.compress === ZIP_COMPRESSION.deflate)).toBe(true)
  })

  it('drops docProps/custom.xml only when --metadata is on', async () => {
    const pkg = PACKAGES[0]
    if (pkg === undefined) return
    const entries = await entriesOf(pkg.bytesB64)
    const kept = await cleanDocxEntries(entries, {}, { metadata: false, rsids: false })
    const dropped = await cleanDocxEntries(entries, {}, { metadata: true, rsids: false })
    expect(Object.keys(await partsOf(kept.bytes))).toContain('docProps/custom.xml')
    expect(Object.keys(await partsOf(dropped.bytes))).not.toContain('docProps/custom.xml')
    expect(dropped.changedParts).toContain('docProps/custom.xml')
  })

  it('adds xml:space="preserve" only where cleaning leaves edge whitespace', async () => {
    const pkg = PACKAGES.find((candidate) => candidate.id === 'docx-space-preserve')
    expect(pkg).toBeDefined()
    if (pkg === undefined) return
    const result = await cleanDocxEntries(
      await entriesOf(pkg.bytesB64),
      { spaces: true },
      { metadata: false, rsids: false },
    )
    const document = (await partsOf(result.bytes))['word/document.xml'] ?? ''
    expect(document).toContain('<w:t xml:space="preserve"> Hello world')
    // The node that already carried the attribute must not get a second one.
    expect(document).not.toContain('xml:space="preserve" xml:space="preserve"')
  })
})
