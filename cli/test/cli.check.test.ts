/**
 * `ghostchars check`, driven as a gate: real trees, real git, real exit codes.
 *
 * Every tree here is generated into the system temp directory from JavaScript
 * escapes and thrown away afterwards. Nothing deliberately dirty is ever
 * committed, because this repository runs its own text-hygiene gate over every
 * text file it can find and the two gates would fight over the fixtures.
 *
 * Specimens are written as backslash-u escapes on purpose. The escape is
 * resolved by the JavaScript parser long before a byte reaches the disk, so
 * what the gate reads is the real character while this source file stays plain
 * ASCII and passes the repository's own tier-1 check unchanged.
 */
import { chmodSync, mkdirSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runCli } from './helpers/run.js'
import { makeTree, readTreeBytes, readTreeFile, removeTree } from './helpers/tree.js'
import type { TreeFiles, TreeOptions } from './helpers/tree.js'

// ---------------------------------------------------------------------------
// specimens
// ---------------------------------------------------------------------------

/** U+200B ZERO WIDTH SPACE. Nothing legitimately needs one. Fails every bar. */
const ZWSP = '\u200B'
/** U+2014 EM DASH. Typography, so it fails the text bar and passes default. */
const EM_DASH = '\u2014'
/** U+00A0 NO-BREAK SPACE. Also typography under the text bar. */
const NBSP = '\u00A0'

const CLEAN_TEXT = 'A plain line of prose.\n'
const TEXT_BAR_DIRTY = `one${EM_DASH}two\n`
const DEFAULT_BAR_DIRTY = `one${ZWSP}two\n`

// ---------------------------------------------------------------------------
// tree plumbing
// ---------------------------------------------------------------------------

const roots: string[] = []

function tree(files: TreeFiles, options: TreeOptions = {}): string {
  const root = makeTree(files, options)
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) removeTree(root)
  }
})

function check(root: string, args: readonly string[]): ReturnType<typeof runCli> {
  return runCli(['check', ...args], { cwd: root })
}

function configText(surfaces: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, surfaces, ...extra }, null, 1)
}

// ---------------------------------------------------------------------------
// the JSON payload, validated rather than asserted into shape
// ---------------------------------------------------------------------------

const HIT = z.object({
  line: z.number().int(),
  col: z.number().int(),
  cp: z.number().int(),
  u: z.string(),
  name: z.string(),
  kind: z.string(),
  flag: z.string(),
  lineText: z.string(),
})

