/**
 * Every tool, over a linked pair of in-memory transports.
 *
 * WHY IN PROCESS. This is the fast, per-behaviour half of the MCP coverage: the
 * same `McpServer` the binary builds, driven by the official `Client`, with no
 * subprocess to spawn per assertion. `mcp.stdio.test.ts` owns the other half,
 * the things that only exist in a real process: the shipped bundle, the stdio
 * framing and the stdout guard.
 *
 * WHY `listTools` COMES FIRST IN EVERY SESSION. The client compiles and caches
 * an output-schema validator per tool from the `tools/list` payload, and only
 * then does `callTool` check `structuredContent` against it. Listing first is
 * therefore not throat-clearing: it is what turns every later call into a live
 * assertion that the advertised schema and the real payload agree.
 *
 * SPECIMENS ARE WRITTEN AS ESCAPES. A zero-width space or an em dash typed
 * literally into this file would be contraband inside a repository whose own
 * hygiene gate walks every text file it can find. The escape is resolved by the
 * JavaScript parser, so the assertion still runs against the real character.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createServer } from '../src/mcp/server.js'
import type { ServeOptions } from '../src/mcp/server.js'
import { STYLE_REPORT_SCHEMA } from '../src/mcp/schemas.js'
import { golden } from './helpers/golden.js'

/** U+200B ZERO WIDTH SPACE, the character the product exists to find. */
const ZWSP = '\u200B'
/** U+2014 EM DASH. Between two non-spaces it is a rewrite site. */
const EM_DASH = '\u2014'
/** U+2014 EM DASH between two words: the one rewrite site that matters. */
const DASH_SENTENCE = `Ghostchars is a text tool${EM_DASH}it finds what a reader cannot see.`
/** U+201C and U+201D, which flatten correctly and are NOT rewrite sites. */
const CURLY_ONLY = `He said \u201Cno\u201D and meant it.`

interface Session {
  readonly client: Client
  readonly close: () => Promise<void>
}

const openSessions: Session[] = []

async function connect(overrides: Partial<ServeOptions> = {}): Promise<Client> {
  const options: ServeOptions = {
    name: 'ghostchars',
    allowWrite: false,
    toolPrefix: '',
    root: process.cwd(),
    ...overrides,
  }
  const { server } = createServer(options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'ghostchars-tests', version: '1.0.0' })
  await server.server.connect(serverTransport)
  await client.connect(clientTransport)
  // Caching the output-schema validators is what makes every later callTool
  // validate its own structured content.
  await client.listTools()
  const session: Session = {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
  openSessions.push(session)
  return client
}

afterEach(async () => {
  while (openSessions.length > 0) {
    const session = openSessions.pop()
    if (session !== undefined) await session.close()
  }
})

/**
 * `callTool` returns a union that includes the legacy `toolResult` shape, and
 * this package bans `as`, so the parts these tests read are pulled out with a
 * schema rather than a cast. A wrong shape then fails here, by name, instead of
 * surfacing as `undefined` three assertions later.
 */
const TEXT_BLOCK = z.object({ type: z.literal('text'), text: z.string() })

const TOOL_RESULT = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
})

function structured(result: unknown): Record<string, unknown> {
  const value = TOOL_RESULT.parse(result).structuredContent
  if (value === undefined) throw new Error('the tool returned no structuredContent')
  return value
}

function blockText(result: unknown, index: number): string {
  return TEXT_BLOCK.parse(TOOL_RESULT.parse(result).content[index]).text
}

function blockCount(result: unknown): number {
  return TOOL_RESULT.parse(result).content.length
}

function isErrorResult(result: unknown): boolean {
  return TOOL_RESULT.parse(result).isError === true
}

function numberAt(value: Record<string, unknown>, key: string): number {
  const found = value[key]
  if (typeof found !== 'number') throw new Error(`${key} is not a number`)
  return found
}

function listAt(value: Record<string, unknown>, key: string): unknown[] {
  const found = value[key]
  if (!Array.isArray(found)) throw new Error(`${key} is not an array`)
  return found
}

// ---------------------------------------------------------------------------
// the tool list
// ---------------------------------------------------------------------------

