/**
 * `clean` behaviour: the branches the golden replay does not reach.
 *
 * The parity suite proves the BYTES are right for every fixture across 14
 * option combos. This one proves the plumbing around them: which stream each
 * thing lands on, what the exit code is, when a file is opened for writing at
 * all, and what survives a failure.
 *
 * THE TWO THAT MATTER MOST. First, an unchanged file under `-i` is never opened
 * for writing, so its inode and mtime survive; that is why `ghostchars clean -i`
 * over a whole tree does not invalidate every build cache in it. Second, a
 * decode failure forces exit 2 even when another file had findings, which is
 * `strip_invisible.py`'s own priority and the reason a CI step cannot mistake
 * "one file is not text" for "one file is dirty".
 *
 * SPECIMENS ARE WRITTEN AS `\uXXXX` ESCAPES, resolved by the JavaScript parser
 * before anything reaches disk, so this file stays plain ASCII.
 */
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CLI_PATH, requireBuild, runCli } from './helpers/run.js'

const ZWSP = '\u200B'
const NBSP = '\u00A0'
const EM_DASH = '\u2014'
const BOM = '\uFEFF'

const trees: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostchars-clean-'))
  trees.push(dir)
  return dir
}

function write(dir: string, name: string, contents: string | Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, contents)
  return path
}

beforeAll(() => {
  requireBuild()
})

