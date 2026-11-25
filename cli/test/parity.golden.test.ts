/**
 * The golden replay: every text fixture across 14 option combos, driven
 * through the BUILT binary.
 *
 * WHY THIS IS THE MOST IMPORTANT TEST IN THE PACKAGE. Everything else here is a
 * formatting question. This is the correctness question: whether the bytes this
 * command writes are the bytes `strip_invisible.py` writes, for every fixture
 * the engine has ever been held to. The corpus was generated FROM the Python, so
 * agreeing with it is agreeing with the reference implementation.
 *
 * WHY IT IS BATCHED TO FOURTEEN SPAWNS. The naive replay is 139 times 14, that
 * is 1946 process spawns at roughly twenty milliseconds each: about half a
 * minute, slow enough that somebody eventually disables the most important test
 * in the package. Writing every fixture into a directory and cleaning all of
 * them in one `-i` invocation is fourteen spawns instead, and it exercises the
 * file and in-place paths that most need proving rather than the stdin path
 * that is easiest to test.
 *
 * WHY A FRESH DIRECTORY PER COMBO. `-i` rewrites in place, so a second combo run
 * over the same directory would be cleaning already-cleaned text and would pass
 * for the wrong reason. Each combo gets its own copy, and one more untouched
 * copy exists for the tests that must read the originals.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { FLAGS, KINDS } from '@ghostchars/engine'

import { NOT_IDEMPOTENT_UNDER_MAX, comboFlags, golden } from './helpers/golden.js'
import { requireBuild, runCli } from './helpers/run.js'

/** `f000.txt` through the last fixture, so the order on the command line is the order here. */
function fixtureName(index: number): string {
  return `f${String(index).padStart(3, '0')}.txt`
}

const NAMES = golden.text.map((_fixture, index) => fixtureName(index))

/** A combo id such as `--punct` is not a directory name. This is, and it is stable. */
function comboDirName(index: number): string {
  return `combo-${String(index).padStart(2, '0')}`
}

let root = ''

/** Write every fixture text into `dir`, byte for byte, with no newline translation. */
function populate(dir: string): void {
  mkdirSync(dir, { recursive: true })
  golden.text.forEach((fixture, index) => {
    writeFileSync(join(dir, fixtureName(index)), fixture.text, 'utf8')
  })
}

function comboDir(index: number): string {
  return join(root, comboDirName(index))
}

const ORIGINALS = 'originals'

beforeAll(() => {
  requireBuild()
  root = mkdtempSync(join(tmpdir(), 'ghostchars-golden-'))
  populate(join(root, ORIGINALS))
  golden.combos.forEach((_combo, index) => {
    populate(comboDir(index))
  })
})

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

describe('the fixture corpus', () => {
  it('holds exactly what its own meta.counts claims', () => {
    expect(golden.text.length).toBe(golden.meta.counts.text)
    expect(golden.style.length).toBe(golden.meta.counts.style)
    expect(golden.documents.length).toBe(golden.meta.counts.documents)
    expect(golden.combos.length).toBe(golden.meta.counts.combos)
  })

  /**
   * The engine's table version, read out of its source.
   *
   * `TABLES_UNICODE_VERSION` lives in `web/src/engine/tables.ts`, which the
   * engine barrel deliberately does not re-export and which this package's six
   * aliases deliberately do not expose. Reading the one line is honest and does
   * exactly what the check is for: a corpus regenerated against a different
   * Unicode Character Database must be NOTICED, not silently tolerated.
   */
  it('was generated against the Unicode version the engine tables carry', () => {
    const tables = fileURLToPath(new URL('../../web/src/engine/tables.ts', import.meta.url))
    const found = /TABLES_UNICODE_VERSION = '([^']+)'/.exec(readFileSync(tables, 'utf8'))
    expect(found, 'TABLES_UNICODE_VERSION was not found in the engine tables').not.toBeNull()
    expect(golden.meta.unicodeVersion).toBe(found?.[1])
  })

  it('covers every Kind and every Flag at least once', () => {
    const kinds = new Set<string>()
    const flags = new Set<string>()
    for (const fixture of golden.text) {
      for (const [, , , kind, flag] of fixture.findings) {
        kinds.add(kind)
        flags.add(flag)
      }
    }
    expect([...kinds].sort()).toEqual([...KINDS].sort())
    expect([...flags].sort()).toEqual([...FLAGS].sort())
  })
})

// ---------------------------------------------------------------------------
// clean, every combo
// ---------------------------------------------------------------------------

