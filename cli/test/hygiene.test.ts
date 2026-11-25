/**
 * The package held to its own bar, by its own engine, in process.
 *
 * WHY THIS DUPLICATES THE REPOSITORY GATE. The repository's own gate already
 * checks these files; this asserts the same property with the TypeScript
 * engine so the package is self-policing for anyone who forks it. And
 * `pnpm test` inside this package should catch a stray em dash in a second,
 * rather than at the end of a multi-minute repository run.
 *
 * WHAT COUNTS AS OUR OWN BAR. `{ spaces: true, punct: true }`, which is exactly
 * `strip_invisible.py -s --punct` and exactly what `--bar text` resolves to. Not
 * `--max`: that folds look-alike letters and applies NFKC, which is a different
 * question and not one anybody holds prose to.
 *
 * ESCAPES ARE RESOLVED FIRST, for the Markdown as well as for the strings
 * module. An em dash written as a backslash-u escape is ASCII in the file and an
 * em dash on the reader's screen, so cleaning the raw bytes cannot see it. A
 * specimen written as an escape is invisible to a gate that reads bytes, so it
 * can sit in shipped copy indefinitely, and the shipped documentation of the
 * tool that exists to find such things must not reopen that hole.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanText } from '@ghostchars/engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as strings from '../src/strings.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INTEGRATIONS = join(ROOT, 'integrations')
const DIST = join(ROOT, 'dist')

/** The bar this package holds its own words to, spelled once. */
const TEXT_BAR = { spaces: true, punct: true }

/**
 * The repository gate's escape regex, ported exactly, odd-backslash rule and
 * all: a doubled backslash before `u2014` is a literal backslash followed by the
 * letters, renders no dash at all, and must not be decoded into one.
 */
const ESCAPE = /(\\+)u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))/g

function decodeEscapes(text: string): string {
  return text.replace(
    ESCAPE,
    (whole: string, slashes: string, braced?: string, plain?: string): string => {
      if (slashes.length % 2 === 0) return whole
      const digits = braced ?? plain
      if (digits === undefined) return whole
      const cp = Number.parseInt(digits, 16)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole
      const character = String.fromCodePoint(cp)
      if (character === '\n' || character === '\r') return whole
      return slashes.slice(0, -1) + character
    },
  )
}

function walk(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found.sort()
}

const INTEGRATION_FILES = walk(INTEGRATIONS)

const PROSE_FILES = [
  join(ROOT, 'README.md'),
  join(ROOT, 'LICENSE'),
  join(ROOT, 'src', 'strings.ts'),
  ...INTEGRATION_FILES.filter((path) => path.endsWith('.md') || path.endsWith('.mdc')),
]

function relative(path: string): string {
  return path.slice(ROOT.length)
}

/**
 * The offending characters, named, so a failure says what to fix rather than
 * only that something is wrong. The two texts always have the same length in
 * lines here (neither `-s` nor `--punct` moves a line break), so a per-line
 * report is exact.
 */
function offenders(before: string): string[] {
  const after = cleanText(before, TEXT_BAR)
  if (after === before) return []
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const out: string[] = []
  for (let i = 0; i < beforeLines.length; i += 1) {
    const b = beforeLines[i] ?? ''
    if (b === afterLines[i]) continue
    for (const character of b) {
      if (cleanText(character, TEXT_BAR) !== character) {
        // The same `U+XXXX` spelling `strings.codepointLabel` uses: uppercase
        // hex, at least four digits, so a failure here is greppable against the
        // rest of the package's output.
        const hex = (character.codePointAt(0) ?? 0).toString(16).toUpperCase()
        out.push(`line ${i + 1}: U+${hex.padStart(4, '0')}`)
      }
    }
  }
  return out.length === 0 ? ['the text bar changes this file, position unattributed'] : out
}