describe('the registered surface', () => {
  it('offers exactly four tools, and no writer', async () => {
    const client = await connect()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'clean_text',
      'inspect_text',
      'style_report',
      'check_paths',
    ])
  })

  it('adds clean_files, and only that, under --allow-write', async () => {
    const client = await connect({ allowWrite: true })
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'clean_text',
      'inspect_text',
      'style_report',
      'check_paths',
      'clean_files',
    ])
  })

  it('renames every tool under --tool-prefix', async () => {
    const client = await connect({ toolPrefix: 'gc_', allowWrite: true })
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'gc_clean_text',
      'gc_inspect_text',
      'gc_style_report',
      'gc_check_paths',
      'gc_clean_files',
    ])
  })

  it('declares a description, both schemas and honest annotations on every tool', async () => {
    const client = await connect({ allowWrite: true })
    const listed = await client.listTools()
    for (const tool of listed.tools) {
      expect(tool.description ?? '', tool.name).toContain('Ghostchars')
      expect(tool.inputSchema, tool.name).toBeDefined()
      expect(tool.outputSchema, tool.name).toBeDefined()
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false)
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false)
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(tool.name !== 'clean_files')
    }
  })

  it('offers the gate no max bar', async () => {
    const client = await connect()
    // The SDK validates the input schema before the handler runs and turns the
    // failure into an error RESULT rather than a transport error, so the model
    // sees a message it can act on instead of a broken call.
    const result = await client.callTool({
      name: 'check_paths',
      arguments: { paths: ['.'], bar: 'max' },
    })
    expect(isErrorResult(result)).toBe(true)
    expect(blockText(result, 0)).toContain('bar')
    expect(blockText(result, 0)).toContain('default')
    expect(blockText(result, 0)).toContain('text')
  })
})

// ---------------------------------------------------------------------------
// clean_text
// ---------------------------------------------------------------------------

