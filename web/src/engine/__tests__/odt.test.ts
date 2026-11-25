import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CLEAN_OPTION_KEYS, type CleanOptions } from '@/engine'

import type { DocumentExtras } from '../docx'
import { cleanOdtEntries, inspectOdtEntries, type OdtReport } from '../odt'
import { readZip, ZIP_COMPRESSION, type ZipEntry } from '../zip'

/**
 * ODT parity against `clean_file.py`, on the same terms as the DOCX suite:
 * the XML strings are compared exactly, the zip bytes are not.
 *
 * The extra thing checked here is the packaging rule ODF actually enforces
 * (`mimetype` first and STORED, everything else deflated), which the fixture
 * records for Python's output and which this asserts for ours.
 */

const GOLDEN_PATH = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))

const entrySchema = z.object({ name: z.string(), compress: z.enum(['stored', 'deflate']) })

const packageSchema = z.object({
  id: z.string(),
  kind: z.literal('odt'),
  note: z.string(),
  textParts: z.array(z.string()),
  text: z.string(),
  findings: z.array(z.tuple([z.number(), z.number(), z.number(), z.string(), z.string()])),
  inspect: z.object({
    tracked_changes: z.number(),
    annotations: z.number(),
    hidden_text_styles: z.number(),
    metadata: z.record(z.string(), z.string()),
    user_defined: z.number(),
  }),
  entries: z.array(entrySchema),
  bytesB64: z.string(),
  cleaned: z.record(
    z.string(),
    z.object({
      changedNodes: z.number().int().nonnegative(),
      entries: z.array(entrySchema),
      parts: z.record(z.string(), z.string()),
    }),
  ),
})

const goldenSchema = z.object({
  docFlagSets: z.array(z.object({ id: z.string(), options: z.array(z.string()) })),
  documents: z.array(z.looseObject({ kind: z.string() })),
})

const GOLDEN = goldenSchema.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))
const PACKAGES = GOLDEN.documents
  .filter((document) => document.kind === 'odt')
  .map((document) => packageSchema.parse(document))

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

const REPORT_FIELDS = [
  ['trackedChanges', 'tracked_changes'],
  ['annotations', 'annotations'],
  ['hiddenTextStyles', 'hidden_text_styles'],
  ['userDefined', 'user_defined'],
] as const satisfies readonly (readonly [Exclude<keyof OdtReport, 'metadata'>, string])[]

function toPythonReport(report: OdtReport): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, pythonKey] of REPORT_FIELDS) out[pythonKey] = report[field]
  const metadata: Record<string, string> = {}
  for (const entry of report.metadata) metadata[entry.field] = entry.value
  out['metadata'] = metadata
  return out
}

async function entriesOf(base64: string): Promise<readonly ZipEntry[]> {
  return readZip(new Uint8Array(Buffer.from(base64, 'base64')))
}

describe('inspectOdt', () => {
  for (const pkg of PACKAGES) {
    it(`reports what Python reports for ${pkg.id} (${pkg.note})`, async () => {
      const inspection = inspectOdtEntries(await entriesOf(pkg.bytesB64))
      expect(inspection.textParts).toEqual(pkg.textParts)
      // The ODT node pattern matches everything between two tags, so the inter-tag
      // newlines are part of the extracted text, and the finding line numbers.
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
})

describe('cleanOdt', () => {
  for (const pkg of PACKAGES) {
    for (const flagSet of GOLDEN.docFlagSets) {
      it(`cleans ${pkg.id} exactly like the CLI with [${flagSet.id}]`, async () => {
        const expected = pkg.cleaned[flagSet.id]
        expect(expected, flagSet.id).toBeDefined()
        if (expected === undefined) return
        const { clean, extras } = splitFlagSet(flagSet.options)
        const result = await cleanOdtEntries(await entriesOf(pkg.bytesB64), clean, extras)

        expect(result.changedNodes).toBe(expected.changedNodes)
        const output = await readZip(result.bytes)
        expect(output.map((entry) => entry.name)).toEqual(
          expected.entries.map((entry) => entry.name),
        )
        expect(output.map((entry) => entry.compression)).toEqual(
          expected.entries.map((entry) => entry.compress),
        )
        const decoder = new TextDecoder()
        for (const entry of output) {
          expect(decoder.decode(entry.data), `${pkg.id} ${flagSet.id} ${entry.name}`).toBe(
            expected.parts[entry.name],
          )
        }
      })
    }
  }

  it('writes mimetype first and stored even when the source deflated it', async () => {
    const pkg = PACKAGES[0]
    expect(pkg).toBeDefined()
    if (pkg === undefined) return
    // The normalised fixture stores every entry, so flip mimetype to deflate to
    // prove the rule is enforced by the writer and not inherited from the input.
    const source = await entriesOf(pkg.bytesB64)
    const perverse = source.map((entry) =>
      entry.name === 'mimetype' ? { ...entry, compression: ZIP_COMPRESSION.deflate } : entry,
    )
    const result = await cleanOdtEntries(perverse, {}, { metadata: false, rsids: false })
    const output = await readZip(result.bytes)
    expect(output[0]?.name).toBe('mimetype')
    expect(output[0]?.compression).toBe(ZIP_COMPRESSION.stored)
    expect(output.slice(1).every((entry) => entry.compression === ZIP_COMPRESSION.deflate)).toBe(
      true,
    )
  })

  it('removes user-defined meta fields only with --metadata', async () => {
    const pkg = PACKAGES[0]
    if (pkg === undefined) return
    const entries = await entriesOf(pkg.bytesB64)
    const decoder = new TextDecoder()
    const readMeta = async (bytes: Uint8Array): Promise<string> => {
      const parts = await readZip(bytes)
      return decoder.decode(parts.find((entry) => entry.name === 'meta.xml')?.data)
    }
    const kept = await cleanOdtEntries(entries, {}, { metadata: false, rsids: false })
    const blanked = await cleanOdtEntries(entries, {}, { metadata: true, rsids: false })
    expect(await readMeta(kept.bytes)).toContain('<meta:user-defined')
    expect(await readMeta(blanked.bytes)).not.toContain('<meta:user-defined')
    expect(await readMeta(blanked.bytes)).toContain('<meta:generator></meta:generator>')
  })
})