afterEach(() => {
  for (const dir of trees.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // The directory may already be gone or already writable.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// stdin and stdout
// ---------------------------------------------------------------------------

describe('clean over stdin', () => {
  it('writes the cleaned text to stdout and exits 0', () => {
    const result = runCli(['clean'], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ab\n')
    expect(result.stderr).toBe('')
  })

  it('adds no trailing newline of its own', () => {
    const result = runCli(['clean'], { input: `a${ZWSP}b` })
    expect(result.stdout).toBe('ab')
  })

  it('runs clean when the tool is invoked bare on a pipe', () => {
    const result = runCli([], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ab\n')
  })

  it('labels stdin with --stdin-name in the -c line', () => {
    const result = runCli(['clean', '-c', '--stdin-name', 'draft.md'], { input: `a${ZWSP}b\n` })
    expect(result.stderr).toBe('draft.md: +1 chars\n')
  })
})

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

describe('clean over files', () => {
  it('writes every cleaned file to stdout, in argument order', () => {
    const dir = makeDir()
    const first = write(dir, 'a.txt', `one${ZWSP}\n`)
    const second = write(dir, 'b.txt', `two${ZWSP}\n`)
    const result = runCli(['clean', first, second])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('one\ntwo\n')
  })

  it('exits 2 and names the problem for a missing file', () => {
    const dir = makeDir()
    const result = runCli(['clean', join(dir, 'nope.txt')])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no such file or directory')
  })

  it('exits 0 after successfully cleaning a dirty file: it did the job', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b\n`)
    expect(runCli(['clean', '-i', path]).code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('ab\n')
  })
})

// ---------------------------------------------------------------------------
// -i
// ---------------------------------------------------------------------------

describe('clean -i', () => {
  it('refuses to run without file arguments, before reading anything', () => {
    const result = runCli(['clean', '-i'], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: -i needs file arguments')
  })

  /**
   * The one that keeps `clean -i .` from churning a whole repository: a file
   * the cleaner would not change is never opened for writing, so the inode and
   * the mtime are the same ones the build cache already saw.
   */
  it('does not touch a file it would not change', () => {
    const dir = makeDir()
    const path = write(dir, 'clean.txt', 'nothing to find here\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    const before = statSync(path)

    const result = runCli(['clean', '-i', path])
    expect(result.code).toBe(0)
    const after = statSync(path)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('replaces the file atomically and leaves no temp file behind', () => {
    const dir = makeDir()
    const path = write(dir, 'dirty.txt', `a${ZWSP}b\n`)
    const before = statSync(path)
    expect(runCli(['clean', '-i', path]).code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('ab\n')
    // A rename over the destination means a NEW inode. That is the observable
    // price of atomicity, and the README says so.
    expect(statSync(path).ino).not.toBe(before.ino)
    expect(readdirSync(dir).filter((name) => name.includes('.ghostchars-'))).toEqual([])
  })

  it('is idempotent: running the same command twice is byte-identical', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b ${EM_DASH} c${NBSP}d\r\n`)
    const flags = ['clean', '-i', '--bar', 'text', path]
    expect(runCli(flags).code).toBe(0)
    const once = readFileSync(path)
    expect(runCli(flags).code).toBe(0)
    expect(readFileSync(path).equals(once)).toBe(true)
  })

  /**
   * A write that cannot start must leave the original exactly as it was. The
   * directory is made read-only, so the temp file cannot be created at all,
   * which is the same failure path a full disk takes.
   */
  it('leaves the original intact when the write cannot be made', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b\n`)
    const before = readFileSync(path)
    chmodSync(dir, 0o500)
    const result = runCli(['clean', '-i', path])
    chmodSync(dir, 0o700)
    expect(result.code).toBe(2)
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(readdirSync(dir).filter((name) => name.includes('.ghostchars-'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// --check and -c
// ---------------------------------------------------------------------------

describe('clean --check', () => {
  it('writes nothing to stdout and exits 1 on dirty input', () => {
    const result = runCli(['clean', '--check'], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('writes nothing to stdout and exits 0 on clean input', () => {
    const result = runCli(['clean', '--check'], { input: 'ab\n' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('never rewrites a file, even with -i', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b\n`)
    const before = statSync(path)
    const result = runCli(['clean', '--check', '-i', path])
    expect(result.code).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(`a${ZWSP}b\n`)
    expect(statSync(path).ino).toBe(before.ino)
  })

  it('says which file would change only when -c asks', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b\n`)
    expect(runCli(['clean', '--check', path]).stderr).toBe('')
    expect(runCli(['clean', '--check', '-c', path]).stderr).toBe(`${path}: would change\n`)
  })
})

describe('clean -c', () => {
  it('prints a signed codepoint delta, including +0', () => {
    expect(runCli(['clean', '-c'], { input: 'ab\n' }).stderr).toBe('<stdin>: +0 chars\n')
    expect(runCli(['clean', '-c'], { input: `a${ZWSP}${ZWSP}b\n` }).stderr).toBe(
      '<stdin>: +2 chars\n',
    )
  })

  /**
   * The delta is counted in CODEPOINTS, not UTF-16 units. An astral character
   * next to the finding is the case that separates the two, and Python counts
   * codepoints, so a pin copied from one tool has to mean the same in the other.
   */
  it('counts codepoints, so an astral character does not double-count', () => {
    const result = runCli(['clean', '-c'], { input: `\u{1F600}a${ZWSP}b\n` })
    expect(result.stderr).toBe('<stdin>: +1 chars\n')
  })

  it('can grow the text, and then the sign is negative', () => {
    // `--punct` turns a tight em dash into a space, a hyphen and a space.
    const result = runCli(['clean', '-c', '--punct'], { input: `a${EM_DASH}b\n` })
    expect(result.stderr).toBe('<stdin>: -2 chars\n')
  })
})

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

describe('clean and encodings', () => {
  it('keeps CRLF without -n and folds it with -n', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `one\r\ntwo${ZWSP}\r\n`)
    expect(runCli(['clean', path]).stdout).toBe('one\r\ntwo\r\n')
    expect(runCli(['clean', '-n', path]).stdout).toBe('one\ntwo\n')
  })

  /**
   * The BOM trap, and the reason `ignoreBOM: true` is in `src/io.ts`.
   *
   * Node's default `TextDecoder` swallows a leading U+FEFF. Python's
   * `open(path, encoding='utf-8')` does not, and `strip_invisible.py --show`
   * reports it at 1:1. A missing `ignoreBOM` would make `inspect` report zero
   * findings here and put the `-c` delta off by one.
   */
  it('sees a byte-order mark as a character, reports it, and removes it', () => {
    const dir = makeDir()
    const path = write(dir, 'bom.txt', Buffer.from(`${BOM}hello\n`, 'utf8'))
    const inspected = runCli(['inspect', path])
    expect(inspected.code).toBe(1)
    expect(inspected.stdout).toContain('1:1\tU+FEFF')
    const cleaned = runCli(['clean', '-c', path])
    expect(cleaned.stdout).toBe('hello\n')
    expect(cleaned.stderr).toBe(`${path}: +1 chars\n`)
  })

  it('leaves a file that is not UTF-8 byte for byte alone under -i, and exits 2', () => {
    const dir = makeDir()
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a])
    const path = write(dir, 'binary.bin', bytes)
    const result = runCli(['clean', '-i', path])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('not valid UTF-8, skipped')
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })

  it('lets a decode failure beat a would-change in another file', () => {
    const dir = makeDir()
    const dirty = write(dir, 'dirty.txt', `a${ZWSP}b\n`)
    const binary = write(dir, 'binary.bin', Buffer.from([0xff, 0xfe]))
    const result = runCli(['clean', '--check', dirty, binary])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('not valid UTF-8, skipped')
  })
})

// ---------------------------------------------------------------------------
// large output
// ---------------------------------------------------------------------------

/**
 * `process.exit()` truncates a pending pipe write.
 *
 * The reader here is deliberately slow: stdout is paused until the child has
 * had time to fill and block on the pipe. If the CLI ever called
 * `process.exit()` after writing, the tail of this would simply never arrive.
 */
async function readSlowly(input: string): Promise<{ code: number; length: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'clean'], { stdio: 'pipe' })
    const chunks: Buffer[] = []
    child.stdout.pause()
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? -1, length: Buffer.concat(chunks).length })
    })
    setTimeout(() => child.stdout.resume(), 250)
    child.stdin.end(input)
  })
}

describe('clean through a slow pipe', () => {
  it('delivers every byte of an eight-megabyte clean', async () => {
    const block = `${'lorem ipsum dolor sit amet '.repeat(4)}${ZWSP}\n`
    const repeats = Math.ceil((8 * 1024 * 1024) / block.length)
    const input = block.repeat(repeats)
    const expected = input.replaceAll(ZWSP, '')
    expect(input.length).toBeGreaterThan(8 * 1024 * 1024)
    const result = await readSlowly(input)
    expect(result.code).toBe(0)
    expect(result.length).toBe(Buffer.byteLength(expected, 'utf8'))
  }, 60_000)
})

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

const REWRITE_SITE = z.object({
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  cp: z.number().int(),
  u: z.string(),
  name: z.string(),
  before: z.string(),
  hint: z.string().min(1),
})

const PAYLOAD = z.object({
  tool: z.literal('ghostchars'),
  version: z.string(),
  command: z.literal('clean'),
  ok: z.boolean(),
  exitCode: z.number().int(),
  bar: z.string(),
  options: z.array(z.string()),
  summary: z.object({
    removed: z.number().int(),
    replaced: z.number().int(),
    keptLoadBearing: z.number().int(),
    foundNotTargeted: z.number().int(),
    filesChanged: z.number().int(),
    filesUnchanged: z.number().int(),
    filesSkipped: z.number().int(),
  }),
  results: z.array(
    z.object({
      path: z.string(),
      ok: z.boolean(),
      changed: z.boolean().optional(),
      written: z.boolean().optional(),
      charsDelta: z.number().int().optional(),
      rewriteSites: z.array(REWRITE_SITE).optional(),
      text: z.string().optional(),
      error: z.object({ kind: z.string(), message: z.string() }).optional(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// --gutters
// ---------------------------------------------------------------------------

/** U+258E LEFT ONE QUARTER BLOCK, the bar a terminal draws down a quote. */
const BAR = '\u258E'
/** U+2502 BOX DRAWINGS LIGHT VERTICAL, a gutter at a line start and a table rule elsewhere. */
const LIGHT = '\u2502'
const QUOTED = `${BAR} Dear Mr Kirch,\n${BAR}\n${BAR} We apologise for the delay.\n`
const UNQUOTED = 'Dear Mr Kirch,\n\nWe apologise for the delay.\n'

describe('clean --gutters', () => {
  it('leaves quote bars alone unless asked', () => {
    expect(runCli(['clean'], { input: QUOTED }).stdout).toBe(QUOTED)
    expect(runCli(['clean', '--bar', 'text'], { input: QUOTED }).stdout).toBe(QUOTED)
  })

  it('strips the bar and one space from each line when asked, and under --max and the max bar', () => {
    for (const args of [['--gutters'], ['--max'], ['--bar', 'max']]) {
      const result = runCli(['clean', ...args], { input: QUOTED })
      expect(result.code, args.join(' ')).toBe(0)
      expect(result.stdout, args.join(' ')).toBe(UNQUOTED)
    }
  })

  it('keeps CRLF and indentation, and leaves a box-drawn table row whole', () => {
    const input = `${BAR} one\r\n  ${LIGHT} two\r\n${LIGHT} a ${LIGHT} b ${LIGHT}\r\n`
    const result = runCli(['clean', '--gutters'], { input })
    expect(result.stdout).toBe(`one\r\n  two\r\n${LIGHT} a ${LIGHT} b ${LIGHT}\r\n`)
  })

  it('names the option in --json', () => {
    const result = runCli(['clean', '--json', '--gutters'], { input: QUOTED })
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.options).toEqual(['gutters'])
    expect(payload.results[0]?.text).toBe(UNQUOTED)
  })
})

describe('clean --json', () => {
  it('carries the whole cleaned text, the verdict and the exit code', () => {
    const result = runCli(['clean', '--json', '--bar', 'text'], { input: `a${ZWSP}b\n` })
    expect(result.code).toBe(0)
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.ok).toBe(true)
    expect(payload.exitCode).toBe(0)
    expect(payload.bar).toBe('text')
    expect(payload.options).toEqual(['punct', 'spaces'])
    expect(payload.summary.filesChanged).toBe(1)
    const entry = payload.results[0]
    expect(entry?.changed).toBe(true)
    expect(entry?.text).toBe('ab\n')
    expect(entry?.charsDelta).toBe(1)
  })

  /**
   * `rewriteSites` is the field nothing else in this ecosystem has: the dash
   * positions where the mechanical substitution is correct and the sentence
   * still reads badly. Only dashes, and only when `punct` is on.
   */
  it('lists a dash to rewrite and stays silent about a curly quote', () => {
    const dashed = runCli(['clean', '--json', '--bar', 'text'], {
      input: `the sentence${EM_DASH}with a dash in it\n`,
    })
    const withDash = PAYLOAD.parse(JSON.parse(dashed.stdout)).results[0]
    expect(withDash?.rewriteSites?.length).toBe(1)
    expect(withDash?.rewriteSites?.[0]?.u).toBe('U+2014')
    expect(withDash?.rewriteSites?.[0]?.col).toBe(13)
    expect(withDash?.rewriteSites?.[0]?.hint).toContain('restructure the sentence')

    const quoted = runCli(['clean', '--json', '--bar', 'text'], {
      input: 'she said \u201Cno\u201D and left\n',
    })
    expect(PAYLOAD.parse(JSON.parse(quoted.stdout)).results[0]?.rewriteSites).toEqual([])
  })

  /**
   * The column is a CODEPOINT count, and the arithmetic behind it was rewritten
   * to stop being quadratic: it no longer slices the line and counts the prefix,
   * it subtracts the surrogate pairs that fit inside the prefix. Astral
   * characters are the only input where the two answers can differ, so they are
   * the input that pins the rewrite.
   */
  it('counts the column in codepoints when astral characters come first', () => {
    // Four astral characters (eight UTF-16 units), a space, then a dash between
    // two letters. The dash is codepoint 7 and UTF-16 unit 11.
    const emoji = '\u{1F600}'.repeat(4)
    const result = runCli(['clean', '--json', '--bar', 'text'], {
      input: `${emoji} a${EM_DASH}b\n`,
    })
    const site = PAYLOAD.parse(JSON.parse(result.stdout)).results[0]?.rewriteSites?.[0]
    expect(site?.u).toBe('U+2014')
    expect(site?.col).toBe(7)
  })

  it('keeps the quoted line at 160 codepoints, cut on a character boundary', () => {
    // `contextLine` slices to twice the width in UTF-16 units before counting,
    // so it costs the width and not the line. An all-astral line is the case
    // where that shortcut could split a surrogate pair.
    const emoji = '\u{1F600}'.repeat(300)
    const result = runCli(['clean', '--json', '--bar', 'text'], {
      input: `a${EM_DASH}b${emoji}\n`,
    })
    const before = PAYLOAD.parse(JSON.parse(result.stdout)).results[0]?.rewriteSites?.[0]?.before
    expect([...(before ?? '')].length).toBe(160)
    expect(before ?? '').not.toMatch(/[\uD800-\uDFFF]/u)
  })

  it('omits rewriteSites entirely when punct is off', () => {
    const result = runCli(['clean', '--json'], { input: `a${EM_DASH}b\n` })
    expect(PAYLOAD.parse(JSON.parse(result.stdout)).results[0]?.rewriteSites).toBeUndefined()
  })

  it('reports written instead of text under -i, and prints no cleaned text', () => {
    const dir = makeDir()
    const path = write(dir, 'a.txt', `a${ZWSP}b\n`)
    const result = runCli(['clean', '--json', '-i', path])
    const entry = PAYLOAD.parse(JSON.parse(result.stdout)).results[0]
    expect(entry?.written).toBe(true)
    expect(entry?.text).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('ab\n')
  })

  it('reports a failed input as a result and keeps the run exit code at 2', () => {
    const dir = makeDir()
    const good = write(dir, 'a.txt', `a${ZWSP}b\n`)
    const bad = write(dir, 'b.bin', Buffer.from([0xff, 0xfe]))
    const result = runCli(['clean', '--json', good, bad])
    expect(result.code).toBe(2)
    const payload = PAYLOAD.parse(JSON.parse(result.stdout))
    expect(payload.ok).toBe(false)
    expect(payload.exitCode).toBe(2)
    expect(payload.summary.filesSkipped).toBe(1)
    expect(payload.results[1]?.error?.kind).toBe('not-utf8')
  })
})