describe('clean_text', () => {
  it('says so and carries no text when nothing changed', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'clean_text',
      arguments: { text: 'Plain ASCII prose, nothing to do here.' },
    })
    const payload = structured(result)
    expect(payload['changed']).toBe(false)
    expect(payload['cleaned']).toBeUndefined()
    expect(blockCount(result)).toBe(1)
    expect(blockText(result, 0)).toBe(
      'Ghostchars: no changes. The text is already clean at bar=text.',
    )
  })

  it('returns the cleaned text in its own block, and in the structured payload', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'clean_text',
      arguments: { text: `A${ZWSP}B` },
    })
    const payload = structured(result)
    expect(payload['changed']).toBe(true)
    expect(payload['cleaned']).toBe('AB')
    expect(blockCount(result)).toBe(2)
    // The second block is the cleaned text and nothing else, so a model can
    // copy it without unescaping anything.
    expect(blockText(result, 1)).toBe('AB')
    expect(blockText(result, 0)).toContain('Ghostchars: cleaned at bar=text.')
    expect(blockText(result, 0)).toContain('The cleaned text follows in the next block.')
    expect(blockText(result, 0)).toContain('U+200B')
  })

  it('counts characters in codepoints, before and after', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: `A${ZWSP}B` } }),
    )
    expect(numberAt(payload, 'chars_before')).toBe(3)
    expect(numberAt(payload, 'chars_after')).toBe(2)
    expect(payload['summary']).toMatchObject({
      removed: 1,
      replaced: 0,
      kept_load_bearing: 0,
      found_not_targeted: 0,
    })
  })

  it('reports the bar it actually applied', async () => {
    const client = await connect()
    const textBar = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: 'a', bar: 'text' } }),
    )
    expect(textBar['options_applied']).toEqual(['punct', 'spaces'])
    const defaultBar = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: 'a', bar: 'default' } }),
    )
    expect(defaultBar['options_applied']).toEqual([])
  })

  it('lets an override turn one more option on, and never off', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({
        name: 'clean_text',
        arguments: { text: 'a', bar: 'default', options: { collapse: true, punct: false } },
      }),
    )
    // `punct: false` cannot subtract from the bar, and `default` never had it.
    expect(payload['options_applied']).toEqual(['collapse'])
  })

  it('takes gutters as an override, and applies it under the max bar', async () => {
    const client = await connect()
    const text = '\u258E quoted\n\u258E\n'
    const override = structured(
      await client.callTool({
        name: 'clean_text',
        arguments: { text, bar: 'default', options: { gutters: true } },
      }),
    )
    expect(override['options_applied']).toEqual(['gutters'])
    expect(override['cleaned']).toBe('quoted\n\n')
    const max = structured(await client.callTool({ name: 'clean_text', arguments: { text, bar: 'max' } }))
    expect(max['options_applied']).toContain('gutters')
    const textBar = structured(await client.callTool({ name: 'clean_text', arguments: { text, bar: 'text' } }))
    expect(textBar['options_applied']).not.toContain('gutters')
  })

  it('lists a dash between two words as a rewrite site', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: DASH_SENTENCE } }),
    )
    const sites = listAt(payload, 'rewrite_sites')
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({
      line: 1,
      u: 'U+2014',
      name: 'EM DASH',
      hint: 'restructure the sentence; the mechanical result is a bare hyphen',
    })
  })

  it('lists no rewrite site for curly quotes, which flatten correctly', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: CURLY_ONLY } }),
    )
    expect(payload['changed']).toBe(true)
    expect(listAt(payload, 'rewrite_sites')).toHaveLength(0)
  })

  it('caps the rewrite sites by max_findings and reports the true total', async () => {
    /**
     * `rewrite_sites` was the one list in this payload with no cap at all: one
     * record per dash, each carrying a quoted source line. A 200 KB paragraph
     * built a 23 MB response, which is unbounded growth on the shared server's
     * own connection, and the cap that already governs `findings` is the natural
     * one to reuse.
     */
    const client = await connect()
    const many = `word${EM_DASH}word `.repeat(200)
    const payload = structured(
      await client.callTool({ name: 'clean_text', arguments: { text: many, max_findings: 5 } }),
    )
    expect(listAt(payload, 'rewrite_sites')).toHaveLength(5)
    expect(payload['rewrite_sites_total']).toBe(200)
    expect(payload['rewrite_sites_truncated']).toBe(true)
    // The cleaned text is never the thing that gets cut.
    expect(z.string().parse(payload['cleaned'])).toContain('word - word')
  })

  it('answers a long single line of dashes in linear time', async () => {
    /**
     * MEASURED before the fix, over the stdio server, on one 200,000 character
     * line: `clean_text` at its default bar took 84,997 ms and held the whole
     * event loop for the entirety of it, so a `ping` sent half a second in was
     * not answered until the big call finished. The shape was clean quadratic,
     * from a per-call `slice` of the line in `TextIndex.positionAtUnit` and a
     * per-call spread of the line in `contextLine`. This asserts the shape is
     * gone rather than a particular millisecond count: at 20,000 dashes the old
     * code was already several seconds.
     */
    const client = await connect()
    const started = Date.now()
    const payload = structured(
      await client.callTool({
        name: 'clean_text',
        arguments: { text: `a${EM_DASH}`.repeat(20_000), max_findings: 10 },
      }),
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(payload['rewrite_sites_total']).toBe(19_999)
    expect(listAt(payload, 'rewrite_sites')).toHaveLength(10)
  })

  it('lists no rewrite site at all when punct is off', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({
        name: 'clean_text',
        arguments: { text: DASH_SENTENCE, bar: 'default' },
      }),
    )
    expect(listAt(payload, 'rewrite_sites')).toHaveLength(0)
  })

  it('reports a truncated findings list rather than truncating it silently', async () => {
    const client = await connect()
    const noisy = `x${ZWSP}`.repeat(20)
    const payload = structured(
      await client.callTool({
        name: 'clean_text',
        arguments: { text: noisy, max_findings: 5 },
      }),
    )
    expect(numberAt(payload, 'findings_total')).toBe(20)
    expect(listAt(payload, 'findings')).toHaveLength(5)
    expect(payload['findings_truncated']).toBe(true)
    // The cleaned text is never truncated, whatever the cap says.
    expect(payload['cleaned']).toBe('x'.repeat(20))
  })
})

// ---------------------------------------------------------------------------
// inspect_text
// ---------------------------------------------------------------------------

