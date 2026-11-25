/**
 * Documents: `.docx`, `.odt`, `.html` and `.htm`, through `clean` and `inspect`.
 *
 * WHAT IS BEING PROVEN HERE, ON TOP OF `parity.documents.test.ts`. That suite
 * proves the cleaned package matches the golden record. This one proves the
 * command around it: which extension takes which branch, where the output goes
 * when nobody said, that `--metadata` and `--rsids` reach the package, that
 * `--as text` really does fall back to the plain-text cleaner, and that a
 * broken archive and a hostile one produce two different sentences.
 *
 * THE TWO ZIP FAILURES ARE KEPT APART ON PURPOSE. "Not a valid docx package"
 * means the file is broken and the user should look at where it came from.
 * "Expands too far" means the file is lying about its own size and the user
 * should not open it at all. Collapsing them into one message would throw away
 * the only part a person can act on.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decodeUtf8, readZip } from '@ghostchars/engine/zip'

import { golden } from './helpers/golden.js'
import type { DocumentFixture } from './helpers/golden.js'
import { requireBuild, runCli } from './helpers/run.js'

let root = ''

function fixture(id: string): DocumentFixture {
  const found = golden.documents.find((document) => document.id === id)
  if (found === undefined) throw new Error(`no document fixture ${id}`)
  return found
}

function packageBytes(id: string): Buffer {
  const encoded = fixture(id).bytesB64
  if (encoded === undefined) throw new Error(`${id} has no bytesB64`)
  return Buffer.from(encoded, 'base64')
}

function pageSource(): string {
  const source = fixture('html-page').source
  if (source === undefined) throw new Error('html-page has no source')
  return source
}

/** Write one input file into a fresh directory and return both paths. */
function place(name: string, contents: string | Uint8Array): { dir: string; path: string } {
  const dir = mkdtempSync(join(root, 'case-'))
  const path = join(dir, name)
  writeFileSync(path, contents)
  return { dir, path }
}

async function partsOf(path: string): Promise<Map<string, string>> {
  const entries = await readZip(readFileSync(path))
  return new Map(entries.map((entry) => [entry.name, decodeUtf8(entry.data)]))
}

beforeAll(() => {
  requireBuild()
  root = mkdtempSync(join(tmpdir(), 'ghostchars-doc-'))
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// where the output goes
// ---------------------------------------------------------------------------

describe('document output paths', () => {
  it('writes <root>.clean<ext> when nobody said where', async () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const result = runCli(['clean', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(readdirSync(dir).sort()).toEqual(['essay.clean.docx', 'essay.docx'])
    const parts = await partsOf(join(dir, 'essay.clean.docx'))
    expect(parts.has('word/document.xml')).toBe(true)
  })

  it('honours -o, and says where it went under -c', () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const output = join(dir, 'elsewhere.docx')
    const result = runCli(['clean', '-c', '-o', output, path])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`text nodes changed -> ${output}`)
    expect(readdirSync(dir).sort()).toEqual(['elsewhere.docx', 'essay.docx'])
  })

  it('rewrites the package in place under -i', async () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const result = runCli(['clean', '-i', path])
    expect(result.code).toBe(0)
    expect(readdirSync(dir)).toEqual(['essay.docx'])
    const parts = await partsOf(path)
    const document = parts.get('word/document.xml') ?? ''
    expect(document).not.toContain('\u200B')
  })

  it('refuses -o with two inputs and -o with -i, before reading anything', () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const second = join(dir, 'copy.docx')
    writeFileSync(second, packageBytes('docx-essay'))

    const two = runCli(['clean', '-o', join(dir, 'out.docx'), path, second])
    expect(two.code).toBe(2)
    expect(two.stderr).toContain('error: -o takes a single input file')

    const both = runCli(['clean', '-i', '-o', join(dir, 'out.docx'), path])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('error: -o and -i cannot be combined')
    expect(readdirSync(dir).sort()).toEqual(['copy.docx', 'essay.docx'])
  })
})

