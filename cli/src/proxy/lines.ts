/**
 * Newline framing for the MCP stdio transport, on raw bytes.
 *
 * The transport is one JSON-RPC message per line, UTF-8, separated by `\n`.
 * Splitting happens on bytes rather than on decoded text so that a multi-byte
 * character cut in two by a pipe read is never decoded half at a time, and so a
 * line can be forwarded as exactly the bytes that arrived.
 *
 * A long line costs one concatenation when its newline arrives, not one per
 * chunk: the pieces are kept in a list until then. That is what keeps an
 * eight-megabyte tool result linear rather than quadratic.
 */
const NEWLINE = 0x0a

export class LineSplitter {
  readonly #onLine: (line: Buffer) => void
  #pending: Buffer[] = []

  /** `onLine` receives each line without its `\n`, a trailing `\r` included. */
  constructor(onLine: (line: Buffer) => void) {
    this.#onLine = onLine
  }

  push(chunk: Buffer): void {
    let from = 0
    let at = chunk.indexOf(NEWLINE, from)
    while (at !== -1) {
      const piece = chunk.subarray(from, at)
      if (this.#pending.length === 0) this.#onLine(piece)
      else {
        this.#pending.push(piece)
        const line = Buffer.concat(this.#pending)
        this.#pending = []
        this.#onLine(line)
      }
      from = at + 1
      at = chunk.indexOf(NEWLINE, from)
    }
    if (from < chunk.length) this.#pending.push(chunk.subarray(from))
  }

  /** The bytes after the last newline, if any, then nothing more. */
  flush(): Buffer | null {
    if (this.#pending.length === 0) return null
    const rest = Buffer.concat(this.#pending)
    this.#pending = []
    return rest
  }
}
