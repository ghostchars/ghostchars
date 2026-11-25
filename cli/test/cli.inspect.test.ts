/**
 * `inspect`: the one output in this package whose bytes are a contract.
 *
 * THE CLAIM AND ITS EXACT LIMIT. `ghostchars inspect` reproduces
 * `strip_invisible.py --show` byte for byte, including the two leading spaces,
 * the two tabs, the kind column padded to 15, the note column padded to 20 and
 * the uppercase four-digit `U+XXXX`. MEASURED over the whole fixture corpus
 * in one pass: 14 lines of output differ, all of them in the NAME column
 * alone, and only for codepoints where Python's `unicodedata.name()`
 * raises and the script prints its `<unnamed>` fallback. This engine ships the
 * NameAliases label for a C0 or C1 control (BELL, NEXT LINE) and the `U+XXXX`
 * form for a private-use or noncharacter codepoint.
 *
 * So the suite does not hand-pick a flattering subset. It asks Python which
 * codepoints it has no name for, splits the corpus on that answer, claims byte
 * identity for everything else, and pins the remainder to "identical up to and
 * including the note column, different only in the name". A regression in the
 * padding, the tabs, the ordering or the positions fails the first test; a
 * change in the engine's name table fails the second.
 *
 * SPECIMENS ARE WRITTEN AS ESCAPES. Every hidden character below is a
 * `\uXXXX` escape resolved by the JavaScript parser, so this source file itself
 * stays plain ASCII and the repository's own hygiene gate has nothing to find
 * in it. That is the rule the gate fixtures follow too.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatCodepoint } from '@ghostchars/engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

// The package's own `nameOf`, not the engine's: the name column is this
// package's contract and `src/names.ts` is where it is answered.
import { nameOf } from '../src/names.js'

import { golden } from './helpers/golden.js'
import {
  REPO_ROOT,
  STRIP_INVISIBLE,
  pythonSkipped,
  requirePython,
  runPythonCode,
  runPythonScript,
} from './helpers/python.js'
import { requireBuild, runCli } from './helpers/run.js'

/** The width of a finding row up to and including the note column. */
const ROW_PREFIX_WIDTH = 15 + 1 + 20 + 1

const ZWSP = '\u200B'
const NBSP = '\u00A0'
const EM_DASH = '\u2014'

let root = ''
/** Absolute paths, so the label Python prints and the label we print are equal. */
const paths: string[] = []
/** Fixture indices whose every finding codepoint has a name in Python. */
const named: number[] = []
const unnamed: number[] = []

function fixturePath(index: number): string {
  return join(root, `f${String(index).padStart(3, '0')}.txt`)
}

/** Which of the corpus codepoints Python cannot name. One spawn, one answer. */
function codepointsWithoutPythonNames(): Set<number> {
  const codepoints = new Set<number>()
  for (const fixture of golden.text) for (const [, , cp] of fixture.findings) codepoints.add(cp)
  const answer = runPythonCode(
    'import json,sys,unicodedata\n' +
      'out = []\n' +
      'for cp in json.load(sys.stdin):\n' +
      '    try:\n' +
      '        unicodedata.name(chr(cp))\n' +
      '    except ValueError:\n' +
      '        out.append(cp)\n' +
      'print(json.dumps(out))\n',
    JSON.stringify([...codepoints]),
  )
  if (answer.code !== 0) throw new Error(`python could not answer: ${answer.stderr}`)
  return new Set<number>(z.array(z.number()).parse(JSON.parse(answer.stdout.toString('utf8'))))
}