describe('the package passes its own cleaner at the text bar', () => {
  it.each(PROSE_FILES.map((path) => [relative(path), path]))(
    '%s is unchanged by cleanText at the text bar',
    (_label, path) => {
      const source = decodeEscapes(readFileSync(path, 'utf8'))
      expect(offenders(source)).toEqual([])
    },
  )

  it('holds every shipped Markdown file, not just a hand-listed few', () => {
    const markdown = INTEGRATION_FILES.filter(
      (path) => path.endsWith('.md') || path.endsWith('.mdc'),
    )
    expect(markdown.length).toBeGreaterThanOrEqual(10)
    for (const path of markdown) expect(PROSE_FILES).toContain(path)
  })

  /**
   * The check that the checks above are not vacuous. Every specimen here is
   * written as an escape, which is what a specimen in this repository is written
   * as: the repository gate reads these bytes directly and leaves an escape
   * alone, and no shipped copy is involved either way.
   */
  it('would notice a dash, a curly quote and a no-break space', () => {
    expect(offenders('a\u2014b')).toEqual(['line 1: U+2014'])
    expect(offenders('one\ntwo \u201Cthree\u201D')).toEqual([
      'line 2: U+201C',
      'line 2: U+201D',
    ])
    expect(offenders('a\u00A0b')).toEqual(['line 1: U+00A0'])
    expect(offenders('plain ascii, nothing to do')).toEqual([])
  })

  /**
   * And that decoding is wired in, not merely defined: an escape written into a
   * file renders the character, so the gate has to ask what ships rather than
   * how it was typed. The doubled backslash is a literal backslash and stays.
   */
  it('resolves an escape before cleaning, and leaves a doubled one alone', () => {
    expect(offenders(decodeEscapes('a\\u2014b'))).toEqual(['line 1: U+2014'])
    expect(offenders(decodeEscapes('a\\\\u2014b'))).toEqual([])
  })
})

describe('src/strings.ts writes no escape at all', () => {
  /**
   * The escape loophole, closed in advance. A specimen character belongs in a
   * test fixture, which is generated into a temp directory at test time. It has
   * no business in shipped copy, and a module with no escapes in it cannot hide
   * one from the cleaner above.
   */
  it('contains no backslash-u escape', () => {
    const source = readFileSync(join(ROOT, 'src', 'strings.ts'), 'utf8')
    expect(source.match(ESCAPE)).toBeNull()
  })

  it('is pure ASCII, so no specimen can hide as a literal either', () => {
    const bytes = readFileSync(join(ROOT, 'src', 'strings.ts'))
    const high = [...bytes].findIndex((byte) => byte > 0x7f)
    expect(high, `byte above 0x7F at offset ${high}`).toBe(-1)
  })
})

describe('the shipped bundles hold no byte above 0x7F', () => {
  /**
   * The tool that finds hidden characters ships none. esbuild's default
   * `charset: 'ascii'` escapes every non-ASCII string literal, so this is a
   * property the build already has; the point is that it stays one. `dist/mcp.js`
   * is exempt and unchecked, because third-party code is not ours to police.
   */
  it.each(['cli.js', 'main.js', 'doc.js', 'index.js', 'types/index.d.ts', 'types/tables.d.ts'])(
    'dist/%s is ASCII',
    (name) => {
      const bytes = readFileSync(join(DIST, name))
      let offset = -1
      for (let i = 0; i < bytes.length; i += 1) {
        if ((bytes[i] ?? 0) > 0x7f) {
          offset = i
          break
        }
      }
      expect(offset, `dist/${name} holds a byte above 0x7F at offset ${offset}`).toBe(-1)
    },
  )
})

/**
 * The six fields of the Agent Skills specification. Anything else is a hard
 * error in at least one host that reads this file, and the whole point of
 * shipping one physical SKILL.md is that all five tools accept it unchanged.
 */
