/**
 * `report`, both renders and both exit paths.
 *
 * HOW THE HUMAN RENDER IS PROVED. Not by a snapshot, which only says the output
 * did not change, but against the Python reference's real stdout with the three
 * documented ASCII substitutions applied to the Python side line by line. That
 * makes the divergence itself the assertion: the head line's middle dot becomes
 * a comma, the sentence-length range's en dash becomes the word `to`, and the
 * multiplication sign in OUR tells line becomes `x`. Anything else that differs
 * is a bug, and the test says which line.
 *
 * THE ONE NON-ASCII CHARACTER THAT MUST SURVIVE. An observation's `detail`
 * comes from `analyzeStyle` and carries the engine's own U+00D7 inside its
 * `word x count` lists. That is engine data, not our format string; it survives
 * the maximum clean untouched, and rewriting it would break `--json` parity. It
 * is written here as an escape, so this file's own bytes stay plain ASCII.
 *
 * Byte parity for `report --json` lives in `parity.style.test.ts`. This suite
 * owns the render, the flags and the exit codes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { golden } from './helpers/golden.js'
import type { StyleFixture } from './helpers/golden.js'
import { STYLE_REPORT, requirePython, runPythonScript } from './helpers/python.js'
import { requireBuild, runCli } from './helpers/run.js'

/**
 * The three characters this suite is about, written as escapes so that the
 * file's own bytes stay plain ASCII and the repository's tier-1 gate has
 * nothing to find. The escape is resolved by the JavaScript parser, so the
 * comparison still runs against the real character.
 */
/** U+00B7 MIDDLE DOT, the separator `style_report.py` uses on two lines. */
const MIDDLE_DOT = ' \u00B7 '
/** U+2013 EN DASH, between the sentence-length minimum and maximum. */
const EN_DASH = '\u2013'
/** U+00D7 MULTIPLICATION SIGN, between a tell and its count. */
const TIMES = '\u00D7'

beforeAll(() => {
  requireBuild()
  requirePython()
})