beforeAll(() => {
  requireBuild()
  requirePython()
  root = mkdtempSync(join(tmpdir(), 'ghostchars-show-'))
  golden.text.forEach((fixture, index) => {
    const path = fixturePath(index)
    writeFileSync(path, fixture.text, 'utf8')
    paths.push(path)
  })
  if (pythonSkipped()) return
  const without = codepointsWithoutPythonNames()
  golden.text.forEach((fixture, index) => {
    if (fixture.findings.some(([, , cp]) => without.has(cp))) unnamed.push(index)
    else named.push(index)
  })
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('inspect reproduces strip_invisible.py --show', () => {
  it.skipIf(pythonSkipped())(
    'is byte-identical for every fixture whose codepoints Python can name',
    () => {
      const selected = named.map(fixturePath)
      expect(selected.length).toBeGreaterThan(100)
      const python = runPythonScript(STRIP_INVISIBLE, ['--show', ...selected])
      const ours = runCli(['inspect', ...selected])
      expect(ours.code).toBe(python.code)
      expect(ours.stdoutBytes.equals(python.stdout)).toBe(true)
    },
  )

  it.skipIf(pythonSkipped())(
    'differs from Python only in the name column, and only where Python has no name',
    () => {
      const selected = unnamed.map(fixturePath)
      expect(selected.length).toBeGreaterThan(0)
      const python = runPythonScript(STRIP_INVISIBLE, ['--show', ...selected])
      const ours = runCli(['inspect', ...selected])
      const theirLines = python.stdout.toString('utf8').split('\n')
      const ourLines = ours.stdout.split('\n')
      expect(ourLines.length).toBe(theirLines.length)

      let differences = 0
      theirLines.forEach((theirs, index) => {
        const mine = ourLines[index] ?? ''
        if (mine === theirs) return
        differences += 1
        const theirParts = theirs.split('\t')
        const myParts = mine.split('\t')
        // Same position, same codepoint, same kind column, same note column.
        expect(myParts.slice(0, 2)).toEqual(theirParts.slice(0, 2))
        const theirRest = theirParts[2] ?? ''
        const myRest = myParts[2] ?? ''
        expect(myRest.slice(0, ROW_PREFIX_WIDTH)).toBe(theirRest.slice(0, ROW_PREFIX_WIDTH))
        expect(theirRest.slice(ROW_PREFIX_WIDTH)).toBe('<unnamed>')
        expect(myRest.slice(ROW_PREFIX_WIDTH)).not.toBe('')
      })
      expect(differences).toBeGreaterThan(0)
    },
  )

  it.skipIf(pythonSkipped())(
    'gives every look-alike letter the name Python gives it, none missing, none wrong',
    () => {
      /**
       * THE NAME COLUMN FOR A LOOK-ALIKE LETTER, PINNED IN BOTH DIRECTIONS.
       *
       * The engine's `nameOf()` reads a table generated for what the engine
       * CLASSIFIES: the `strip_invisible.py` tables, every Cf and Co codepoint,
       * every finding codepoint in the golden fixtures. The look-alike table is
       * not in that set, so 1500 of its 1508 nameable source codepoints had no
       * name there and this column printed `U+0440` where the reference prints
       * CYRILLIC SMALL LETTER ER.
       *
       * `src/names.ts` closes that hole with a Node-only table generated from
       * the same `unicodedata` the reference calls
       * (`scripts/gen_confusable_names.py`), read only where the engine has no
       * name of its own. The shared engine and the web bundle are untouched;
       * see `test/parity.names.test.ts` for the cost and the table's own
       * invariants.
       *
       * So the assertion is exact and has no carve-out: a look-alike source
       * codepoint Python can name is named here, identically. A missing name
       * means the table needs regenerating. A different name is a defect with
       * no excuse.
       */
      const answer = runPythonCode(
        'import json,sys,unicodedata\n' +
          'sys.path.insert(0, ' +
          JSON.stringify(REPO_ROOT) +
          ')\n' +
          'import confusables\n' +
          'out = {}\n' +
          'for cp in sorted(confusables.CONFUSABLES):\n' +
          '    name = unicodedata.name(chr(cp), "")\n' +
          '    if name:\n' +
          '        out[str(cp)] = name\n' +
          'print(json.dumps(out))\n',
      )
      if (answer.code !== 0) throw new Error(`python could not answer: ${answer.stderr}`)
      const pythonNames = z
        .record(z.string(), z.string())
        .parse(JSON.parse(answer.stdout.toString('utf8')))

      const missing: string[] = []
      const disagreeing: string[] = []
      let agreeing = 0
      for (const [key, pythonName] of Object.entries(pythonNames)) {
        const cp = Number(key)
        const ours = nameOf(cp)
        if (ours === formatCodepoint(cp)) missing.push(formatCodepoint(cp))
        else if (ours === pythonName) agreeing += 1
        else disagreeing.push(`${formatCodepoint(cp)}: ${ours} vs ${pythonName}`)
      }

      expect(disagreeing).toEqual([])
      expect(missing).toEqual([])
      expect(Object.keys(pythonNames).length).toBe(1508)
      expect(agreeing).toBe(1508)
    },
  )

  it.skipIf(pythonSkipped())(
    'is byte-identical for the look-alike repro, name column included',
    () => {
      // The reviewer's own repro: U+0440 CYRILLIC SMALL LETTER ER followed by
      // ASCII, which is a mixed-script word and therefore a finding.
      const path = join(root, 'confusable.txt')
      writeFileSync(path, '\u0440ractice\n', 'utf8')
      const python = runPythonScript(STRIP_INVISIBLE, ['--show', path])
      const ours = runCli(['inspect', path])
      expect(ours.code).toBe(python.code)
      expect(ours.stdoutBytes.equals(python.stdout)).toBe(true)

      // Stated a second time as the literal row, because "both are equal" would
      // also pass if both printed the placeholder. `(needs --confusables)` is 21
      // characters and legitimately overflows the 20-wide note column, pushing
      // the name one space right in BOTH outputs.
      const row = ours.stdout.split('\n')[1] ?? ''
      expect(row.split('\t')[2] ?? '').toBe(
        `${'confusable'.padEnd(15)} (needs --confusables) CYRILLIC SMALL LETTER ER`,
      )
    },
  )

  it('carries the look-alike name into --json as well as the row', () => {
    const path = join(root, 'confusable-json.txt')
    writeFileSync(path, '\u0440ractice\n', 'utf8')
    const ours = runCli(['inspect', '--json', path])
    expect(ours.code).toBe(1)
    // `PAYLOAD` is declared further down the file; it is read when this test
    // runs, which is after the module has finished evaluating.
    const payload = PAYLOAD.parse(JSON.parse(ours.stdout))
    expect(payload.results[0]?.findings?.[0]?.u).toBe('U+0440')
    expect(payload.results[0]?.findings?.[0]?.name).toBe('CYRILLIC SMALL LETTER ER')
  })

  it.skipIf(pythonSkipped())(
    'keeps the column widths and the glue note the format depends on',
    () => {
      const ours = runCli(['inspect', ...named.map(fixturePath)])
      // A glue finding is the case a naive port gets wrong by dropping the note.
      expect(ours.stdout).toContain('(needs -a)')
      const rows = ours.stdout
        .split('\n')
        .filter((line) => line.startsWith('  ') && line.includes('\tU+'))
      expect(rows.length).toBeGreaterThan(50)
      for (const row of rows) {
        const [position, codepoint, rest] = row.split('\t')
        expect(position).toMatch(/^ {2}\d+:\d+$/)
        expect(codepoint).toMatch(/^U\+[0-9A-F]{4,}$/)
        // Take the row apart and put it back together with the documented
        // padding. A column that lost its width, or a note that lost its
        // parentheses, cannot survive the round trip. `(needs --confusables)`
        // is 21 characters and legitimately overflows the 20-wide column, which
        // is why the widths are reapplied rather than asserted as fixed offsets.
        const parts = /^(\S+) +(\(needs \S+\))? *(\S.*)$/.exec(rest ?? '')
        expect(parts, row).not.toBeNull()
        const kind = parts?.[1] ?? ''
        const note = parts?.[2] ?? ''
        const name = parts?.[3] ?? ''
        expect(`${kind.padEnd(15)} ${note.padEnd(20)} ${name}`).toBe(rest)
      }
    },
  )
})

describe('inspect behaviour', () => {
  it('prints one line and exits 0 for a clean input', () => {
    const result = runCli(['inspect'], { input: 'plain ASCII text, nothing to find\n' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('<stdin>: clean\n')
    expect(result.stderr).toBe('')
  })

  it('labels stdin with --stdin-name', () => {
    const result = runCli(['inspect', '--stdin-name', 'draft.md'], { input: 'clean text\n' })
    expect(result.stdout).toBe('draft.md: clean\n')
  })

  it('exits 1 and prints the row in the documented format', () => {
    const result = runCli(['inspect'], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(1)
    const row = `  1:2\tU+200B\t${'invisible'.padEnd(15)} ${''.padEnd(20)} ZERO WIDTH SPACE`
    expect(result.stdout).toBe(`<stdin>: 1 found\n${row}\n`)
  })

  /**
   * The most likely porting bug in the package, pinned.
   *
   * `find()` is flag-independent in Python and `scan()` is flag-independent
   * here, and the note column always names the flag that WOULD be needed. So
   * every one of the thirteen switches, and `--max`, leaves this output alone.
   */
  it('prints the same block whatever flags are given', () => {
    const input = `a${ZWSP}b ${EM_DASH} c${NBSP}de\n`
    const base = runCli(['inspect'], { input })
    expect(base.code).toBe(1)
    const combinations = [
      ['--punct'],
      ['--spaces'],
      ['--max'],
      ['--bar', 'text'],
      ['--bar', 'max'],
      ['-a', '-s', '-n', '--bidi', '--controls', '--pua'],
      ['--confusables', '--nfc', '--nfkc', '--gutters', '--trailing', '--collapse'],
    ]
    for (const argv of combinations) {
      const result = runCli(['inspect', ...argv], { input })
      expect(result.stdout, argv.join(' ')).toBe(base.stdout)
      expect(result.code, argv.join(' ')).toBe(base.code)
    }
  })

  it('truncates at --limit and says how many it left out', () => {
    const input = `${`a${ZWSP}b `.repeat(10)}\n`
    const full = runCli(['inspect'], { input })
    expect(full.stdout).toContain(': 10 found')
    const capped = runCli(['inspect', '--limit', '3'], { input })
    expect(capped.stdout.split('\n').filter((line) => line.includes('\tU+')).length).toBe(3)
    expect(capped.stdout).toContain('  ... 7 more (use --limit)')
    expect(capped.code).toBe(1)
  })

  it('reports an unreadable file and exits 2', () => {
    const result = runCli(['inspect', join(root, 'not-here.txt')])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('no such file or directory')
  })

  it('lets a decode failure beat a finding when both happen', () => {
    const dirty = join(root, 'dirty.txt')
    const binary = join(root, 'binary.bin')
    writeFileSync(dirty, `a${ZWSP}b\n`, 'utf8')
    writeFileSync(binary, Buffer.from([0x61, 0xff, 0xfe, 0x62]))
    const result = runCli(['inspect', dirty, binary])
    expect(result.code).toBe(2)
    expect(result.stdout).toContain('1 found')
    expect(result.stderr).toContain('not valid UTF-8, skipped')
  })
})

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

const FINDING = z.object({
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  index: z.number().int().nonnegative(),
  cp: z.number().int().nonnegative(),
  u: z.string().regex(/^U\+[0-9A-F]{4,}$/),
  name: z.string().min(1),
  kind: z.string().min(1),
  flag: z.string().min(1),
  action: z.enum(['removed', 'replaced', 'kept-load-bearing', 'found-not-targeted']),
  replacement: z.string().optional(),
})

const PAYLOAD = z.object({
  tool: z.literal('ghostchars'),
  version: z.string(),
  command: z.literal('inspect'),
  ok: z.boolean(),
  exitCode: z.number().int(),
  bar: z.string(),
  options: z.array(z.string()),
  summary: z.object({
    removed: z.number().int(),
    replaced: z.number().int(),
    keptLoadBearing: z.number().int(),
    foundNotTargeted: z.number().int(),
    filesClean: z.number().int(),
    filesDirty: z.number().int(),
  }),
  results: z.array(
    z.object({
      path: z.string(),
      ok: z.boolean(),
      clean: z.boolean().optional(),
      total: z.number().int().optional(),
      byKind: z
        .array(
          z.object({
            kind: z.string(),
            flag: z.string(),
            count: z.number().int(),
            action: z.string(),
          }),
        )
        .optional(),
      findings: z.array(FINDING).optional(),
      findingsTotal: z.number().int().optional(),
      findingsTruncated: z.boolean().optional(),
    }),
  ),
})

describe('inspect and quote bars', () => {
  /** U+258E LEFT ONE QUARTER BLOCK and U+2502 BOX DRAWINGS LIGHT VERTICAL. */
  const BAR = '\u258E'
  const LIGHT = '\u2502'

  it('reports a gutter as needing --gutters, and a table rule not at all', () => {
    const result = runCli(['inspect'], { input: `${BAR} quoted\n${LIGHT} a ${LIGHT} b ${LIGHT}\n` })
    expect(result.code).toBe(1)
    const row = `  1:1\tU+258E\t${'gutter'.padEnd(15)} ${'(needs --gutters)'.padEnd(20)} LEFT ONE QUARTER BLOCK`
    expect(result.stdout).toBe(`<stdin>: 1 found\n${row}\n`)
  })

  it('calls the bar removed in --json once --gutters or --max is on', () => {
    const input = `${BAR} quoted\n`
    const actionUnder = (args: readonly string[]): string | undefined =>
      PAYLOAD.parse(JSON.parse(runCli(['inspect', '--json', ...args], { input }).stdout)).results[0]
        ?.findings?.[0]?.action
    expect(actionUnder([])).toBe('found-not-targeted')
    expect(actionUnder(['--bar', 'text'])).toBe('found-not-targeted')
    expect(actionUnder(['--gutters'])).toBe('removed')
    expect(actionUnder(['--max'])).toBe('removed')
  })
})

describe('inspect --json', () => {
  it('validates, carries cp and u, and repeats the exit code in the payload', () => {
    const result = runCli(['inspect', '--json', '--bar', 'text'], {
      input: `a${ZWSP}b ${EM_DASH} c\n`,
    })
    expect(result.code).toBe(1)
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.ok).toBe(false)
    expect(payload.exitCode).toBe(1)
    expect(payload.bar).toBe('text')
    expect(payload.options).toEqual(['punct', 'spaces'])
    const entry = payload.results[0]
    expect(entry?.total).toBe(2)
    expect(entry?.findings?.map((finding) => finding.u)).toEqual(['U+200B', 'U+2014'])
    expect(entry?.findings?.map((finding) => finding.cp)).toEqual([0x200b, 0x2014])
    expect(entry?.byKind?.map((group) => group.kind)).toEqual(['invisible', 'punct'])
    expect(payload.summary.filesDirty).toBe(1)
  })

  /**
   * A deletion has NO `replacement` key, rather than an empty one. "Does this
   * have a replacement" is the question a findings table actually asks, and the
   * engine's `exactOptionalPropertyTypes` contract says the same thing.
   */
  it('omits replacement for a deletion and sets it for a substitution', () => {
    const result = runCli(['inspect', '--json', '--bar', 'text'], {
      input: `a${ZWSP}b${NBSP}c\n`,
    })
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    const findings = payload.results[0]?.findings ?? []
    expect(result.stdout).toContain('"replacement": " "')
    const deletion = findings.find((finding) => finding.cp === 0x200b)
    const substitution = findings.find((finding) => finding.cp === 0x00a0)
    expect(deletion?.action).toBe('removed')
    expect(deletion?.replacement).toBeUndefined()
    expect(substitution?.action).toBe('replaced')
    expect(substitution?.replacement).toBe(' ')
  })

  it('reports the cap as data instead of as a line of prose', () => {
    const input = `${`a${ZWSP}b `.repeat(10)}\n`
    const result = runCli(['inspect', '--json', '--limit', '4'], { input })
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    const entry = payload.results[0]
    expect(entry?.findings?.length).toBe(4)
    expect(entry?.findingsTotal).toBe(10)
    expect(entry?.findingsTruncated).toBe(true)
    expect(result.stdout).not.toContain('use --limit')
  })

  it('records a decode failure as a result rather than dropping the file', () => {
    const bad = join(root, 'binary-json.bin')
    writeFileSync(bad, Buffer.from([0x61, 0xff, 0xfe, 0x62]))
    const result = runCli(['inspect', '--json', bad])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('not valid UTF-8, skipped')
    expect(result.stdout).toContain('"kind": "not-utf8"')
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.results[0]?.ok).toBe(false)
  })
})