const SKILL_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('the skill loads unchanged in every host that reads SKILL.md', () => {
  const skillPath = join(INTEGRATIONS, 'skills', 'ghostchars', 'SKILL.md')
  const source = readFileSync(skillPath, 'utf8')

  /**
   * A three-line frontmatter reader rather than a YAML dependency: the file is
   * required to carry only two scalar keys, so anything this cannot parse is
   * already a failure of the rule being tested.
   */
  function frontmatter(): Map<string, string> {
    expect(source.startsWith('---\n')).toBe(true)
    const end = source.indexOf('\n---\n', 3)
    expect(end).toBeGreaterThan(0)
    const fields = new Map<string, string>()
    for (const line of source.slice(4, end).split('\n')) {
      const colon = line.indexOf(':')
      expect(colon, `not a key: ${line}`).toBeGreaterThan(0)
      fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
    return fields
  }

  it('carries only fields the open specification defines', () => {
    for (const key of frontmatter().keys()) expect(SKILL_FIELDS).toContain(key)
  })

  it('names itself after its own directory, in the spelling the spec allows', () => {
    const name = frontmatter().get('name')
    expect(name).toBe(basename(dirname(skillPath)))
    expect(name).toMatch(SKILL_NAME)
    expect((name ?? '').length).toBeLessThanOrEqual(64)
  })

  it('has a description within the 1024-character cap', () => {
    const description = frontmatter().get('description') ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  it('keeps the body inside the progressive-disclosure budget', () => {
    expect(source.split('\n').length).toBeLessThan(500)
  })

  it('ships the two reference files the body points at', () => {
    for (const name of ['install.md', 'flags.md']) {
      expect(INTEGRATION_FILES).toContain(
        join(INTEGRATIONS, 'skills', 'ghostchars', 'references', name),
      )
      expect(source).toContain(`references/${name}`)
    }
  })
})

const SERVER_ENTRY = z.object({
  command: z.string(),
  args: z.array(z.string()),
})

const JSON_SNIPPETS: [string, string][] = [
  ['claude-code.mcp.json', 'mcpServers'],
  ['cursor.mcp.json', 'mcpServers'],
  ['windsurf.mcp_config.json', 'mcpServers'],
  ['gemini.settings.json', 'mcpServers'],
  ['vscode.mcp.json', 'servers'],
]

describe('every MCP snippet starts the same server', () => {
  it.each(JSON_SNIPPETS)('%s parses and uses the %s key', (name, key) => {
    const raw: unknown = JSON.parse(readFileSync(join(INTEGRATIONS, 'mcp', name), 'utf8'))
    const parsed = z
      .record(z.string(), z.object({ ghostchars: SERVER_ENTRY }))
      .parse(raw)
    const entry = parsed[key]?.ghostchars
    expect(entry?.command).toBe('npx')
    expect(entry?.args).toEqual(['-y', 'ghostchars', 'mcp'])
  })

  it('uses servers for VS Code and mcpServers for the other four', () => {
    for (const [name, key] of JSON_SNIPPETS) {
      const text = readFileSync(join(INTEGRATIONS, 'mcp', name), 'utf8')
      const other = key === 'servers' ? 'mcpServers' : 'servers'
      expect(text).toContain(`"${key}"`)
      if (key === 'servers') expect(text).not.toContain(`"${other}"`)
    }
    expect(JSON_SNIPPETS.filter(([, key]) => key === 'servers')).toHaveLength(1)
    expect(JSON_SNIPPETS.filter(([, key]) => key === 'mcpServers')).toHaveLength(4)
  })

  it('gives Codex the TOML table it reads, with the same command', () => {
    const toml = readFileSync(join(INTEGRATIONS, 'mcp', 'codex.config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.ghostchars]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain('args = ["-y", "ghostchars", "mcp"]')
  })

  it('ships one snippet per host, three proxy examples, and nothing else under mcp/', () => {
    const names = readdirSync(join(INTEGRATIONS, 'mcp')).sort()
    expect(names).toEqual([
      'claude-code.mcp.json',
      'claude-code.proxy.mcp.json',
      'codex.config.toml',
      'codex.proxy.config.toml',
      'cursor.mcp.json',
      'cursor.proxy.mcp.json',
      'gemini.settings.json',
      'vscode.mcp.json',
      'windsurf.mcp_config.json',
    ])
  })
})

/** What every proxy example wraps: a server named after itself, behind `--`. */
const PROXY_ARGS = [
  '-y',
  'ghostchars',
  'mcp-proxy',
  '--',
  'npx',
  '-y',
  '@modelcontextprotocol/server-filesystem',
  '.',
]

describe('every proxy example wraps a server the same way', () => {
  it.each(['claude-code.proxy.mcp.json', 'cursor.proxy.mcp.json'])(
    '%s parses and puts the wrapped server after --',
    (name) => {
      const raw: unknown = JSON.parse(readFileSync(join(INTEGRATIONS, 'mcp', name), 'utf8'))
      const parsed = z.object({ mcpServers: z.object({ filesystem: SERVER_ENTRY }) }).parse(raw)
      expect(parsed.mcpServers.filesystem.command).toBe('npx')
      expect(parsed.mcpServers.filesystem.args).toEqual(PROXY_ARGS)
    },
  )

  it('gives Codex the same command in its TOML table', () => {
    const toml = readFileSync(join(INTEGRATIONS, 'mcp', 'codex.proxy.config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.filesystem]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain(`args = [${PROXY_ARGS.map((arg) => `"${arg}"`).join(', ')}]`)
  })
})

/**
 * The framing lock, as regular expressions.
 *
 * This product is text hygiene: it says what it found and what it removed. The
 * patterns below are written to catch a CLAIM and not a DISCLAIMER, which is why
 * they need a verb next to the noun. "This is not a detector" has to keep
 * passing; "beats AI detection" must never start.
 */
const FORBIDDEN_CLAIMS: readonly (readonly [string, RegExp])[] = [
  ['defeating detection', /\b(defeat|evade|beat|bypass|fool|trick)s?\b[^.]{0,40}\b(detect|detector|detection)/i],
  ['undetectable', /\bundetectable\b/i],
  ['a guarantee', /\bguarantee/i],
  ['a percentage', /\d\s*%/],
  ['a probability or score', /\b(probability|confidence score|likelihood) (?:of|that|is)\b/i],
  ['proof of authorship', /\bprove[sd]?\b[^.]{0,30}\b(human|wrote|written by)\b/i],
]

/** Capabilities this package does not have, and must not imply that it has. */
const FORBIDDEN_CAPABILITIES: readonly (readonly [string, RegExp])[] = [
  ['PDF support', /\bpdf\b/i],
  ['an upload', /\bupload/i],
  ['a cloud service', /\bcloud\b/i],
  ['an account or a key', /\b(sign in|sign up|api key|licence key|license key|subscription)\b/i],
  ['EXIF or C2PA', /\b(exif|xmp|c2pa)\b/i],
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Every sentence reachable from a static export, found by walking rather than
 * by hand, so a string added to this module tomorrow is checked without anybody
 * remembering to list it here.
 */
function exportedStrings(): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item)
    }
  }
  visit({ ...strings })
  return out
}

/**
 * The sentences that only exist once a count is known. They are formatting
 * wrappers over the vocabulary above, but they are still sentences a person
 * reads, so the check has to see them assembled rather than as fragments.
 */
function assembledStrings(): string[] {
  return [
    strings.errUnknownCommand('nope', ['clean', 'inspect']),
    strings.errUnknownFlag('clean', '--punc', '--punct'),
    strings.errBadBar('nope'),
    strings.errBadGateBar('max'),
    strings.errNotUtf8('logo.png'),
    strings.internalError('a thing went wrong'),
    strings.inspectClean('draft.md'),
    strings.inspectFound('draft.md', 3),
    strings.inspectTruncated(7),
    strings.countLine('draft.md', -3),
    strings.checkFailureHead('docs/post.md', 'text'),
    strings.checkPinMismatch('docs/glyphs.md', 3, 2),
    strings.checkPinStale('docs/glyphs.md', 2),
    strings.checkUnattributed('docs/post.md'),
    strings.checkFailSummary(1, 3, 0, ''),
    strings.checkPassSummary(3, 'text', 0),
    strings.checkFixed(1),
    strings.mcpReady('ghostchars', 4),
    strings.mcpNoChanges('text'),
    strings.mcpChanged('text', 3, -2),
    strings.mcpCheckPassed(3, 'text'),
    strings.mcpCheckFailed(1, 'text'),
    strings.mcpFilesCleaned(2, 'text', 4),
    strings.mcpFilesWouldChange(2, 'text'),
  ]
}

describe('the framing lock over the whole user-facing vocabulary', () => {
  const vocabulary = [...exportedStrings(), ...assembledStrings()]

  it('reaches the strings that matter, so a pass is not a vacuous one', () => {
    expect(vocabulary.length).toBeGreaterThan(100)
    expect(vocabulary).toContain(strings.BAR_DESCRIPTION)
    expect(vocabulary).toContain(strings.MCP_INSTRUCTIONS)
    expect(vocabulary).toContain(strings.TOOL_DESCRIPTIONS.style_report)
  })

  it.each(FORBIDDEN_CLAIMS)('claims nothing about %s', (_label, pattern) => {
    const offending = vocabulary.filter((text) => pattern.test(text))
    expect(offending).toEqual([])
  })

  it.each(FORBIDDEN_CAPABILITIES)('promises nothing about %s', (_label, pattern) => {
    const offending = vocabulary.filter((text) => pattern.test(text))
    expect(offending).toEqual([])
  })

  it('says in plain words that the style report is not a detector', () => {
    expect(strings.TOOL_DESCRIPTIONS.style_report).toContain('not a detector')
    expect(strings.REPORT_NO_OBSERVATIONS).toContain('not proof of anything')
  })

  it('tells an agent never to run max over text it did not write', () => {
    expect(strings.BAR_DESCRIPTION).toContain('Do not use "max" on text you did not')
    expect(strings.GATE_BAR_DESCRIPTION).toContain('There is no "max" gate bar')
  })
})
