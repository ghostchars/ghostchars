/**
 * `canary embed` and `canary detect`: per-recipient invisible marks.
 *
 * `embed` puts a recipient id into a text as zero-width characters, repeated
 * through it, so a copy that leaks names whoever it was sent to. `detect` reads
 * the id back. With a key the mark carries a truncated HMAC, so only the key
 * holder can make a mark that verifies. The engine's `canary` module is the
 * whole format; this file only reads input, resolves the key and prints.
 *
 * WHAT A MARK IS NOT. Any hidden-character cleaner removes it, `ghostchars
 * clean` first among them. It traces a forwarded or pasted copy; it does not
 * survive retyping, rewording or a cleaner, and the help and README say so.
 *
 * KEYS NEVER COME FROM ARGV. A process listing shows every argument, so the key
 * is read from a file (`--key-file`, trailing line breaks dropped) or from an
 * environment variable named by `--key-env`.
 *
 * EXIT CODES. `embed`: 0 written, 2 could not mark as asked. `detect`: 0 when a
 * mark was found that is not rejected, 1 when none was, 2 when the input or the
 * key could not be read. Detection succeeding is the 0, as with grep.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { CanaryError, canaryIdError, detectCanary, embedCanary, escapeMessage, findCanaryMarks } from '@ghostchars/engine'
import type { CanaryResult } from '@ghostchars/engine'

import type { ParsedCommand } from '../args.js'
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, UsageError } from '../exit.js'
import { baseEnvelope, serializeJson } from '../json.js'
import { fileErrorMessage, out, outLine, readStdin, readTextFile, writeAtomic } from '../io.js'
import * as strings from '../strings.js'

type Action = (typeof strings.CANARY_ACTIONS)[number]

function readAction(value: string | undefined): Action {
  const action = strings.CANARY_ACTIONS.find((name) => name === value)
  if (action === undefined) throw new UsageError(strings.errCanaryAction(value))
  return action
}

/** The key as bytes, from `--key-file` or `--key-env`, or `null` for none. */
function readKey(parsed: ParsedCommand): Uint8Array | null {
  const file = parsed.values.string('--key-file')
  const env = parsed.values.string('--key-env')
  if (file !== undefined && env !== undefined) throw new UsageError(strings.ERR_CANARY_TWO_KEYS)
  if (file === '') throw new UsageError(strings.errNeedsValue('--key-file'))
  if (env === '') throw new UsageError(strings.errNeedsValue('--key-env'))
  if (file !== undefined) {
    let bytes: Buffer
    try {
      bytes = readFileSync(file)
    } catch (error) {
      throw new UsageError(fileErrorMessage(file, error))
    }
    let end = bytes.length
    while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1
    if (end === 0) throw new UsageError(strings.errCanaryKeyFileEmpty(file))
    return new Uint8Array(bytes.subarray(0, end))
  }
  if (env !== undefined) {
    const value = process.env[env]
    if (value === undefined || value === '') throw new UsageError(strings.errCanaryKeyEnvUnset(env))
    return new TextEncoder().encode(value)
  }
  return null
}

interface Input {
  readonly label: string
  readonly path: string | null
  readonly text: string
}

/**
 * The one input: a file, or stdin when none is named. `null` when the file
 * could not be read, after `readTextFile` has printed why on stderr.
 */
async function readInput(parsed: ParsedCommand): Promise<Input | null> {
  const files = parsed.positionals.slice(1)
  if (files.length > 1) throw new UsageError(strings.ERR_CANARY_ONE_FILE)
  const path = files[0]
  if (path === undefined) {
    const label = parsed.values.string('--stdin-name') ?? strings.STDIN_LABEL
    return { label, path: null, text: await readStdin(label) }
  }
  const text = readTextFile(path)
  return text === null ? null : { label: path, path, text }
}

/**
 * The ids of an `--ids` file: one per line, trimmed, blanks and `#` lines
 * skipped. `null` when the file could not be read, as for {@link readInput}.
 */
function readIds(path: string): string[] | null {
  const text = readTextFile(path)
  if (text === null) return null
  const ids: string[] = []
  const firstLine = new Map<string, number>()
  text.split('\n').forEach((raw, index) => {
    const line = index + 1
    const id = raw.trim()
    if (id === '' || id.startsWith('#')) return
    const reason = canaryIdError(id)
    if (reason !== null) throw new UsageError(strings.errCanaryBadIdLine(path, line, reason))
    const first = firstLine.get(id)
    if (first !== undefined) throw new UsageError(strings.errCanaryDuplicateId(path, line, first))
    firstLine.set(id, line)
    ids.push(id)
  })
  if (ids.length === 0) throw new UsageError(strings.errCanaryNoIds(path))
  return ids
}

/** A file-name-safe form of an id: letters, digits, dot, dash and underscore. */
function slugOf(id: string): string {
  const slug = id
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^[._]+/u, '')
    .slice(0, 64)
  return slug === '' ? 'id' : slug
}