const PAYLOAD = z.object({
  tool: z.literal('ghostchars'),
  version: z.string(),
  command: z.literal('check'),
  ok: z.boolean(),
  exitCode: z.number().int(),
  root: z.string(),
  discovery: z.enum(['git', 'walk']),
  config: z.string().nullable(),
  surfaces: z.array(
    z.object({
      id: z.string(),
      bar: z.string().optional(),
      options: z.array(z.string()),
      decodeEscapes: z.boolean(),
      scanned: z.number().int(),
      failed: z.number().int(),
    }),
  ),
  filesScanned: z.number().int(),
  filesSkipped: z.number().int(),
  filesFailing: z.number().int(),
  failures: z.array(
    z.object({
      path: z.string(),
      surface: z.string(),
      bar: z.string(),
      status: z.enum(['changed', 'pin-mismatch', 'pin-stale']),
      changed: z.number().int(),
      pinned: z.number().int(),
      hits: z.array(HIT),
    }),
  ),
  passed: z
    .array(z.object({ path: z.string(), surface: z.string(), bar: z.string() }))
    .optional(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  skippedTruncated: z.boolean(),
  skippedTotal: z.number().int(),
})

type Payload = z.infer<typeof PAYLOAD>

function payloadOf(result: ReturnType<typeof runCli>): Payload {
  const parsed: unknown = JSON.parse(result.stdout)
  return PAYLOAD.parse(parsed)
}

// ---------------------------------------------------------------------------
// bars
// ---------------------------------------------------------------------------

describe('the two bars', () => {
  it('passes a clean tree and says which bar it held it to', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ghostchars: 1 file passes the default bar\n')
    expect(result.stderr).toBe('')
  })

  it('lets typography through the default bar and stops it at the text bar', () => {
    const root = tree({ 'docs/post.md': TEXT_BAR_DIRTY })
    expect(check(root, ['--no-git']).code).toBe(0)

    const strict = check(root, ['--no-git', '--bar', 'text'])
    expect(strict.code).toBe(1)
    expect(strict.stdout).toBe(
      [
        'docs/post.md: the text bar would change this file:',
        `  docs/post.md:1:4 U+2014 EM DASH`,
        `      one${EM_DASH}two`,
        '',
        'ghostchars: 1 file would change, 1 scanned',
        '',
      ].join('\n'),
    )
  })

  it('stops an invisible character at the default bar', () => {
    const root = tree({ 'docs/post.md': DEFAULT_BAR_DIRTY })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('docs/post.md:1:4 U+200B ZERO WIDTH SPACE')
    expect(result.stdout).toContain('ghostchars: 1 file would change, 1 scanned')
  })

  it('refuses a max bar and says why', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--bar', 'max'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--bar must be one of default, text')
    expect(result.stderr).toContain('The gate has no max bar')
  })

  it('takes a bare option flag as a floor over the bar', () => {
    const root = tree({ 'docs/a.md': `one${NBSP}two\n` })
    expect(check(root, ['--no-git']).code).toBe(0)
    expect(check(root, ['--no-git', '-s']).code).toBe(1)
  })

  it('holds quote bars to neither bar, and to a --gutters floor', () => {
    const root = tree({ 'docs/mail.md': '\u258E quoted\n' })
    expect(check(root, ['--no-git']).code).toBe(0)
    expect(check(root, ['--no-git', '--bar', 'text']).code).toBe(0)
    const floor = check(root, ['--no-git', '--gutters'])
    expect(floor.code).toBe(1)
    expect(floor.stdout).toContain('docs/mail.md:1:1 U+258E LEFT ONE QUARTER BLOCK')
  })

  it('reports one line per distinct source line and quotes it once', () => {
    const root = tree({ 'docs/a.md': `x${ZWSP}y${ZWSP}z\nplain\n` })
    const result = check(root, ['--no-git'])
    const lines = result.stdout.split('\n')
    expect(lines.filter((line) => line.includes('U+200B')).length).toBe(2)
    // The quoted line is the source as it stands, contraband included: a gate
    // that showed a cleaned line would hide the thing it is pointing at.
    expect(lines.filter((line) => line.trim() === `x${ZWSP}y${ZWSP}z`).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// pins, in both directions
// ---------------------------------------------------------------------------

describe('pins', () => {
  const surface = (pins: Record<string, number>): unknown => ({
    id: 'prose',
    bar: 'text',
    include: ['**/*.md'],
    pins,
  })

  it('lets a correctly pinned file through in silence', () => {
    const root = tree({
      'docs/glyphs.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([surface({ 'docs/glyphs.md': 1 })]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1 file passes the text bar')
  })

  it('fails an over-pinned file with the two counts', () => {
    const root = tree({
      'docs/glyphs.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([surface({ 'docs/glyphs.md': 2 })]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      'docs/glyphs.md: changes 1 characters, but exactly 2 are pinned',
    )
  })

  it('fails a pin that went stale and says to unpin it', () => {
    const root = tree({
      'docs/glyphs.md': CLEAN_TEXT,
      'ghostchars.json': configText([surface({ 'docs/glyphs.md': 3 })]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      'docs/glyphs.md: 3 pinned as deliberately dirty but now changes nothing. Unpin it.',
    )
  })

  it('carries both pin statuses into the JSON payload without hits', () => {
    const root = tree({
      'docs/stale.md': CLEAN_TEXT,
      'docs/wrong.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([
        surface({ 'docs/stale.md': 3, 'docs/wrong.md': 9 }),
      ]),
    })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(1)
    const payload = payloadOf(result)
    const byPath = new Map(payload.failures.map((failure) => [failure.path, failure]))
    expect(byPath.get('docs/stale.md')?.status).toBe('pin-stale')
    expect(byPath.get('docs/stale.md')?.pinned).toBe(3)
    expect(byPath.get('docs/stale.md')?.hits).toEqual([])
    expect(byPath.get('docs/wrong.md')?.status).toBe('pin-mismatch')
    expect(byPath.get('docs/wrong.md')?.changed).toBe(1)
    expect(byPath.get('docs/wrong.md')?.hits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// text detection
// ---------------------------------------------------------------------------

describe('what is not text', () => {
  it('skips a binary file in silence and does not fail the run', () => {
    const root = tree({
      'docs/a.md': CLEAN_TEXT,
      'assets/blob.dat': new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ghostchars: 1 file passes the default bar, 1 skipped\n')
  })

  it('skips a known binary extension without opening it', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'img/logo.png': `not really a png${ZWSP}\n` })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(0)
    const payload = payloadOf(result)
    expect(payload.skipped).toEqual([{ path: 'img/logo.png', reason: 'binary-ext' }])
    expect(payload.filesScanned).toBe(1)
  })

  it('skips a file over the byte cap', () => {
    const root = tree({ 'docs/a.md': 'x'.repeat(4096) })
    const result = check(root, ['--no-git', '--max-bytes', '10', '--json'])
    expect(result.code).toBe(0)
    expect(payloadOf(result).skipped).toEqual([{ path: 'docs/a.md', reason: 'too-large' }])
  })

  it('errors on a NAMED file the NUL scan would have skipped', () => {
    /**
     * The NUL scan is a discovery heuristic, and it used to run before the
     * named-file rule rather than under it. A UTF-16 file, which carries both a
     * NUL byte and an invalid UTF-8 start byte, was therefore reported as
     * `0 files pass the default bar, 1 skipped` with an empty stderr and exit 0
     * when it was NAMED on the command line, where `strip_invisible.py --show`
     * on the same file prints `not valid UTF-8, skipped` and exits 2. A CI step
     * or an agent gating on the exit code alone got a clean pass on a file that
     * was never read.
     */
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'data/utf16.md': utf16 })

    const walked = check(root, ['--no-git', '--json'])
    expect(walked.code).toBe(0)
    expect(payloadOf(walked).skipped).toEqual([{ path: 'data/utf16.md', reason: 'binary' }])

    const named = check(root, ['data/utf16.md'])
    expect(named.code).toBe(2)
    expect(named.stderr).toContain('data/utf16.md: not valid UTF-8, skipped')
  })

  it('gates a NAMED file that is real UTF-8 with a NUL in it, as the reference does', () => {
    // The decode decides, not the heuristic. `strip_invisible.py` reads this
    // file happily, so naming it here has to gate it rather than skip it.
    const root = tree({ 'data/withnul.txt': `one\u0000two${ZWSP}\n` })
    const result = check(root, ['data/withnul.txt', '--json'])
    expect(result.code).toBe(1)
    const payload = payloadOf(result)
    expect(payload.filesScanned).toBe(1)
    expect(payload.failures[0]?.changed).toBe(1)
  })

  it('skips undecodable bytes found by the walk, and errors on the same file named', () => {
    const bad = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x0a])
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'data/broken.txt': bad })

    const walked = check(root, ['--no-git', '--json'])
    expect(walked.code).toBe(0)
    expect(payloadOf(walked).skipped).toEqual([{ path: 'data/broken.txt', reason: 'not-utf8' }])

    const named = check(root, ['data/broken.txt'])
    expect(named.code).toBe(2)
    expect(named.stderr).toContain('data/broken.txt: not valid UTF-8, skipped')
    expect(readTreeBytes(root, 'data/broken.txt')).toEqual(Buffer.from(bad))
  })

  it('reports a path argument that does not exist and exits 2', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['docs/nope.md'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('docs/nope.md: no such file or directory')
  })
})

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('honours .gitignore under git and ignores it under --no-git', () => {
    const root = tree(
      {
        '.gitignore': 'ignored.md\n',
        'ignored.md': DEFAULT_BAR_DIRTY,
        'kept.md': DEFAULT_BAR_DIRTY,
      },
      { git: true },
    )

    const withGit = check(root, ['--json'])
    expect(withGit.code).toBe(1)
    const gitPayload = payloadOf(withGit)
    expect(gitPayload.discovery).toBe('git')
    expect(gitPayload.failures.map((failure) => failure.path)).toEqual(['kept.md'])

    const walked = check(root, ['--no-git', '--json'])
    expect(walked.code).toBe(1)
    const walkPayload = payloadOf(walked)
    expect(walkPayload.discovery).toBe('walk')
    expect(walkPayload.failures.map((failure) => failure.path)).toEqual(['ignored.md', 'kept.md'])
  })

  it('never descends into a directory the gate does not gate', () => {
    const root = tree({
      'keep.md': CLEAN_TEXT,
      'node_modules/pkg/index.js': DEFAULT_BAR_DIRTY,
      'dist/bundle.js': DEFAULT_BAR_DIRTY,
      '.hidden/secret.md': DEFAULT_BAR_DIRTY,
    })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(0)
    expect(payloadOf(result).filesScanned).toBe(1)
  })

  it('walks into the dot-directories agents read their instructions from', () => {
    const root = tree({
      '.cursor/rules/house.mdc': DEFAULT_BAR_DIRTY,
      '.github/instructions/a.instructions.md': DEFAULT_BAR_DIRTY,
      '.pytest_cache/README.md': DEFAULT_BAR_DIRTY,
    })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(1)
    expect(payloadOf(result).failures.map((failure) => failure.path)).toEqual([
      '.cursor/rules/house.mdc',
      '.github/instructions/a.instructions.md',
    ])
  })

  it('produces the same output twice over the same tree', () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const name of ['m', 'b', 'z', 'a', 'q']) {
      files[`docs/${name}.md`] = DEFAULT_BAR_DIRTY
    }
    const root = tree(files)
    const first = check(root, ['--no-git'])
    const second = check(root, ['--no-git'])
    expect(first.stdout).toBe(second.stdout)
    expect(first.code).toBe(second.code)
    const listed = first.stdout
      .split('\n')
      .filter((line) => line.endsWith('would change this file:'))
      .map((line) => line.split(':')[0])
    expect(listed).toEqual(['docs/a.md', 'docs/b.md', 'docs/m.md', 'docs/q.md', 'docs/z.md'])
  })

  it('skips a symlink found by the walk', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    symlinkSync(join(root, 'docs', 'a.md'), join(root, 'docs', 'link.md'))
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(0)
    expect(payloadOf(result).skipped).toEqual([{ path: 'docs/link.md', reason: 'symlink' }])
  })

  // Two sentences, not one. `--git` exists so CI can PIN the strategy, so both
  // "git is not installed" and "this is not a repository" are hard errors, and
  // an environment that has git is told which of the two it actually hit rather
  // than being sent to install something it already has.
  it('fails loudly when --git is asked for outside a repository', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['--git'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('is not inside a git repository')
    expect(result.stderr).toContain('Drop --git to walk the tree instead')
    expect(result.stderr).not.toContain('not on PATH')
  })

  it('fails just as loudly when --git is given WITH a path argument', () => {
    /**
     * The check used to be gated on there being no positional arguments, so
     * `--git <dir>` where git could not be used printed an ordinary report
     * carrying `"discovery": "walk"` and said nothing at all. A CI job that pins
     * `--git` for reproducible .gitignore-aware discovery and then passes a
     * changed-file list, which is the ordinary CI shape, got exactly the silent
     * strategy switch the flag exists to prevent.
     */
    const root = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY })
    for (const args of [['--git', 'docs'], ['--git', 'docs/a.md'], ['--git', '--json', '.']]) {
      const result = check(root, args)
      expect(result.code, args.join(' ')).toBe(2)
      expect(result.stderr, args.join(' ')).toContain('Drop --git to walk the tree instead')
      expect(result.stdout, args.join(' ')).toBe('')
    }
  })

  it('still runs --git with a path argument inside a real repository', () => {
    // The assertion is that git COULD be used, not that discovery used it:
    // explicit paths are walked by design, and the flag must not break that.
    const root = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY }, { git: true })
    const result = check(root, ['--git', 'docs', '--json'])
    expect(result.code).toBe(1)
    const payload = payloadOf(result)
    expect(payload.discovery).toBe('walk')
    expect(payload.filesScanned).toBe(1)
  })

  it('reports a directory it cannot read instead of pretending the tree is clean', () => {
    /**
     * `walk()` swallowed `readdirSync` failures with `catch { return }`. A tree
     * with one unreadable directory holding a file that fails the bar reported
     * `"ok": true`, `"filesScanned": 1`, `"filesSkipped": 0` and exit 0: the
     * directory appeared in no count, in no list and in no exit code. A
     * permission-restricted directory is ordinary in a CI image or a mounted
     * cache, and content the gate could not examine has to be visible, which is
     * the same rule this package states for a file it cannot decode.
     */
    const root = tree({ 'top.txt': CLEAN_TEXT, 'locked/dirty.txt': TEXT_BAR_DIRTY })
    const locked = join(root, 'locked')
    chmodSync(locked, 0o000)
    try {
      const result = check(root, ['--no-git', '--bar', 'text', '--json'])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('locked')
      expect(result.stderr).toContain('permission denied')
      expect(payloadOf(result).ok).toBe(false)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// the config file
// ---------------------------------------------------------------------------

describe('ghostchars.json', () => {
  it('matches docs/a.md with the pattern docs/**/*.md', () => {
    const root = tree({
      'docs/a.md': TEXT_BAR_DIRTY,
      'docs/deep/b.md': TEXT_BAR_DIRTY,
      'other/c.md': TEXT_BAR_DIRTY,
      'ghostchars.json': configText([
        { id: 'prose', bar: 'text', include: ['docs/**/*.md'] },
      ]),
    })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(1)
    const payload = payloadOf(result)
    expect(payload.failures.map((failure) => failure.path)).toEqual(['docs/a.md', 'docs/deep/b.md'])
    expect(payload.filesScanned).toBe(2)
  })

  it('lets an exclusion beat a path named on the command line', () => {
    const root = tree({
      'vendor/dirty.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([
        { id: 'all', bar: 'default', include: ['**/*'], exclude: ['vendor/**'] },
      ]),
    })
    const result = check(root, ['vendor/dirty.md', '--json'])
    expect(result.code).toBe(0)
    expect(payloadOf(result).filesScanned).toBe(0)
  })

  it('takes the later surface when two of them claim the same file', () => {
    const root = tree({
      'docs/a.md': TEXT_BAR_DIRTY,
      'ghostchars.json': configText([
        { id: 'invisibles', bar: 'default', include: ['**/*'] },
        { id: 'prose', bar: 'text', include: ['**/*.md'] },
      ]),
    })
    const result = check(root, ['--no-git', '--json'])
    expect(result.code).toBe(1)
    const payload = payloadOf(result)
    expect(payload.failures[0]?.surface).toBe('prose')
    expect(payload.failures[0]?.bar).toBe('text')
  })

  it('resolves source escapes only when the surface asks for it', () => {
    const surface = (decodeEscapes: boolean): unknown => ({
      id: 'src',
      bar: 'text',
      include: ['**/*.ts'],
      decodeEscapes,
    })
    const root = tree({
      'src/messages.ts': "export const dash = '\\u2014'\n",
      'gc-raw.json': configText([surface(false)]),
      'gc-decode.json': configText([surface(true)]),
    })

    const raw = check(root, ['--no-git', '--config', 'gc-raw.json', '--json'])
    expect(raw.code).toBe(0)
    expect(payloadOf(raw).filesScanned).toBe(1)

    const decoded = check(root, ['--no-git', '--config', 'gc-decode.json', '--json'])
    expect(decoded.code).toBe(1)
    const payload = payloadOf(decoded)
    expect(payload.failures.length).toBe(1)
    expect(payload.failures[0]?.changed).toBe(1)
    expect(payload.failures[0]?.hits[0]?.u).toBe('U+2014')
    expect(payload.failures[0]?.hits[0]?.line).toBe(1)
    expect(payload.failures[0]?.hits[0]?.col).toBe(22)
  })

  it('lets the command line raise the floor under every surface', () => {
    // The package has one resolution rule: an option can only be turned ON. So
    // `--bar text` means the same thing in a repository with a config as in one
    // without, instead of being quietly ignored by the config's own bar.
    const root = tree({
      'docs/a.md': TEXT_BAR_DIRTY,
      'ghostchars.json': configText([{ id: 'all', bar: 'default', include: ['**/*'] }]),
    })
    expect(check(root, ['--no-git']).code).toBe(0)

    const raised = check(root, ['--no-git', '--bar', 'text', '--json'])
    expect(raised.code).toBe(1)
    const payload = payloadOf(raised)
    expect(payload.surfaces[0]?.options).toEqual(['punct', 'spaces'])
    expect(payload.surfaces[0]?.bar).toBe('text')
  })

  it('reads an odd backslash run as an escape and an even one as literal text', () => {
    // On disk: a doubled backslash before u2014, then a braced escape. The
    // first renders no dash at all and must survive; the second renders one.
    const root = tree({
      'src/a.ts': "const doubled = '\\\\u2014'\nconst braced = '\\u{2014}'\n",
      'ghostchars.json': configText([
        { id: 'src', bar: 'text', include: ['**/*.ts'], decodeEscapes: true },
      ]),
    })
    const payload = payloadOf(check(root, ['--no-git', '--json']))
    expect(payload.failures.length).toBe(1)
    expect(payload.failures[0]?.changed).toBe(1)
    expect(payload.failures[0]?.hits[0]?.line).toBe(2)
  })

  it('refuses to decode a line terminator, so line numbers stay true', () => {
    // A decoded newline would renumber every finding under it. The escape for
    // U+000A stays as typed and the dash on the same line is still line 1.
    const root = tree({
      'src/a.ts': "const both = '\\u000A\\u2014'\n",
      'ghostchars.json': configText([
        { id: 'src', bar: 'text', include: ['**/*.ts'], decodeEscapes: true },
      ]),
    })
    const payload = payloadOf(check(root, ['--no-git', '--json']))
    expect(payload.failures[0]?.changed).toBe(1)
    expect(payload.failures[0]?.hits[0]?.u).toBe('U+2014')
    expect(payload.failures[0]?.hits[0]?.line).toBe(1)
  })

  it('rejects an unknown key and lists the ones that would have worked', () => {
    const root = tree({
      'ghostchars.json': JSON.stringify({
        version: 1,
        surfaces: [{ id: 'all', bar: 'default', include: ['**/*'] }],
        pinz: {},
      }),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("unknown key 'pinz'")
    expect(result.stderr).toContain('Known keys: version, surfaces, maxBytes.')
  })

  it('rejects a surface that sets neither a bar nor options', () => {
    const root = tree({
      'ghostchars.json': configText([{ id: 'all', include: ['**/*'] }]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('sets neither bar nor options')
  })

  it('rejects a max bar in the config file', () => {
    const root = tree({
      'ghostchars.json': configText([{ id: 'all', bar: 'max', include: ['**/*'] }]),
    })
    const result = check(root, ['--no-git'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('surfaces[0].bar')
    expect(result.stderr).toContain('The gate has no max bar')
  })

  it('is ignored entirely under --no-config', () => {
    const root = tree({
      'docs/a.md': TEXT_BAR_DIRTY,
      'ghostchars.json': configText([{ id: 'prose', bar: 'text', include: ['**/*.md'] }]),
    })
    expect(check(root, ['--no-git']).code).toBe(1)
    const ignored = check(root, ['--no-git', '--no-config', '--json'])
    expect(ignored.code).toBe(0)
    expect(payloadOf(ignored).config).toBeNull()
  })

  it('takes maxBytes from the file and lets the flag override it', () => {
    const root = tree({
      'docs/a.md': 'x'.repeat(200),
      'ghostchars.json': configText([{ id: 'all', bar: 'default', include: ['**/*'] }], {
        maxBytes: 50,
      }),
    })
    const fromFile = payloadOf(check(root, ['--no-git', '--json']))
    expect(fromFile.skipped.map((entry) => entry.path)).toContain('docs/a.md')
    expect(fromFile.skipped.every((entry) => entry.reason === 'too-large')).toBe(true)
    const fromFlag = check(root, ['--no-git', '--max-bytes', '4096', '--json'])
    expect(payloadOf(fromFlag).filesSkipped).toBe(0)
  })

  it('finds the config of a directory named from somewhere else entirely', () => {
    /**
     * Root and config were resolved from the working directory alone, and the
     * positional paths were consulted only afterwards, to pick files. So
     * `ghostchars check <dir>` run from anywhere but `<dir>` silently dropped
     * `<dir>/ghostchars.json` and fell back to the implicit single-surface,
     * default-bar, zero-pin gate. The tree below fails only because its own
     * config asks for the text bar, so a run that misses the config reports a
     * clean pass, which is exactly what it used to do.
     */
    const target = tree({
      'docs/a.md': TEXT_BAR_DIRTY,
      'ghostchars.json': configText([{ id: 'prose', bar: 'text', include: ['**/*.md'] }]),
    })
    const elsewhere = tree({ 'unrelated.txt': CLEAN_TEXT })

    const inside = payloadOf(check(target, ['--no-git', '--json']))
    const outside = payloadOf(runCli(['check', '--no-git', '--json', target], { cwd: elsewhere }))

    // Compared through realpath: the system temp directory is reached by a
    // symlink on macOS, and `process.cwd()` resolves it while a path typed on
    // the command line does not. Same directory, two spellings.
    expect(outside.config).not.toBeNull()
    expect(realpathSync(outside.config ?? '')).toBe(realpathSync(inside.config ?? ''))
    expect(realpathSync(outside.root)).toBe(realpathSync(inside.root))
    expect(outside.surfaces.map((surface) => surface.id)).toEqual(['prose'])
    expect(outside.filesFailing).toBe(1)
    expect(outside.exitCode).toBe(1)
  })

  it('refuses two paths governed by two different configs rather than picking one', () => {
    // One run has one root, because a pin and a glob are both written relative
    // to it. Choosing silently would apply one config's pins to another's tree.
    const one = tree({
      'a.md': CLEAN_TEXT,
      'ghostchars.json': configText([{ id: 'one', bar: 'text', include: ['**/*.md'] }]),
    })
    const two = tree({
      'b.md': CLEAN_TEXT,
      'ghostchars.json': configText([{ id: 'two', bar: 'text', include: ['**/*.md'] }]),
    })
    const elsewhere = tree({ 'unrelated.txt': CLEAN_TEXT })
    const result = runCli(['check', '--no-git', one, two], { cwd: elsewhere })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('2 different ghostchars.json files')
    expect(result.stderr).toContain('pass --config to pick one')
  })

  it('leaves a run with no config anywhere on the implicit surface', () => {
    const target = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY })
    const elsewhere = tree({ 'unrelated.txt': CLEAN_TEXT })
    const payload = payloadOf(runCli(['check', '--no-git', '--json', target], { cwd: elsewhere }))
    expect(payload.config).toBeNull()
    expect(payload.surfaces.map((surface) => surface.id)).toEqual(['all'])
    expect(payload.filesFailing).toBe(1)
  })

  it('matches a glob with many stars in bounded time instead of backtracking', () => {
    /**
     * The compiler translated each `*` into an adjacent `[^/]*` and handed the
     * result to RegExp, which is the textbook catastrophic-backtracking shape
     * and has no atomic group in JavaScript to stop it. MEASURED on the shipped
     * binary before the rewrite: the pattern below against a 41 character
     * non-matching filename hung past a 20 second kill, and the curve was 19 ms,
     * 91 ms, 403 ms, 1,593 ms, 6,944 ms for names of 35 to 39 characters. The
     * same code path is behind the MCP `check_paths` tool, whose `config` field
     * a caller supplies, so the pattern need not come from the repository owner.
     */
    const evil = `${'a*'.repeat(30)}b`
    const root = tree({
      [`${'a'.repeat(60)}c.md`]: CLEAN_TEXT,
      'ghostchars.json': configText([{ id: 'evil', bar: 'default', include: [evil] }]),
    })
    const started = Date.now()
    const result = check(root, ['--no-git', '--json'])
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.code).toBe(0)
    expect(payloadOf(result).filesScanned).toBe(0)
  })

  it('keeps the glob semantics the regular expression had', () => {
    // The matcher is a two-pointer algorithm now, not a translation to RegExp.
    // These are the shapes the old compiler went out of its way to produce.
    const root = tree({
      'vendor/deep/x.md': DEFAULT_BAR_DIRTY,
      'docs/a.md': DEFAULT_BAR_DIRTY,
      'docs/deep/b.md': DEFAULT_BAR_DIRTY,
      'src/aXb.ts': DEFAULT_BAR_DIRTY,
      'top.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([
        { id: 'all', bar: 'default', include: ['**/*'], exclude: ['vendor/**'] },
        { id: 'docs', bar: 'default', include: ['docs/**/*.md'] },
        { id: 'star', bar: 'default', include: ['src/a**b.ts'] },
      ]),
    })
    const payload = payloadOf(check(root, ['--no-git', '--json']))
    const failing = payload.failures.map((failure) => failure.path).sort()
    // `vendor/**` excludes the directory and everything under it. `**` is zero
    // or more segments, so `docs/**/*.md` claims `docs/a.md`. `a**b` inside one
    // segment is an ordinary run, so it claims `aXb.ts`.
    expect(failing).toEqual(['docs/a.md', 'docs/deep/b.md', 'src/aXb.ts', 'top.md'])
    const byPath = new Map(payload.failures.map((failure) => [failure.path, failure.surface]))
    expect(byPath.get('docs/a.md')).toBe('docs')
    expect(byPath.get('src/aXb.ts')).toBe('star')
    expect(byPath.get('top.md')).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// --fix
// ---------------------------------------------------------------------------

describe('--fix', () => {
  it('cleans the failing files and then passes', () => {
    const root = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY, 'docs/b.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--fix'])
    expect(result.code).toBe(0)
    expect(readTreeFile(root, 'docs/a.md')).toBe('onetwo\n')
    expect(result.stderr).toContain('ghostchars: cleaned 1 file')
    expect(result.stdout).toContain('2 files pass the default bar')
  })

  it('leaves a pinned file alone and names it', () => {
    const root = tree({
      'docs/plain.md': DEFAULT_BAR_DIRTY,
      'docs/glyphs.md': DEFAULT_BAR_DIRTY,
      'ghostchars.json': configText([
        { id: 'prose', bar: 'default', include: ['**/*.md'], pins: { 'docs/glyphs.md': 5 } },
      ]),
    })
    const result = check(root, ['--no-git', '--fix'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('docs/glyphs.md: pinned, left alone by --fix')
    expect(readTreeFile(root, 'docs/glyphs.md')).toBe(DEFAULT_BAR_DIRTY)
    expect(readTreeFile(root, 'docs/plain.md')).toBe('onetwo\n')
  })

  it('writes atomically, keeping the mode and leaving no temp file behind', () => {
    const root = tree({ 'script.sh': `echo one${ZWSP}two\n` })
    chmodSync(join(root, 'script.sh'), 0o755)
    const result = check(root, ['--no-git', '--fix'])
    expect(result.code).toBe(0)
    expect(statSync(join(root, 'script.sh')).mode & 0o777).toBe(0o755)
    const after = check(root, ['--no-git', '--json'])
    expect(payloadOf(after).filesScanned).toBe(1)
  })

  it('cannot fix a character typed as an escape, and still reports it', () => {
    const source = "export const dash = '\\u2014'\n"
    const root = tree({
      'src/messages.ts': source,
      'ghostchars.json': configText([
        { id: 'src', bar: 'text', include: ['**/*.ts'], decodeEscapes: true },
      ]),
    })
    const result = check(root, ['--no-git', '--fix'])
    expect(result.code).toBe(1)
    expect(readTreeFile(root, 'src/messages.ts')).toBe(source)
  })
})

// ---------------------------------------------------------------------------
// the JSON envelope
// ---------------------------------------------------------------------------

describe('--json', () => {
  it('prints exactly one object carrying the verdict and the counts', () => {
    const root = tree({ 'docs/a.md': TEXT_BAR_DIRTY, 'docs/b.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--bar', 'text', '--json'])
    expect(result.code).toBe(1)
    expect(result.stdout.trimEnd().split('\n').filter((line) => line === '}').length).toBe(1)

    const payload = payloadOf(result)
    expect(payload.ok).toBe(false)
    expect(payload.exitCode).toBe(1)
    expect(payload.discovery).toBe('walk')
    expect(payload.config).toBeNull()
    expect(payload.filesScanned).toBe(2)
    expect(payload.filesFailing).toBe(1)
    expect(payload.surfaces).toEqual([
      { id: 'all', bar: 'text', options: ['punct', 'spaces'], decodeEscapes: false, scanned: 2, failed: 1 },
    ])
    expect(payload.failures[0]?.hits[0]).toEqual({
      line: 1,
      col: 4,
      cp: 0x2014,
      u: 'U+2014',
      name: 'EM DASH',
      kind: 'punct',
      flag: '--punct',
      lineText: `one${EM_DASH}two`,
    })
  })

  it('caps the skipped list and says how many there really were', () => {
    const files: Record<string, string | Uint8Array> = { 'docs/a.md': CLEAN_TEXT }
    for (let i = 0; i < 60; i += 1) {
      files[`img/${String(i).padStart(3, '0')}.png`] = new Uint8Array([0x89, 0x50])
    }
    const root = tree(files)
    const payload = payloadOf(check(root, ['--no-git', '--json']))
    expect(payload.skippedTotal).toBe(60)
    expect(payload.skipped.length).toBe(50)
    expect(payload.skippedTruncated).toBe(true)
  })

  it('caps the positions listed for one file and keeps the true count', () => {
    const root = tree({ 'docs/a.md': `${ZWSP.repeat(30)}\n` })
    const payload = payloadOf(check(root, ['--no-git', '--limit', '5', '--json']))
    expect(payload.failures[0]?.changed).toBe(30)
    expect(payload.failures[0]?.hits.length).toBe(5)
  })

  it('names the config it used, absolutely', () => {
    const root = tree({
      'docs/a.md': CLEAN_TEXT,
      'ghostchars.json': configText([{ id: 'all', bar: 'default', include: ['**/*'] }]),
    })
    const payload = payloadOf(check(root, ['--no-git', '--json']))
    expect(payload.config).not.toBeNull()
    expect(payload.config?.endsWith('ghostchars.json')).toBe(true)
    expect(payload.root.length).toBeGreaterThan(0)
    expect(payload.config?.startsWith(payload.root)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// --verbose
// ---------------------------------------------------------------------------

describe('--verbose', () => {
  it('names the files that passed', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'docs/b.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--verbose'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('docs/a.md: passes the default bar')
    expect(result.stdout).toContain('docs/b.md: passes the default bar')
  })

  // The flag has to mean the same thing in both output modes. It once changed
  // the human listing only, so `check --verbose --json` and `check --json`
  // returned byte-identical payloads and a JSON consumer had no way to ask.
  it('lists the passing files in the JSON payload too', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'docs/b.md': CLEAN_TEXT })
    const payload = payloadOf(check(root, ['--no-git', '--verbose', '--json']))
    expect(payload.passed).toEqual([
      { path: 'docs/a.md', surface: 'all', bar: 'default' },
      { path: 'docs/b.md', surface: 'all', bar: 'default' },
    ])
    expect(payload.filesScanned).toBe(2)
  })

  it('omits the passing list entirely without --verbose', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT, 'docs/b.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--json'])
    expect(payloadOf(result).passed).toBeUndefined()
    // Absent, not an empty array: on a large repository this is the longest and
    // least interesting list in the payload, so it costs nothing until asked
    // for.
    expect(result.stdout).not.toContain('"passed"')
  })

  it('names the surface that claimed each passing file', () => {
    const root = tree({
      'docs/a.md': CLEAN_TEXT,
      'ghostchars.json': JSON.stringify({
        version: 1,
        surfaces: [{ id: 'prose', bar: 'text', include: ['**/*.md'] }],
      }),
    })
    const payload = payloadOf(check(root, ['--no-git', '--verbose', '--json']))
    expect(payload.passed).toEqual([{ path: 'docs/a.md', surface: 'prose', bar: 'text' }])
  })

  it('names the config that governed the run, which the human output never did', () => {
    // Which config was used decides every other number on the screen, and
    // `--json` was the only place that said. A person asking `--verbose` now
    // gets the same answer.
    const withConfig = tree({
      'docs/a.md': CLEAN_TEXT,
      'ghostchars.json': configText([{ id: 'prose', bar: 'text', include: ['**/*.md'] }]),
    })
    const named = check(withConfig, ['--no-git', '--verbose'])
    expect(named.stdout).toContain(
      `ghostchars: config ${join(realpathSync(withConfig), 'ghostchars.json')}`,
    )

    const without = tree({ 'docs/a.md': CLEAN_TEXT })
    const bare = check(without, ['--no-git', '--verbose'])
    expect(bare.stdout).toContain('no ghostchars.json found')
  })
})

// ---------------------------------------------------------------------------
// named paths
// ---------------------------------------------------------------------------

describe('path arguments', () => {
  it('checks a named file and walks a named directory', () => {
    const root = tree({
      'docs/a.md': DEFAULT_BAR_DIRTY,
      'docs/nested/b.md': DEFAULT_BAR_DIRTY,
      'other/c.md': DEFAULT_BAR_DIRTY,
    })
    const one = check(root, ['docs/a.md', '--json'])
    expect(one.code).toBe(1)
    expect(payloadOf(one).filesScanned).toBe(1)

    const directory = check(root, ['docs', '--json'])
    expect(directory.code).toBe(1)
    expect(payloadOf(directory).failures.map((failure) => failure.path)).toEqual([
      'docs/a.md',
      'docs/nested/b.md',
    ])
  })

  it('gates a named file outside the working directory instead of passing it unread', () => {
    const elsewhere = tree({ 'a.md': DEFAULT_BAR_DIRTY })
    const cwd = tree({ 'keep.md': CLEAN_TEXT })
    const result = check(cwd, ['--no-git', '--json', join(elsewhere, 'a.md')])
    expect(result.code).toBe(1)
    expect(payloadOf(result).filesScanned).toBe(1)
  })

  it('refuses a named file outside the root a config governs', () => {
    const elsewhere = tree({ 'a.md': DEFAULT_BAR_DIRTY })
    const cwd = tree({
      'ghostchars.json': configText([{ id: 'docs', bar: 'default', include: ['docs/**/*.md'] }]),
    })
    const result = check(cwd, ['--no-git', join(elsewhere, 'a.md')])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('path resolves outside the root')
  })

  it('checks a file named twice only once', () => {
    const root = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY })
    const payload = payloadOf(check(root, ['docs/a.md', 'docs/a.md', '--json']))
    expect(payload.filesScanned).toBe(1)
    expect(payload.failures.length).toBe(1)
  })

  it('creates no directories and writes nothing without --fix', () => {
    const root = tree({ 'docs/a.md': DEFAULT_BAR_DIRTY })
    const before = readTreeBytes(root, 'docs/a.md')
    expect(check(root, ['--no-git']).code).toBe(1)
    expect(readTreeBytes(root, 'docs/a.md')).toEqual(before)
    mkdirSync(join(root, 'empty'), { recursive: true })
    expect(check(root, ['--no-git']).code).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------

const SARIF = z.object({
  $schema: z.literal('https://json.schemastore.org/sarif-2.1.0.json'),
  version: z.literal('2.1.0'),
  runs: z.tuple([
    z.object({
      tool: z.object({
        driver: z.object({
          name: z.literal('ghostchars'),
          version: z.string(),
          informationUri: z.string().url(),
          rules: z.array(
            z.object({
              id: z.string(),
              shortDescription: z.object({ text: z.string() }),
              defaultConfiguration: z.object({ level: z.literal('error') }),
            }),
          ),
        }),
      }),
      originalUriBaseIds: z.object({ ROOT: z.object({ uri: z.string().startsWith('file://') }) }),
      results: z.array(
        z.object({
          ruleId: z.string(),
          level: z.literal('error'),
          message: z.object({ text: z.string() }),
          locations: z.tuple([
            z.object({
              physicalLocation: z.object({
                artifactLocation: z.object({ uri: z.string(), uriBaseId: z.literal('ROOT') }),
                region: z
                  .object({
                    startLine: z.number().int().positive(),
                    startColumn: z.number().int().positive(),
                    snippet: z.object({ text: z.string() }),
                  })
                  .optional(),
              }),
            }),
          ]),
          properties: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        }),
      ),
    }),
  ]),
})

describe('--sarif', () => {
  it('prints a SARIF 2.1.0 log with one result per hit, located by line and column', () => {
    const root = tree({
      'docs/a.md': CLEAN_TEXT,
      'docs/b.md': `first\nsecond${ZWSP}line\n`,
    })
    const result = check(root, ['--no-git', '--sarif'])
    expect(result.code).toBe(1)
    const log = SARIF.parse(JSON.parse(result.stdout))
    const run = log.runs[0]
    expect(run.results).toHaveLength(1)
    const only = run.results[0]
    expect(only?.ruleId).toBe('invisible')
    expect(only?.message.text).toContain('U+200B')
    const location = only?.locations[0].physicalLocation
    expect(location?.artifactLocation.uri).toBe('docs/b.md')
    expect(location?.region?.startLine).toBe(2)
    expect(location?.region?.startColumn).toBe(7)
    expect(location?.region?.snippet.text).toContain('second')
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(['invisible'])
    expect(run.originalUriBaseIds.ROOT.uri.endsWith('/')).toBe(true)
  })

  it('is an empty run when everything passes, and still exits 0', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--sarif'])
    expect(result.code).toBe(0)
    const log = SARIF.parse(JSON.parse(result.stdout))
    expect(log.runs[0].results).toEqual([])
    expect(log.runs[0].tool.driver.rules).toEqual([])
  })

  it('reports a pin failure as a result on the file with no region', () => {
    const root = tree({
      'docs/stale.md': CLEAN_TEXT,
      'ghostchars.json': configText([
        { id: 'prose', bar: 'text', include: ['**/*.md'], pins: { 'docs/stale.md': 3 } },
      ]),
    })
    const result = check(root, ['--no-git', '--sarif'])
    expect(result.code).toBe(1)
    const log = SARIF.parse(JSON.parse(result.stdout))
    const only = log.runs[0].results[0]
    expect(only?.ruleId).toBe('pin-stale')
    expect(only?.locations[0].physicalLocation.region).toBeUndefined()
    expect(log.runs[0].tool.driver.rules.map((rule) => rule.id)).toEqual(['pin-stale'])
  })

  it('refuses --json together with --sarif', () => {
    const root = tree({ 'docs/a.md': CLEAN_TEXT })
    const result = check(root, ['--no-git', '--json', '--sarif'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('--sarif')
  })
})