// ---------------------------------------------------------------------------
// docx switches
// ---------------------------------------------------------------------------

describe('docx --metadata and --rsids', () => {
  it('blanks the core and app fields and drops docProps/custom.xml', async () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const before = await partsOf(path)
    expect(before.get('docProps/core.xml')).toContain('Jane Doe')
    expect(before.has('docProps/custom.xml')).toBe(true)

    expect(runCli(['clean', '--metadata', path]).code).toBe(0)
    const after = await partsOf(join(dir, 'essay.clean.docx'))
    expect(after.has('docProps/custom.xml')).toBe(false)
    expect(after.get('docProps/core.xml')).not.toContain('Jane Doe')
    expect(after.get('docProps/core.xml')).toContain('<dc:creator></dc:creator>')
    expect(after.get('docProps/app.xml')).not.toContain('ACME')
  })

  it('strips the rsid attributes and the settings block', async () => {
    const { dir, path } = place('essay.docx', packageBytes('docx-essay'))
    const before = await partsOf(path)
    expect(before.get('word/document.xml')).toMatch(/w:rsid[A-Za-z]*="[0-9A-Fa-f]{8}"/)
    expect(before.get('word/settings.xml')).toContain('<w:rsids>')

    expect(runCli(['clean', '--rsids', path]).code).toBe(0)
    const after = await partsOf(join(dir, 'essay.clean.docx'))
    expect(after.get('word/document.xml')).not.toMatch(/w:rsid[A-Za-z]*="[0-9A-Fa-f]{8}"/)
    expect(after.get('word/settings.xml')).not.toContain('<w:rsids>')
  })

  it('names both extras on the -c line', () => {
    const { path } = place('essay.docx', packageBytes('docx-essay'))
    const result = runCli(['clean', '-c', '--metadata', '--rsids', path])
    expect(result.stderr).toContain(' + metadata + rsids -> ')
  })

  it('counts a document as changed under --check when only metadata would go', () => {
    const { path } = place('essay.docx', packageBytes('docx-essay'))
    const result = runCli(['clean', '--check', '-c', '--metadata', path])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${path}: would change\n`)
  })
})

// ---------------------------------------------------------------------------
// odt and html
// ---------------------------------------------------------------------------

describe('odt and html', () => {
  it('cleans an .odt and keeps mimetype first and stored', async () => {
    const { dir, path } = place('doc.odt', packageBytes('odt-doc'))
    expect(runCli(['clean', path]).code).toBe(0)
    const entries = await readZip(readFileSync(join(dir, 'doc.clean.odt')))
    expect(entries[0]?.name).toBe('mimetype')
    expect(entries[0]?.compression).toBe('stored')
  })

  it('cleans an .html page structurally and writes it beside the original', () => {
    const { dir, path } = place('page.html', pageSource())
    expect(runCli(['clean', path]).code).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['page.clean.html', 'page.html'])
    const cleaned = readFileSync(join(dir, 'page.clean.html'), 'utf8')
    expect(cleaned).toBe(fixture('html-page').cleaned['none'])
    // Markup, comments, scripts and styles pass through untouched.
    expect(cleaned).toContain('<!--')
  })

  it('treats .htm exactly like .html', () => {
    const { dir, path } = place('page.htm', pageSource())
    expect(runCli(['clean', path]).code).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['page.clean.htm', 'page.htm'])
  })

  /**
   * `--as text` restores the reference behaviour of `strip_invisible.py`, which
   * cleans the markup along with the words. It also means the result is text,
   * so it goes to stdout rather than to a sibling file.
   */
  it('--as text falls back to the plain-text cleaner and differs from the structural pass', () => {
    const { dir, path } = place('page.html', pageSource())
    const forced = runCli(['clean', '--as', 'text', '--bar', 'text', path])
    expect(forced.code).toBe(0)
    expect(readdirSync(dir)).toEqual(['page.html'])
    expect(forced.stdout.length).toBeGreaterThan(0)

    expect(runCli(['clean', '--bar', 'text', path]).code).toBe(0)
    const structural = readFileSync(join(dir, 'page.clean.html'), 'utf8')
    expect(forced.stdout).not.toBe(structural)
  })

  it('treats an unrecognized extension as plain text rather than an error', () => {
    const { dir, path } = place('notes.xyz', 'a\u200Bb\n')
    const result = runCli(['clean', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ab\n')
    expect(readdirSync(dir)).toEqual(['notes.xyz'])
  })
})

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe('inspect over documents', () => {
  it('prints the character summary and then the document report', () => {
    const { path } = place('essay.docx', packageBytes('docx-essay'))
    const result = runCli(['inspect', path])
    expect(result.code).toBe(1)
    const lines = result.stdout.split('\n')
    expect(lines[0]).toBe(`${path}:`)
    expect(lines[1]).toMatch(/^ {2}text: \d+ suspicious characters$/)
    expect(result.stdout).toContain('  document:')
    expect(result.stdout).toContain('hidden text runs (w:vanish)')
    expect(result.stdout).toContain('    metadata:')
    expect(result.stdout).toContain('dc:creator')
  })

  it('reports an .odt and an .html page in the same two-part shape', () => {
    const odt = place('doc.odt', packageBytes('odt-doc'))
    const odtResult = runCli(['inspect', odt.path])
    expect(odtResult.stdout).toContain('  document:')
    expect(odtResult.stdout).toContain('annotations (comments)')

    const page = place('page.html', pageSource())
    const pageResult = runCli(['inspect', page.path])
    expect(pageResult.stdout).toContain('  document:')
    expect(pageResult.stdout).toContain('HTML comments')
    expect(pageResult.stdout).toContain('generator meta: Docs Exporter')
  })

  it('exits on the character findings alone, not on the document report', () => {
    const { path } = place('page.html', '<p>plain and clean</p>\n')
    const result = runCli(['inspect', path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('  text: clean')
  })
})

// ---------------------------------------------------------------------------
// broken and hostile archives
// ---------------------------------------------------------------------------

/** Rewrite the end-of-central-directory record to claim far too many members. */
function claimTooManyEntries(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes)
  const signature = 0x06054b50
  for (let offset = copy.length - 22; offset >= 0; offset -= 1) {
    if (copy.readUInt32LE(offset) === signature) {
      copy.writeUInt16LE(5000, offset + 10)
      return copy
    }
  }
  throw new Error('no end-of-central-directory record in the fixture')
}

describe('archives that cannot be read', () => {
  it('calls a truncated package broken, and exits 2', () => {
    const bytes = packageBytes('docx-essay')
    const { dir, path } = place('broken.docx', bytes.subarray(0, bytes.length - 40))
    const result = runCli(['clean', path])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(`${path}: not a valid docx package\n`)
    expect(readdirSync(dir)).toEqual([basename(path)])
  })

  it('calls an archive that claims too much hostile, and exits 2', () => {
    const { path } = place('bomb.docx', claimTooManyEntries(packageBytes('docx-essay')))
    const result = runCli(['clean', path])
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(`${path}: expands too far, refusing to read\n`)
  })

  it('says the same two things from inspect', () => {
    const bytes = packageBytes('odt-doc')
    const broken = place('broken.odt', bytes.subarray(0, bytes.length - 40))
    expect(runCli(['inspect', broken.path]).stderr).toBe(
      `${broken.path}: not a valid odt package\n`,
    )
    const bomb = place('bomb.odt', claimTooManyEntries(bytes))
    expect(runCli(['inspect', bomb.path]).stderr).toBe(
      `${bomb.path}: expands too far, refusing to read\n`,
    )
  })
})