function fixture(id: string): StyleFixture {
  const found = golden.style.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no style fixture named ${id}`)
  return found
}

/**
 * `style_report.py`'s human block, rewritten into the ASCII we print.
 *
 * Deliberately line-aware rather than a blanket replace: the multiplication
 * sign is ours to change ONLY on the `tells` line. On an observation line it is
 * the engine's data and stays.
 */
function toAsciiRender(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      if (line.startsWith('  sentence length')) return line.replace(EN_DASH, ' to ')
      if (line.startsWith('  tells ')) return line.replaceAll(TIMES, 'x')
      if (line.startsWith('  observations ')) return line.replaceAll(MIDDLE_DOT, ', ')
      if (!line.startsWith(' ')) return line.replaceAll(MIDDLE_DOT, ', ')
      return line
    })
    .join('\n')
}

function pythonRender(input: string, args: readonly string[] = []): string {
  const result = runPythonScript(STYLE_REPORT, args, input)
  return result.stdout.toString('utf8')
}

describe('the ASCII human render', () => {
  it('matches the Python block character for character, with observations', () => {
    const sample = fixture('style-machine')
    const result = runCli(['report'], { input: sample.text })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(toAsciiRender(pythonRender(sample.text)))
  })

  it('matches the Python block character for character, with none', () => {
    const sample = fixture('style-human')
    const result = runCli(['report'], { input: sample.text })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(toAsciiRender(pythonRender(sample.text)))
    expect(result.stdout).toContain(
      'no strong machine-prose habits detected (this is not proof of anything)',
    )
  })

  it('leaves the multiplication sign inside an observation detail alone', () => {
    const sample = fixture('style-machine')
    const result = runCli(['report'], { input: sample.text })
    // Our own tells line uses `x`; the engine's detail keeps its own character.
    expect(result.stdout).toContain(TIMES)
    const tellsLine = result.stdout.split('\n').find((line) => line.startsWith('  tells '))
    expect(tellsLine).toBeDefined()
    expect(tellsLine ?? '').not.toContain(TIMES)
  })

  it('prints none of the three separators the Python render uses', () => {
    const sample = fixture('style-machine')
    const head = runCli(['report'], { input: sample.text }).stdout.split('\n')[0] ?? ''
    expect(head).not.toContain(MIDDLE_DOT)
    expect(head).toContain(', ')
    expect(runCli(['report'], { input: sample.text }).stdout).not.toContain(EN_DASH)
  })

  it('labels text from a pipe, and --stdin-name renames it', () => {
    const plain = runCli(['report'], { input: 'One two three. Four five six.' })
    expect(plain.stdout.startsWith('<stdin>: ')).toBe(true)
    const named = runCli(['report', '--stdin-name', 'draft.md'], {
      input: 'One two three. Four five six.',
    })
    expect(named.stdout.startsWith('draft.md: ')).toBe(true)
  })
})

describe('several files', () => {
  let root = ''
  let first = ''
  let second = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ghostchars-report-'))
    first = join(root, 'a.md')
    second = join(root, 'b.md')
    writeFileSync(first, fixture('style-machine').text, 'utf8')
    writeFileSync(second, fixture('style-human').text, 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('puts a blank line after every block, the last one included', () => {
    const result = runCli(['report', first, second])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(toAsciiRender(pythonRender('', [first, second])))
    expect(result.stdout.endsWith('\n\n')).toBe(true)
  })

  it('puts no blank line after a single block', () => {
    const result = runCli(['report', first])
    expect(result.stdout.endsWith('\n\n')).toBe(false)
    expect(result.stdout).toBe(toAsciiRender(pythonRender('', [first])))
  })

  it('exits 2 for a file it cannot read and drops it from the results', () => {
    const missing = join(root, 'not-here.md')
    const result = runCli(['report', first, missing])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`${missing}: no such file or directory`)
    // The block that COULD be read is still printed, which is the reference
    // implementation's behaviour; this differs from the Python reference only
    // in the exit code.
    expect(result.stdout).toContain(`${first}: `)
    expect(result.stdout).not.toContain(`${missing}: `)
  })
})

describe('--fail-on', () => {
  it('defaults to none, so a fixture full of high observations still exits 0', () => {
    const sample = fixture('style-machine')
    expect(sample.report['summary']).toMatchObject({ high: 4 })
    expect(runCli(['report'], { input: sample.text }).code).toBe(0)
    expect(runCli(['report', '--fail-on', 'none'], { input: sample.text }).code).toBe(0)
  })

  it('exits 1 when an observation reaches the threshold', () => {
    const sample = fixture('style-machine')
    for (const level of ['high', 'medium', 'low']) {
      expect(runCli(['report', '--fail-on', level], { input: sample.text }).code).toBe(1)
    }
  })

  it('exits 0 when nothing reaches the threshold', () => {
    // style-headings carries exactly one LOW observation and nothing above it.
    const sample = fixture('style-headings')
    expect(runCli(['report', '--fail-on', 'low'], { input: sample.text }).code).toBe(1)
    expect(runCli(['report', '--fail-on', 'medium'], { input: sample.text }).code).toBe(0)
    expect(runCli(['report', '--fail-on', 'high'], { input: sample.text }).code).toBe(0)
  })

  it('exits 0 for a text with no observations at all', () => {
    const sample = fixture('style-human')
    expect(runCli(['report', '--fail-on', 'low'], { input: sample.text }).code).toBe(0)
  })

  it('lets a read failure beat a threshold hit, because 2 beats 1', () => {
    const result = runCli(['report', '--fail-on', 'low', 'no-such-file.md'], { input: '' })
    expect(result.code).toBe(2)
  })

  it('refuses a severity that is not one of the four', () => {
    const result = runCli(['report', '--fail-on', 'critical'], { input: 'One two. Three four.' })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--fail-on must be one of none, low, medium, high')
  })
})
