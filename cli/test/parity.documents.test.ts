/**
 * The four document fixtures, replayed through the built binary.
 *
 * WHAT IS ASSERTED, AND WHY NOT THE RAW BYTES. `golden.json` records a cleaned
 * package as `bytesB64` plus the entry list, the per-part XML and the count of
 * text nodes that changed. The bytes themselves are NOT compared: the archive is
 * re-deflated on the way out, and two correct deflate implementations may pick
 * different (equally valid) encodings for the same input. What has to be
 * identical is what the file MEANS: the same entries, in the same order, with
 * the same compression method, each carrying the same XML, and the same number
 * of text nodes touched. That is what this asserts.
 *
 * HOW `changedNodes` IS OBSERVED. It is not a JSON field; it is the number the
 * `-c` line prints. Reading it off stderr is deliberate: it proves the number a
 * person actually sees, and it keeps this test on the same black-box footing as
 * the rest of the suite.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { decodeUtf8, readZip } from '@ghostchars/engine/zip'

import { golden } from './helpers/golden.js'
import type { DocumentFixture } from './helpers/golden.js'
import { requireBuild, runCli } from './helpers/run.js'

/** A cleaned package, as `gen_golden.py` records it. */
const PACKAGE_CLEANED = z.object({
  changedNodes: z.number().int(),
  entries: z.array(z.object({ name: z.string(), compress: z.string() })),
  parts: z.record(z.string(), z.string()),
})

const INSPECT_PAYLOAD = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      ok: z.boolean(),
      total: z.number().int(),
      findings: z.array(
        z.object({
          line: z.number().int(),
          col: z.number().int(),
          cp: z.number().int(),
          kind: z.string(),
          flag: z.string(),
        }),
      ),
      document: z.record(z.string(), z.unknown()),
    }),
  ),
})

/**
 * A docFlagSet id maps onto the flags a person would type.
 *
 * `metadata` and `rsids` are document switches that `strip_invisible.py` does
 * not have at all; the rest are ordinary clean options. Both namespaces reach
 * the same command here, which is the whole point of folding `clean_file.py`
 * into `clean`.
 */
const FLAG_FOR: Readonly<Record<string, string>> = {
  metadata: '--metadata',
  rsids: '--rsids',
  spaces: '--spaces',
  punct: '--punct',
  aggressive: '--aggressive',
  newlines: '--newlines',
}

function flagsFor(options: readonly string[]): string[] {
  return options.map((option) => {
    const flag = FLAG_FOR[option]
    if (flag === undefined) throw new Error(`no CLI flag is mapped for docFlagSet option ${option}`)
    return flag
  })
}

function extensionOf(fixture: DocumentFixture): string {
  return fixture.kind === 'html' ? '.html' : `.${fixture.kind}`
}

/** The input bytes for one fixture: a package is base64, a page is its source. */
function inputBytes(fixture: DocumentFixture): Buffer {
  if (fixture.kind === 'html') {
    const source = fixture.source
    if (source === undefined) throw new Error(`${fixture.id} has no source`)
    return Buffer.from(source, 'utf8')
  }
  const encoded = fixture.bytesB64
  if (encoded === undefined) throw new Error(`${fixture.id} has no bytesB64`)
  return Buffer.from(encoded, 'base64')
}

const CHANGED_NODES = /: (\d+) text nodes? changed/

/**
 * What compression each entry of the cleaned package should carry.
 *
 * `golden.json`'s `entries[].compress` cannot be compared against directly, and
 * the reason is written into `gen_golden.py`: every fixture archive is
 * NORMALIZED before it is recorded, rewritten with a 1980 timestamp and STORED
 * entries, because deflate output differs between zlib builds and would make
 * the fixture machine-dependent. `compress` keeps what Python actually chose
 * for the un-normalized original. So the fixture bytes fed in here are stored
 * throughout, and the honest question is what the cleaner does with them:
 *
 *  - `.docx` keeps every entry's method exactly as it found it, which is what
 *    `clean_docx`'s `writestr(item, data)` does in Python, since a `ZipInfo`
 *    carries its own `compress_type`.
 *  - `.odt` rewrites `mimetype` as a fresh STORED entry (the format requires it
 *    to be first and uncompressed) and deflates everything else regardless of
 *    how the source stored it, which is what `clean_odt` does.
 */
