/**
 * Every byte this package reads or writes goes through here.
 *
 * WHY ONE MODULE FOR TWO STREAMS. The MCP server speaks JSON-RPC on fd 1. If a
 * shared code path can reach stdout on its own, one stray line corrupts a whole
 * session, and the failure looks like a protocol bug rather than a print
 * statement. So nothing prints directly: commands call {@link out} and
 * {@link err}, and `serve()` calls {@link useStderrForOut} before it connects
 * the transport. `no-console: error` in the lint config closes the other door.
 *
 * WHY A STRICT DECODER, WITH `ignoreBOM`. Both halves are load-bearing.
 * `fatal: true` reproduces Python's `UnicodeDecodeError`, so a file that is not
 * text is reported rather than mangled into replacement characters.
 * `ignoreBOM: true` stops Node from silently swallowing a leading U+FEFF:
 * Python's `open(path, encoding='utf-8')` does not strip it (that is
 * `utf-8-sig`), and `strip_invisible.py --show` reports it as a finding at 1:1.
 * A missing `ignoreBOM` would make `--show` report zero findings on a BOM file,
 * make the `-c` delta off by one, and fail one whole class of golden fixture.
 *
 * WHY WRITES ARE ATOMIC. `strip_invisible.py` truncates in place, so a crash
 * mid-write leaves a half-written source file. `clean_file.py` is already
 * atomic for documents; making it uniform closes the gap for text, which
 * differs from the Python reference. An unchanged file is never opened for
 * writing at all, so its mtime and inode survive, exactly as they do in
 * Python.
 */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buffer } from 'node:stream/consumers'

import { UsageError } from './exit.js'
import * as strings from './strings.js'

// ---------------------------------------------------------------------------
// streams
// ---------------------------------------------------------------------------

/**
 * The real fd 1 by default. `serve()` repoints this at stderr so that a command
 * module reused by an MCP tool cannot write into the protocol stream.
 */
let outStream: NodeJS.WritableStream = process.stdout

/** Called once, by the MCP server, before the transport is connected. */
export function useStderrForOut(): void {
  outStream = process.stderr
}

/** True once the reader on the other end of stdout has gone away. */
let stdoutClosed = false

/**
 * `ghostchars inspect big.md | head` must behave like every other CLI: no
 * traceback, no error line, exit 0. This differs from the Python reference:
 * Python raises BrokenPipeError and exits 120; we exit 0 silently.
 */
function installEpipeGuard(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      stdoutClosed = true
      process.exitCode = 0
      process.exit(0)
    }
  })
}

installEpipeGuard()

/** Write to stdout (or, in MCP mode, to stderr). No newline is added. */
export function out(text: string): void {
  if (stdoutClosed) return
  outStream.write(text)
}

/** Write one line to stdout. */
export function outLine(text: string): void {
  out(`${text}\n`)
}

/** Write to stderr. No newline is added. */
export function err(text: string): void {
  process.stderr.write(text)
}

/** Write one line to stderr. Every diagnostic in this package goes here. */
export function errLine(text: string): void {
  err(`${text}\n`)
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/**
 * THE decoder. Every read in this package uses this exact configuration:
 * strict, and with the byte-order mark left in the text as a character.
 */
export function newDecoder(): InstanceType<typeof TextDecoder> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
}

/** Decode, or return null when the bytes are not UTF-8. Never throws. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return newDecoder().decode(bytes)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** The errno code of a thrown filesystem error, if it carries one. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** `{path}: {plain words}` for anything the filesystem refused. */
export function fileErrorMessage(path: string, error: unknown): string {
  return strings.errFile(path, strings.errnoMessage(errnoOf(error)))
}

/**
 * Read a file as text, printing the diagnostic and returning null on failure.
 *
 * The two failure modes are kept apart because they mean different things to
 * the caller: bytes that are not UTF-8 get Python's exact sentence, and an
 * unreadable path gets the errno in plain words. Both make the run exit 2.
 */
export function readTextFile(path: string): string | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    errLine(fileErrorMessage(path, error))
    return null
  }
  const text = decodeUtf8(bytes)
  if (text === null) {
    errLine(strings.errNotUtf8(path))
    return null
  }
  return text
}

/** Read a file as bytes. Returns null and prints, like {@link readTextFile}. */
export function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    errLine(fileErrorMessage(path, error))
    return null
  }
}

/**
 * Read all of stdin as text.
 *
 * Python never validates stdin's encoding: a bad byte there raises and the
 * interpreter prints a traceback. We report the same sentence a bad file gets
 * and exit 2, which is the only difference and is strictly more useful.
 */
export async function readStdin(label: string = strings.STDIN_LABEL): Promise<string> {
  const bytes = await buffer(process.stdin)
  const text = decodeUtf8(bytes)
  if (text === null) throw new UsageError(strings.errNotUtf8(label))
  return text
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** A temp name that cannot collide with a concurrent run in the same directory. */
function tempNameFor(path: string): string {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return join(dirname(path), `.${basename(path)}.ghostchars-${process.pid}-${random}.tmp`)
}

/**
 * Replace a file's contents atomically.
 *
 * A symlink is resolved first, so the target is rewritten rather than replaced
 * by a regular file. The destination's mode is copied onto the temp file before
 * the rename, so an executable script stays executable. The observable price of
 * atomicity is named in the README: the inode changes, a hard link breaks, and
 * a crash leaves a `.ghostchars-*.tmp` beside the file instead of a truncated
 * original.
 */
export function writeAtomic(path: string, text: string): void {
  writeAtomicBytes(path, encoder.encode(text))
}

/**
 * The same write, for content that is not text.
 *
 * A cleaned `.docx` or `.odt` is a zip archive. It cannot round-trip through a
 * JavaScript string, so {@link writeAtomic} cannot carry it: that function's
 * whole job is to encode UTF-8, and re-encoding an archive would corrupt every
 * deflated entry. Both spellings are here rather than one in `io.ts` and a
 * second copy inside the document branch of `clean`, because there must be
 * exactly one implementation of "replace a file safely" in this package. This
 * is it; `writeAtomic` is a two-line wrapper over it.
 */
export function writeAtomicBytes(path: string, bytes: Uint8Array): void {
  const target = resolveSymlink(path)
  const temp = tempNameFor(target)
  let handle: number | undefined
  try {
    handle = openSync(temp, 'wx', 0o600)
    let written = 0
    while (written < bytes.length) written += writeSync(handle, bytes, written)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    copyMode(target, temp)
    renameSync(temp, target)
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // The write already failed; a close failure adds nothing.
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may never have been created.
    }
    throw error
  }
}

function resolveSymlink(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch {
    // A path that does not exist yet is written where it was asked for.
  }
  return path
}

function copyMode(target: string, temp: string): void {
  try {
    chmodSync(temp, statSync(target).mode)
  } catch {
    // The destination does not exist yet, so the default mode is correct.
  }
}