describe('inspect_text', () => {
  it('reads and never writes: the text comes back nowhere', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'inspect_text',
      arguments: { text: `A${ZWSP}B` },
    })
    const payload = structured(result)
    expect(Object.keys(payload)).not.toContain('cleaned')
    expect(payload['clean']).toBe(false)
    expect(numberAt(payload, 'total')).toBe(1)
    expect(numberAt(payload, 'returned')).toBe(1)
    expect(payload['truncated']).toBe(false)
  })

  it('formats its content block exactly as the CLI --show report does', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'inspect_text',
      arguments: { text: `A${ZWSP}B` },
    })
    expect(blockText(result, 0)).toBe(
      '<stdin>: 1 found\n  1:2\tU+200B\tinvisible                            ZERO WIDTH SPACE',
    )
  })

  it('says a clean text is clean, in one line', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'inspect_text', arguments: { text: 'plain' } })
    expect(blockText(result, 0)).toBe('<stdin>: clean')
    expect(structured(result)['clean']).toBe(true)
  })

  it('rolls findings up by kind before it lists them', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({
        name: 'inspect_text',
        arguments: { text: `A${ZWSP}B${ZWSP}C\u2014D` },
      }),
    )
    expect(payload['by_kind']).toEqual([
      { kind: 'invisible', flag: 'default', count: 2 },
      { kind: 'punct', flag: '--punct', count: 1 },
    ])
  })

  it('omits replacement for a deletion and carries it for a substitution', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({
        name: 'inspect_text',
        arguments: { text: `A${ZWSP}B\u2014C` },
      }),
    )
    const findings = listAt(payload, 'findings')
    expect(findings[0]).toEqual({
      line: 1,
      col: 2,
      cp: 0x200b,
      u: 'U+200B',
      name: 'ZERO WIDTH SPACE',
      kind: 'invisible',
      flag: 'default',
      action: 'removed',
    })
    expect(findings[1]).toMatchObject({ u: 'U+2014', action: 'replaced', replacement: '-' })
  })

  it('reports the cap instead of hiding it', async () => {
    const client = await connect()
    const payload = structured(
      await client.callTool({
        name: 'inspect_text',
        arguments: { text: `x${ZWSP}`.repeat(9), max_findings: 3 },
      }),
    )
    expect(numberAt(payload, 'total')).toBe(9)
    expect(numberAt(payload, 'returned')).toBe(3)
    expect(payload['truncated']).toBe(true)
  })

  /**
   * The name column is the CLI's contract with `strip_invisible.py --show`, and
   * an agent reading a finding over the wire gets the same column. The engine's
   * own name table has no entry for a look-alike letter, so this is the case
   * that would silently read `U+0440` if the server ever went back to the
   * engine's `toFinding` instead of `src/names.ts`.
   */
  it('names a look-alike letter, in the row and in the finding', async () => {
    const client = await connect()
    // U+0440 CYRILLIC SMALL LETTER ER inside an otherwise Latin word.
    const result = await client.callTool({
      name: 'inspect_text',
      arguments: { text: '\u0440ractice' },
    })
    expect(blockText(result, 0)).toBe(
      '<stdin>: 1 found\n  1:1\tU+0440\tconfusable      (needs --confusables) CYRILLIC SMALL LETTER ER',
    )
    expect(listAt(structured(result), 'findings')[0]).toMatchObject({
      u: 'U+0440',
      name: 'CYRILLIC SMALL LETTER ER',
    })
  })
})

// ---------------------------------------------------------------------------
// style_report
// ---------------------------------------------------------------------------

describe('style_report', () => {
  it('validates all 17 golden reports against its own output schema', async () => {
    const client = await connect()
    for (const sample of golden.style) {
      const result = await client.callTool({
        name: 'style_report',
        arguments: { text: sample.text },
      })
      // The client already validated this against the advertised JSON Schema;
      // parsing it again here says which fixture and which field if it drifts.
      expect(() => STYLE_REPORT_SCHEMA.parse(structured(result)), sample.id).not.toThrow()
      expect(structured(result)).toEqual(sample.report)
    }
  })

  it('returns the ASCII human render as its content block', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'style_report',
      arguments: { text: 'Aa bb. Cc dd. Ee ff.' },
    })
    const rendered = blockText(result, 0)
    expect(rendered.split('\n')[0]).toBe('<stdin>: 6 words, 3 sentences, 1 paragraphs')
    expect(rendered).toContain('range 2 to 2')
    expect(rendered).toContain('no strong machine-prose habits detected')
  })
})

// ---------------------------------------------------------------------------
// check_paths
// ---------------------------------------------------------------------------