async function expectedCompression(
  fixture: DocumentFixture,
  inputPath: string,
  entries: readonly { readonly name: string }[],
): Promise<string[]> {
  if (fixture.kind === 'odt') {
    return entries.map((entry) => (entry.name === 'mimetype' ? 'stored' : 'deflate'))
  }
  const source = await readZip(readFileSync(inputPath))
  const byName = new Map(source.map((entry) => [entry.name, entry.compression]))
  return entries.map((entry) => byName.get(entry.name) ?? 'deflate')
}

let root = ''

beforeAll(() => {
  requireBuild()
  root = mkdtempSync(join(tmpdir(), 'ghostchars-docs-'))
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('document clean parity', () => {
  for (const fixture of golden.documents) {
    for (const flagSet of golden.docFlagSets) {
      it(`${fixture.id} under docFlagSet ${flagSet.id}`, async () => {
        const extension = extensionOf(fixture)
        const stem = `${fixture.id}-${golden.docFlagSets.indexOf(flagSet)}`
        const input = join(root, `${stem}${extension}`)
        const output = join(root, `${stem}.out${extension}`)
        writeFileSync(input, inputBytes(fixture))

        const result = runCli([
          'clean',
          '-c',
          ...flagsFor(flagSet.options),
          '-o',
          output,
          input,
        ])
        expect(result.code).toBe(0)

        const expected = fixture.cleaned[flagSet.id]
        expect(expected, `no golden result for ${flagSet.id}`).toBeDefined()

        if (fixture.kind === 'html') {
          expect(typeof expected).toBe('string')
          expect(readFileSync(output, 'utf8')).toBe(expected)
          return
        }

        const golden_ = PACKAGE_CLEANED.parse(expected)
        const changed = CHANGED_NODES.exec(result.stderr)
        expect(changed, `no text-node count on stderr: ${result.stderr}`).not.toBeNull()
        expect(Number(changed?.[1])).toBe(golden_.changedNodes)

        const entries = await readZip(readFileSync(output))
        expect(entries.map((entry) => entry.name)).toEqual(
          golden_.entries.map((entry) => entry.name),
        )
        expect(entries.map((entry) => entry.compression)).toEqual(
          await expectedCompression(fixture, input, golden_.entries),
        )
        for (const [name, xml] of Object.entries(golden_.parts)) {
          const entry = entries.find((candidate) => candidate.name === name)
          expect(entry, `part ${name} is missing from the cleaned package`).toBeDefined()
          expect(entry === undefined ? '' : decodeUtf8(entry.data), `part ${name}`).toBe(xml)
        }
      })
    }
  }
})

describe('document inspect parity', () => {
  for (const fixture of golden.documents) {
    it(`${fixture.id} reports the same text, findings and report`, () => {
      const input = join(root, `inspect-${fixture.id}${extensionOf(fixture)}`)
      writeFileSync(input, inputBytes(fixture))

      const result = runCli(['inspect', '--json', '--limit', '1000', input])
      expect(result.code).toBe(fixture.findings.length === 0 ? 0 : 1)
      const payload = INSPECT_PAYLOAD.parse(JSON.parse(result.stdout))
      const entry = payload.results[0]
      expect(entry).toBeDefined()
      if (entry === undefined) return

      expect(entry.ok).toBe(true)
      expect(entry.total).toBe(fixture.findings.length)
      expect(
        entry.findings.map((finding) => [
          finding.line,
          finding.col,
          finding.cp,
          finding.kind,
          finding.flag,
        ]),
      ).toEqual(fixture.findings)

      // The document text and the parts it came from ride along in the same
      // block; every other key is the format's own report and must match
      // `clean_file.py`'s dictionary field for field.
      expect(entry.document['text']).toBe(fixture.text)
      expect(entry.document['text_parts']).toEqual(fixture.textParts ?? [])
      const report = { ...entry.document }
      delete report['text']
      delete report['text_parts']
      expect(report).toEqual(fixture.inspect)
    })
  }
})
