/**
 * The four-gate text detection, cheapest test first.
 *
 * WHY A GATE NEEDS THIS AT ALL. A tool that walks a repository meets PNG files,
 * font binaries and zip archives. One that reports every one of them as an
 * error is unusable and gets deleted; one that silently swallows a text file it
 * could not decode hides the exact problem it exists to find. So discovered
 * non-text is skipped in silence and a file NAMED on the command line that
 * fails to decode is an error, because naming it was an assertion that it is
 * text.
 *
 * THE FOUR GATES, IN ORDER.
 *
 * 1. Extension. Free, needs no syscall, and settles the common case.
 * 2. Size. One stat. A source file larger than the cap is not prose.
 * 3. A NUL byte in the first 8 KiB. The oldest and still the best heuristic:
 *    no UTF-8 text file has one and almost every binary does, near the front.
 * 4. A strict UTF-8 decode. The last word, and the expensive one.
 *
 * `.docx` and `.odt` are on the extension list on purpose. Documents are in
 * scope for `clean` and `inspect` and deliberately out of scope for the gate: a
 * gate walking a repository must not open zip archives.
 */
import { extname } from 'node:path'

/**
 * Extensions that are never text. Lower case, without the dot, matched against
 * the path's own extension case-insensitively.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'docx',
  'odt',
  'xlsx',
  'pptx',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp4',
  'mov',
  'mp3',
  'wav',
  'so',
  'dylib',
  'dll',
  'exe',
  'wasm',
])

/** How far into a file the NUL scan looks. */
export const NUL_SCAN_BYTES = 8192

/** True when the path's extension is one nothing text-shaped ever carries. */
export function hasBinaryExtension(path: string): boolean {
  const extension = extname(path)
  if (extension.length < 2) return false
  return BINARY_EXTENSIONS.has(extension.slice(1).toLowerCase())
}

/** True when a NUL byte appears in the first {@link NUL_SCAN_BYTES} bytes. */
export function hasNulByte(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, NUL_SCAN_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}