describe('check_paths', () => {
  function tree(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(root, name), contents, 'utf8')
    }
    return root
  }

  it('passes a clean tree and names the bar it held it to', async () => {
    const root = tree({ 'a.md': 'plain ascii prose\n' })
    try {
      const client = await connect({ root })
      const result = await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } })
      const payload = structured(result)
      expect(payload['ok']).toBe(true)
      expect(numberAt(payload, 'files_scanned')).toBe(1)
      expect(numberAt(payload, 'files_failing')).toBe(0)
      // Asserted loosely on the count and the bar, not on the exact sentence,
      // because the wording lives in the frozen strings module.
      expect(blockText(result, 0)).toContain('1 file')
      expect(blockText(result, 0)).toContain('the default bar')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails a file the bar would change, with the position and the source line', async () => {
    const root = tree({ 'post.md': `Ghostchars is a text tool\u2014it finds things.\n` })
    try {
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({
          name: 'check_paths',
          arguments: { paths: ['post.md'], bar: 'text' },
        }),
      )
      expect(payload['ok']).toBe(false)
      expect(numberAt(payload, 'files_failing')).toBe(1)
      const failures = listAt(payload, 'failures')
      expect(failures[0]).toMatchObject({
        path: 'post.md',
        bar: 'text',
        status: 'changed',
        changed: 1,
        pinned: 0,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // These four are the reason `check_paths` runs `src/check/` instead of a
  // private copy. An agent that asks this tool about a repository and then
  // watches CI run `ghostchars check` over the same files has to get the same
  // answer, and a second implementation of a gate is a second gate.
  it('reads the repository ghostchars.json and applies its surfaces', async () => {
    const root = tree({
      'post.md': `An em dash\u2014here.\n`,
      'quoted.txt': `An em dash\u2014here.\n`,
      'ghostchars.json': JSON.stringify({
        version: 1,
        surfaces: [
          { id: 'invisibles', bar: 'default', include: ['**/*'] },
          { id: 'prose', bar: 'text', include: ['**/*.md'] },
        ],
      }),
    })
    try {
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } }),
      )
      // The .md file is claimed by the later, stricter surface and fails on the
      // dash. The .txt file is claimed only by `invisibles` and passes, even
      // though it holds the same character.
      expect(numberAt(payload, 'files_failing')).toBe(1)
      const failures = listAt(payload, 'failures')
      expect(failures[0]).toMatchObject({ path: 'post.md', bar: 'text', status: 'changed' })
      expect(payload['config']).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces a pin in both directions, exactly as the CLI gate does', async () => {
    const root = tree({
      'glyphs.md': `Two dashes\u2014here\u2014and there.\n`,
      'stale.md': 'nothing deliberate here\n',
      'ghostchars.json': JSON.stringify({
        version: 1,
        surfaces: [
          {
            id: 'prose',
            bar: 'text',
            include: ['**/*.md'],
            pins: { 'glyphs.md': 2, 'stale.md': 3 },
          },
        ],
      }),
    })
    try {
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } }),
      )
      const failures = listAt(payload, 'failures')
      // glyphs.md is pinned at its real count and passes in silence. stale.md
      // is pinned as deliberately dirty but is now clean, which is the failure
      // people forget to look for.
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ path: 'stale.md', status: 'pin-stale', pinned: 3 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('takes an explicit config path and reports which one it used', async () => {
    const root = tree({
      'post.md': `An em dash\u2014here.\n`,
      'strict.json': JSON.stringify({
        version: 1,
        surfaces: [{ id: 'prose', bar: 'text', include: ['**/*.md'] }],
      }),
    })
    try {
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({
          name: 'check_paths',
          arguments: { paths: ['.'], config: 'strict.json' },
        }),
      )
      expect(payload['ok']).toBe(false)
      expect(String(payload['config']).endsWith('strict.json')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports null for config when no ghostchars.json governs the run', async () => {
    const root = tree({ 'a.md': 'plain ascii prose\n' })
    try {
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } }),
      )
      expect(payload['config']).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a malformed config instead of quietly checking nothing', async () => {
    const root = tree({
      'a.md': 'plain ascii prose\n',
      'ghostchars.json': JSON.stringify({ version: 1, surfaces: [{ id: 'p', include: ['**/*'] }] }),
    })
    try {
      const client = await connect({ root })
      const result = await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } })
      expect(result.isError).toBe(true)
      expect(blockText(result, 0)).toContain('ghostchars.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('holds the same file to two different bars and gets two answers', async () => {
    const root = tree({ 'post.md': `An em dash\u2014here.\n` })
    try {
      const client = await connect({ root })
      const atDefault = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } }),
      )
      expect(atDefault['ok']).toBe(true)
      const atText = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'], bar: 'text' } }),
      )
      expect(atText['ok']).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a binary file instead of failing the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      writeFileSync(join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]))
      writeFileSync(join(root, 'a.md'), 'clean prose\n', 'utf8')
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'] } }),
      )
      expect(payload['ok']).toBe(true)
      expect(numberAt(payload, 'files_scanned')).toBe(1)
      expect(numberAt(payload, 'files_skipped')).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a path that resolves outside the root, and names it', async () => {
    const root = tree({ 'a.md': 'plain\n' })
    try {
      const client = await connect({ root })
      const result = await client.callTool({
        name: 'check_paths',
        arguments: { paths: ['../escape.md'] },
      })
      expect(isErrorResult(result)).toBe(true)
      expect(blockText(result, 0)).toContain('resolves outside the root')
      expect(blockText(result, 0)).toContain('../escape.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a truncated walk rather than pretending it saw everything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(root, `f${i}.md`), 'plain prose\n', 'utf8')
      }
      const client = await connect({ root })
      const payload = structured(
        await client.callTool({ name: 'check_paths', arguments: { paths: ['.'], max_files: 2 } }),
      )
      expect(payload['truncated']).toBe(true)
      expect(numberAt(payload, 'files_scanned')).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// clean_files
// ---------------------------------------------------------------------------

describe('clean_files', () => {
  it('does not exist unless the server was started with --allow-write', async () => {
    const client = await connect()
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).not.toContain('clean_files')
    // Unregistered rather than refusing: an agent must never discover a tool
    // that will always fail, because it will plan around it.
    const result = await client.callTool({ name: 'clean_files', arguments: { paths: ['a.md'] } })
    expect(isErrorResult(result)).toBe(true)
    expect(blockText(result, 0)).toContain('not found')
  })

  it('writes the cleaned file, atomically, and reports what it did', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      writeFileSync(join(root, 'a.md'), `A${ZWSP}B\n`, 'utf8')
      writeFileSync(join(root, 'b.md'), 'already clean\n', 'utf8')
      const client = await connect({ root, allowWrite: true })
      const payload = structured(
        await client.callTool({ name: 'clean_files', arguments: { paths: ['a.md', 'b.md'] } }),
      )
      expect(listAt(payload, 'changed')[0]).toMatchObject({
        path: 'a.md',
        removed: 1,
        replaced: 0,
        chars_delta: 1,
      })
      expect(payload['unchanged']).toEqual(['b.md'])
      expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('AB\n')
      expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe('already clean\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes nothing under dry_run and still says what would change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      writeFileSync(join(root, 'a.md'), `A${ZWSP}B\n`, 'utf8')
      const client = await connect({ root, allowWrite: true })
      const result = await client.callTool({
        name: 'clean_files',
        arguments: { paths: ['a.md'], dry_run: true },
      })
      expect(listAt(structured(result), 'changed')).toHaveLength(1)
      // A dry run of a WRITE tool must say it wrote nothing. It used to borrow
      // the gate's `N files would change at the text bar`, which is a verdict
      // about a tree rather than a report of what this call did to the files it
      // was handed.
      expect(blockText(result, 0)).toContain('dry run')
      expect(blockText(result, 0)).toContain('Nothing was written')
      expect(blockText(result, 0)).toContain('a.md')
      expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe(`A${ZWSP}B\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a file that is not text instead of mangling it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      const bytes = Buffer.from([0x41, 0xff, 0xfe, 0x42])
      writeFileSync(join(root, 'weird.txt'), bytes)
      const client = await connect({ root, allowWrite: true })
      const payload = structured(
        await client.callTool({ name: 'clean_files', arguments: { paths: ['weird.txt'] } }),
      )
      expect(payload['skipped']).toEqual([{ path: 'weird.txt', reason: 'not-utf8' }])
      expect(readFileSync(join(root, 'weird.txt')).equals(bytes)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a path outside the root before it opens anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghostchars-mcp-'))
    try {
      const client = await connect({ root, allowWrite: true })
      const result = await client.callTool({
        name: 'clean_files',
        arguments: { paths: ['../escape.md'] },
      })
      expect(isErrorResult(result)).toBe(true)
      expect(blockText(result, 0)).toContain('resolves outside the root')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