describe('clean -i reproduces the Python cleaner', () => {
  golden.combos.forEach((combo, index) => {
    it(`matches all ${golden.text.length} fixtures for combo ${combo.id}`, () => {
      const dir = comboDir(index)
      const result = runCli(['clean', '-i', ...comboFlags(combo.options), ...NAMES], { cwd: dir })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)

      const wrong: string[] = []
      golden.text.forEach((fixture, position) => {
        const actual = readFileSync(join(dir, fixtureName(position)), 'utf8')
        const expected = fixture.cleaned[combo.id]
        if (actual !== expected) wrong.push(`${fixture.id} (${fixtureName(position)})`)
      })
      expect(wrong).toEqual([])
    })
  })
})

/**
 * The fixtures that are not a fixed point under a second `--max` clean: see
 * `NOT_IDEMPOTENT_UNDER_MAX` for `gutter-nested`, which is the rule working as
 * designed. The other:
 *
 * `--collapse` is a pre-pass that runs BEFORE invisible characters are deleted,
 * so a tag-smuggled payload sitting between two spaces is not collapsed on the
 * first pass (there is nothing visible to collapse yet), is then deleted, and
 * leaves a double space that only the second run collapses. Python does exactly
 * the same thing. It is inherited and pinned, not fixed.
 */
describe('--max idempotence', () => {
  it('reaches a fixed point for every fixture except the pinned ones', () => {
    const index = golden.combos.findIndex((combo) => combo.id === '--max')
    expect(index).toBeGreaterThanOrEqual(0)
    const dir = comboDir(index)

    const once = golden.text.map((_fixture, position) =>
      readFileSync(join(dir, fixtureName(position)), 'utf8'),
    )
    const result = runCli(['clean', '-i', '--max', ...NAMES], { cwd: dir })
    expect(result.code).toBe(0)

    const moved: string[] = []
    golden.text.forEach((fixture, position) => {
      const twice = readFileSync(join(dir, fixtureName(position)), 'utf8')
      if (twice !== once[position]) moved.push(fixture.id)
    })
    expect(moved).toEqual([...NOT_IDEMPOTENT_UNDER_MAX])
  })
})

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/**
 * The pipe has to agree with the file.
 *
 * A sample rather than the whole corpus: the file path is what the batched
 * replay above already proved for every fixture, and what is being tested
 * here is that the stdin branch reaches the same cleaner, which one fixture
 * in ten across all fourteen combos establishes at a fraction of the spawn
 * cost.
 */
describe('stdin agrees with the file path', () => {
  const sample = golden.text.filter((_fixture, index) => index % 10 === 0)

  golden.combos.forEach((combo) => {
    it(`matches for combo ${combo.id}`, () => {
      const flags = comboFlags(combo.options)
      const wrong: string[] = []
      for (const fixture of sample) {
        const result = runCli(['clean', ...flags], { input: fixture.text })
        if (result.code !== 0) wrong.push(`${fixture.id}: exit ${result.code}`)
        else if (result.stdout !== fixture.cleaned[combo.id]) wrong.push(fixture.id)
      }
      expect(wrong).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

const FINDING = z.object({
  line: z.number().int(),
  col: z.number().int(),
  cp: z.number().int(),
  kind: z.string(),
  flag: z.string(),
})

const INSPECT_PAYLOAD = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      ok: z.boolean(),
      findings: z.array(FINDING),
      findingsTotal: z.number().int(),
      findingsTruncated: z.boolean(),
    }),
  ),
})

describe('inspect reproduces the Python find()', () => {
  it('reports the same tuples for all fixtures in one pass', () => {
    const dir = join(root, ORIGINALS)
    // The cap is lifted well past the corpus maximum (26) so nothing truncates
    // and the comparison is against the whole finding list, not a prefix.
    const result = runCli(['inspect', '--json', '--limit', '1000', ...NAMES], { cwd: dir })
    expect(result.code).toBe(1)
    const payload = INSPECT_PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.results.length).toBe(golden.text.length)

    const wrong: string[] = []
    golden.text.forEach((fixture, index) => {
      const entry = payload.results[index]
      if (entry === undefined) {
        wrong.push(`${fixture.id}: missing result`)
        return
      }
      if (entry.path !== fixtureName(index)) wrong.push(`${fixture.id}: path ${entry.path}`)
      if (entry.findingsTruncated) wrong.push(`${fixture.id}: truncated`)
      const tuples = entry.findings.map((finding) => [
        finding.line,
        finding.col,
        finding.cp,
        finding.kind,
        finding.flag,
      ])
      if (JSON.stringify(tuples) !== JSON.stringify(fixture.findings)) wrong.push(fixture.id)
    })
    expect(wrong).toEqual([])
  })
})
