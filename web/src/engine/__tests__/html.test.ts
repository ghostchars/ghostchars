import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CLEAN_OPTION_KEYS, type CleanOptions } from '@/engine'

import {
  cleanHtml,
  type HtmlReport,
  htmlText,
  htmlUnescape,
  inspectHtml,
  pythonStrip,
  xmlEscape,
} from '../html'

/**
 * HTML parity against `clean_file.py`, plus the entity layer every document
 * format in the engine leans on.
 *
 * `htmlUnescape` is checked against cases taken from CPython's own test suite
 * for `html.unescape`, because the fixture only exercises `&amp;`, `&zwj;` and
 * `&#8203;`, and the interesting failures are in the parts the fixture cannot
 * reach: the legacy no-semicolon references, the longest-prefix fallback, and
 * the numeric references HTML remaps or drops.
 */

const GOLDEN_PATH = fileURLToPath(new URL('../__fixtures__/golden.json', import.meta.url))

const packageSchema = z.object({
  id: z.string(),
  kind: z.literal('html'),
  note: z.string(),
  source: z.string(),
  text: z.string(),
  findings: z.array(z.tuple([z.number(), z.number(), z.number(), z.string(), z.string()])),
  inspect: z.object({
    comments: z.number(),
    hidden_elements: z.number(),
    generator: z.string().nullable(),
    attr_hits: z.number(),
  }),
  cleaned: z.record(z.string(), z.string()),
})

const goldenSchema = z.object({
  docFlagSets: z.array(z.object({ id: z.string(), options: z.array(z.string()) })),
  documents: z.array(z.looseObject({ kind: z.string() })),
})

const GOLDEN = goldenSchema.parse(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))
const PAGES = GOLDEN.documents
  .filter((document) => document.kind === 'html')
  .map((document) => packageSchema.parse(document))

function cleanOptions(options: readonly string[]): Partial<CleanOptions> {
  const clean: Partial<CleanOptions> = {}
  for (const key of CLEAN_OPTION_KEYS) {
    if (options.includes(key)) clean[key] = true
  }
  return clean
}

const REPORT_FIELDS = [
  ['comments', 'comments'],
  ['hiddenElements', 'hidden_elements'],
  ['generator', 'generator'],
  ['attributeHits', 'attr_hits'],
] as const satisfies readonly (readonly [keyof HtmlReport, string])[]

function toPythonReport(report: HtmlReport): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, pythonKey] of REPORT_FIELDS) out[pythonKey] = report[field]
  return out
}

describe('inspectHtml / htmlText', () => {
  for (const page of PAGES) {
    it(`reports what Python reports for ${page.id} (${page.note})`, () => {
      expect(htmlText(page.source)).toBe(page.text)
      expect(toPythonReport(inspectHtml(page.source))).toEqual(page.inspect)
    })
  }

  it('finds no generator when the page does not declare one', () => {
    expect(inspectHtml('<p>plain</p>').generator).toBeNull()
  })
})

describe('cleanHtml', () => {
  for (const page of PAGES) {
    for (const flagSet of GOLDEN.docFlagSets) {
      it(`cleans ${page.id} exactly like the CLI with [${flagSet.id}]`, () => {
        const expected = page.cleaned[flagSet.id]
        expect(expected, flagSet.id).toBeDefined()
        expect(cleanHtml(page.source, cleanOptions(flagSet.options))).toBe(expected)
      })
    }
  }

  it('leaves tags, comments, script and style untouched', () => {
    const zwsp = '​'
    const source =
      `<!-- keep${zwsp} --><p>he${zwsp}llo</p><script>var x="${zwsp}"</script>` +
      `<style>p{content:"${zwsp}"}</style><img alt="al${zwsp}t">`
    const cleaned = cleanHtml(source, {})
    expect(cleaned).toContain(`<!-- keep${zwsp} -->`)
    expect(cleaned).toContain(`<script>var x="${zwsp}"</script>`)
    expect(cleaned).toContain(`<style>p{content:"${zwsp}"}</style>`)
    expect(cleaned).toContain(`alt="al${zwsp}t"`)
    expect(cleaned).toContain('<p>hello</p>')
  })

  it('rewrites a node only when cleaning changed it, so entities survive', () => {
    // The `&nbsp;` node is untouched, so it stays an entity rather than being
    // decoded and re-emitted as a literal U+00A0.
    expect(cleanHtml('<p>a&nbsp;b</p>', {})).toBe('<p>a&nbsp;b</p>')
    // This node DID change, so it is re-escaped: `&nbsp;` becomes the literal.
    expect(cleanHtml('<p>a&nbsp;b&#8203;c</p>', {})).toBe('<p>a bc</p>')
  })
})

describe('htmlUnescape', () => {
  it('resolves named references, with and without the semicolon', () => {
    expect(htmlUnescape('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
    expect(htmlUnescape('&zwj;')).toBe('‍')
    expect(htmlUnescape('&nbsp;')).toBe(' ')
    // 106 legacy names still resolve without their semicolon; the rest do not.
    expect(htmlUnescape('&amp')).toBe('&')
    expect(htmlUnescape('&zwj')).toBe('&zwj')
  })

  it('falls back to the longest valid prefix, like the HTML parser', () => {
    expect(htmlUnescape('&notit;')).toBe('¬it;')
    expect(htmlUnescape('&notin;')).toBe('∉')
  })

  it('resolves multi-codepoint references', () => {
    expect(htmlUnescape('&NotEqualTilde;')).toBe('≂̸')
  })

  it('handles numeric references, including the ones HTML remaps or drops', () => {
    expect(htmlUnescape('&#8203;')).toBe('​')
    expect(htmlUnescape('&#x200B;')).toBe('​')
    expect(htmlUnescape('&#233')).toBe('é')
    expect(htmlUnescape('&#0;')).toBe('�')
    expect(htmlUnescape('&#151;')).toBe('—') // Windows-1252 remap
    expect(htmlUnescape('&#1;')).toBe('') // invalid codepoint, dropped
    expect(htmlUnescape('&#xD800;')).toBe('�') // lone surrogate
    expect(htmlUnescape('&#x110000;')).toBe('�') // out of range
  })

  it('leaves text with no ampersand exactly as it was', () => {
    expect(htmlUnescape('nothing to do here')).toBe('nothing to do here')
    expect(htmlUnescape('&unknownthing;')).toBe('&unknownthing;')
  })
})

describe('xmlEscape', () => {
  it('escapes only the three characters XML text nodes require', () => {
    expect(xmlEscape('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d "e" \'f\'')
  })
})

describe('pythonStrip', () => {
  it('strips what Python strips, not what JavaScript strips', () => {
    // Python strips U+001C–U+001F and U+0085; JavaScript's trim() does not.
    expect(pythonStrip('\u001c\u0085 hi \u001f')).toBe('hi')
    // JavaScript strips U+FEFF; Python does not, and neither does this.
    expect(pythonStrip('\ufeffhi\ufeff')).toBe('\ufeffhi\ufeff')
  })
})
