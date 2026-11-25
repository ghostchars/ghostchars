/**
 * `ghostchars canary embed` and `canary detect`, through the built binary.
 *
 * The format itself is pinned by the engine's parity test against
 * `canary.py`; these tests pin what the command adds: where the key comes
 * from, the batch form, the exit codes, the JSON, and that `clean` removes
 * what `embed` put in.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { requireBuild, runCli } from './helpers/run.js'
import { makeTree, removeTree } from './helpers/tree.js'

const MEMO =
  'Quarterly plan: revenue is up and the launch moves to May. Keep this draft internal until the board meets next week.\n'
const ZERO_WIDTH = /[\u200b\u200c]/gu

const trees: string[] = []
afterEach(() => {
  for (const root of trees.splice(0)) removeTree(root)
})

function tree(files: Readonly<Record<string, string>>): string {
  const root = makeTree(files)
  trees.push(root)
  return root
}

const DETECT_JSON = z.object({
  tool: z.literal('ghostchars'),
  command: z.literal('canary'),
  ok: z.boolean(),
  exitCode: z.number().int(),
  action: z.literal('detect'),
  label: z.string(),
  keyGiven: z.boolean(),
  found: z.boolean(),
  marks: z.array(
    z.object({
      id: z.string(),
      keyed: z.boolean(),
      status: z.enum(['unkeyed', 'verified', 'unverified', 'rejected']),
      count: z.number().int(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  ),
})

describe('canary embed', () => {
  requireBuild()

  it('writes the marked text to stdout, and detect reads the id back', () => {
    const embedded = runCli(['canary', 'embed', '--id', 'alice'], { input: MEMO })
    expect(embedded.code).toBe(0)
    expect(embedded.stderr).toBe('')
    expect(embedded.stdout.replace(ZERO_WIDTH, '')).toBe(MEMO)
    const detected = runCli(['canary', 'detect'], { input: embedded.stdout })
    expect(detected.code).toBe(0)
    expect(detected.stdout).toBe(
      "<stdin>: marked for 'alice', 3 copies, unkeyed: anyone could have written this mark\n",
    )
  })

  it('matches the Python reference byte for byte', () => {
    const goldenPath = fileURLToPath(new URL('../../web/src/engine/__fixtures__/golden.json', import.meta.url))
    const golden = z
      .object({
        canary: z.object({
          embed: z.array(z.object({ text: z.string(), markId: z.string(), key: z.string().nullable(), marked: z.string() })),
        }),
      })
      .parse(JSON.parse(readFileSync(goldenPath, 'utf8')))
    for (const c of golden.canary.embed) {
      const root = tree(c.key === null ? {} : { key: c.key })
      const keyArgs = c.key === null ? [] : ['--key-file', join(root, 'key')]
      const result = runCli(['canary', 'embed', '--id', c.markId, ...keyArgs], { input: c.text })
      expect(result.stdout).toBe(c.marked)
    }
  })

  it('is removed by clean, which gives back the original bytes', () => {
    const marked = runCli(['canary', 'embed', '--id', 'alice'], { input: MEMO }).stdout
    const cleaned = runCli(['clean'], { input: marked })
    expect(cleaned.stdout).toBe(MEMO)
    expect(runCli(['canary', 'detect'], { input: cleaned.stdout }).code).toBe(1)
  })

  it('shows up in inspect as a hidden message with the canary scheme', () => {
    const marked = runCli(['canary', 'embed', '--id', 'alice'], { input: 'One two three.' }).stdout
    const result = runCli(['inspect'], { input: marked })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('Hidden message found: canary at 1:1 to 1:96, 96 bits\n    alice\n')
  })

  it('reads a key from a file, dropping the trailing line break, or from the environment', () => {
    const root = tree({ 'memo.txt': MEMO, key: 'k3y\n' })
    const marked = runCli(['canary', 'embed', '--id', 'bob', '--key-file', join(root, 'key'), join(root, 'memo.txt')])
    expect(marked.code).toBe(0)
    const verified = runCli(['canary', 'detect', '--key-env', 'CANARY_TEST_KEY'], {
      input: marked.stdout,
      env: { CANARY_TEST_KEY: 'k3y' },
    })
    expect(verified.stdout).toContain("marked for 'bob', 3 copies, verified with your key")
    expect(verified.code).toBe(0)
  })

  it('writes one marked copy per id with --ids, checking every id first', () => {
    const root = tree({
      'memo.txt': MEMO,
      ids: '# recipients\nalice\n\nbob@example.com\n  carol  \n',
      bad: 'alice\nalice\n',
    })
    const out = join(root, 'out')
    const result = runCli(['canary', 'embed', '--ids', join(root, 'ids'), '--out-dir', out, join(root, 'memo.txt')])
    expect(result.code).toBe(0)
    expect(readdirSync(out).sort()).toEqual(['memo.alice.txt', 'memo.bob_example.com.txt', 'memo.carol.txt'])
    for (const [name, id] of [
      ['memo.alice.txt', 'alice'],
      ['memo.bob_example.com.txt', 'bob@example.com'],
      ['memo.carol.txt', 'carol'],
    ] as const) {
      const text = readFileSync(join(out, name), 'utf8')
      expect(text.replace(ZERO_WIDTH, '')).toBe(MEMO)
      const detected = DETECT_JSON.parse(JSON.parse(runCli(['canary', 'detect', '--json'], { input: text }).stdout))
      expect(detected.marks.map((m) => m.id)).toEqual([id])
    }
    const dup = runCli(['canary', 'embed', '--ids', join(root, 'bad'), '--out-dir', join(root, 'dup'), join(root, 'memo.txt')])
    expect(dup.code).toBe(2)
    expect(dup.stderr).toContain(':2: the same id as line 1')
    expect(() => readdirSync(join(root, 'dup'))).toThrow()
  })
})

describe('canary detect', () => {
  it('exits 1 with no mark, and says so', () => {
    const result = runCli(['canary', 'detect', '--stdin-name', 'memo'], { input: MEMO })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('memo: no mark found\n')
  })

  it('rejects a keyed mark under the wrong key, and exits 1', () => {
    const root = tree({ right: 'right', wrong: 'wrong' })
    const marked = runCli(['canary', 'embed', '--id', 'bob', '--key-file', join(root, 'right')], { input: MEMO }).stdout
    const result = runCli(['canary', 'detect', '--json', '--key-file', join(root, 'wrong')], { input: marked })
    expect(result.code).toBe(1)
    const parsed = DETECT_JSON.parse(JSON.parse(result.stdout))
    expect(parsed).toMatchObject({ ok: false, exitCode: 1, found: false, keyGiven: true })
    expect(parsed.marks.map((m) => m.status)).toEqual(['rejected'])
    const unverified = DETECT_JSON.parse(JSON.parse(runCli(['canary', 'detect', '--json'], { input: marked }).stdout))
    expect(unverified.marks.map((m) => m.status)).toEqual(['unverified'])
  })
})

describe('canary usage errors', () => {
  it.each([
    [['canary'], 'canary needs an action, embed or detect'],
    [['canary', 'mark'], "Got 'mark'"],
    [['canary', 'embed'], 'needs --id <id> or --ids <file>'],
    [['canary', 'embed', '--id', 'a', '--ids', 'x'], 'needs --id <id> or --ids <file>'],
    [['canary', 'embed', '--ids', 'x'], 'needs --out-dir <dir>'],
    [['canary', 'embed', '--id', 'a', '--out-dir', 'x'], '--out-dir is for --ids'],
    [['canary', 'detect', '--id', 'a'], '--id is for canary embed'],
    [['canary', 'embed', '--id', 'a', '--key-file', 'k', '--key-env', 'K'], '--key-file or --key-env, not both'],
    [['canary', 'embed', '--id', 'a', '--key-env', 'GHOSTCHARS_TEST_UNSET_KEY'], 'GHOSTCHARS_TEST_UNSET_KEY is not set'],
    [['canary', 'embed', '--id', 'a\u200bb'], 'the id contains a hidden or special character'],
    [['canary', 'embed', '--id', 'x'.repeat(65)], 'longer than 64 bytes'],
    [['canary', 'embed', '--key', 'secret'], 'unknown flag --key'],
  ])('%j', (args, message) => {
    const result = runCli(args, { input: MEMO })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stdout).toBe('')
  })

  it('refuses an empty key file and a text with no word', () => {
    const root = tree({ empty: '\n' })
    const empty = runCli(['canary', 'embed', '--id', 'a', '--key-file', join(root, 'empty')], { input: MEMO })
    expect(empty.code).toBe(2)
    expect(empty.stderr).toContain('the key file is empty')
    const blank = runCli(['canary', 'embed', '--id', 'a'], { input: '  \n' })
    expect(blank.code).toBe(2)
    expect(blank.stderr).toContain('<stdin>: cannot be marked: the text has no word to put a mark in front of')
  })

  it('reports an unreadable file once and exits 2', () => {
    const result = runCli(['canary', 'detect', '/nonexistent/ghostchars-canary.txt'])
    expect(result.code).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })
})