/** One output name per id, unique even when two ids share a slug. */
function outputNames(ids: readonly string[], inputPath: string | null): string[] {
  const source = inputPath === null ? 'marked.txt' : basename(inputPath)
  const ext = extname(source)
  const stem = ext === '' ? source : source.slice(0, -ext.length)
  const used = new Set<string>()
  return ids.map((id) => {
    const slug = slugOf(id)
    let name = `${stem}.${slug}${ext}`
    for (let n = 2; used.has(name); n += 1) name = `${stem}.${slug}-${String(n)}${ext}`
    used.add(name)
    return name
  })
}

function mark(label: string, text: string, id: string, key: Uint8Array | null): string {
  try {
    return embedCanary(text, id, key)
  } catch (error) {
    if (error instanceof CanaryError) {
      const reason = canaryIdError(id)
      throw new UsageError(
        reason === null
          ? strings.errCanaryCannotMark(label, error.message)
          : strings.errCanaryBadId(escapeMessage(id), reason),
      )
    }
    throw error
  }
}

async function embed(parsed: ParsedCommand, key: Uint8Array | null): Promise<number> {
  const id = parsed.values.string('--id')
  const idsPath = parsed.values.string('--ids')
  const outDir = parsed.values.string('--out-dir')
  if ((id === undefined) === (idsPath === undefined)) throw new UsageError(strings.ERR_CANARY_ID_OR_IDS)
  if (idsPath !== undefined && (outDir === undefined || outDir === '')) {
    throw new UsageError(strings.ERR_CANARY_IDS_NEED_OUT_DIR)
  }
  if (id !== undefined && outDir !== undefined) throw new UsageError(strings.ERR_CANARY_OUT_DIR_NEEDS_IDS)
  const asJson = parsed.values.bool('--json')

  if (id !== undefined) {
    const reason = canaryIdError(id)
    if (reason !== null) throw new UsageError(strings.errCanaryBadId(escapeMessage(id), reason))
    const input = await readInput(parsed)
    if (input === null) return EXIT_USAGE
    const marked = mark(input.label, input.text, id, key)
    if (asJson) {
      out(
        serializeJson({
          ...baseEnvelope('canary', EXIT_OK),
          action: 'embed',
          id,
          keyed: key !== null,
          copies: findCanaryMarks(marked).length,
          text: marked,
        }),
      )
    } else {
      out(marked)
    }
    return EXIT_OK
  }

  // Every id is read and checked before the first file is written, so a bad
  // line leaves the output directory as it was.
  const ids = readIds(idsPath ?? '')
  if (ids === null) return EXIT_USAGE
  const input = await readInput(parsed)
  if (input === null) return EXIT_USAGE
  const dir = outDir ?? ''
  const copies = ids.map((each) => mark(input.label, input.text, each, key))
  const names = outputNames(ids, input.path)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new UsageError(fileErrorMessage(dir, error))
  }
  const files: { id: string; path: string; copies: number }[] = []
  ids.forEach((each, index) => {
    const path = join(dir, names[index] ?? '')
    const text = copies[index] ?? ''
    try {
      writeAtomic(path, text)
    } catch (error) {
      throw new UsageError(fileErrorMessage(path, error))
    }
    files.push({ id: each, path, copies: findCanaryMarks(text).length })
  })
  if (asJson) {
    out(serializeJson({ ...baseEnvelope('canary', EXIT_OK), action: 'embed', keyed: key !== null, files }))
  } else {
    for (const file of files) outLine(strings.canaryWrote(file.path, escapeMessage(file.id), file.copies))
  }
  return EXIT_OK
}

async function detect(parsed: ParsedCommand, key: Uint8Array | null): Promise<number> {
  for (const flag of ['--id', '--ids', '--out-dir']) {
    if (parsed.values.string(flag) !== undefined) throw new UsageError(strings.errCanaryNotForDetect(flag))
  }
  const input = await readInput(parsed)
  if (input === null) return EXIT_USAGE
  const marks: CanaryResult[] = detectCanary(input.text, key)
  const found = marks.some((m) => m.status !== 'rejected')
  const code = found ? EXIT_OK : EXIT_FINDINGS
  if (parsed.values.bool('--json')) {
    out(
      serializeJson({
        ...baseEnvelope('canary', code),
        action: 'detect',
        label: input.label,
        keyGiven: key !== null,
        found,
        marks,
      }),
    )
    return code
  }
  if (marks.length === 0) outLine(strings.canaryNone(input.label))
  for (const m of marks) outLine(strings.canaryFound(input.label, escapeMessage(m.id), m.status, m.count))
  return code
}

export async function run(parsed: ParsedCommand): Promise<number> {
  const action = readAction(parsed.positionals[0])
  const key = readKey(parsed)
  return action === 'embed' ? await embed(parsed, key) : await detect(parsed, key)
}
