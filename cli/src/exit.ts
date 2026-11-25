/**
 * Exit codes, and the one rule that keeps them predictable across inputs.
 *
 * WHY A PRIORITY, NOT A LAST-WRITER-WINS. `strip_invisible.py` accumulates a
 * `failed` flag and a `found` flag across every file it was given and reports
 * `failed` first: a file that could not be decoded forces 2 even when another
 * file had findings. Every command here does the same, so a run over ten files
 * reports the worst thing that happened rather than the last.
 *
 * 3 beats 2 beats 1 beats 0, which is numeric maximum, and {@link worst} says
 * so once instead of every command open-coding it.
 */

/** Done, nothing to report. */
export const EXIT_OK = 0
/** Findings, would-change, or gate failure. */
export const EXIT_FINDINGS = 1
/** The run could not be completed as asked. */
export const EXIT_USAGE = 2
/** Internal error. A ghostchars bug. */
export const EXIT_INTERNAL = 3

export const EXIT_CODES = [EXIT_OK, EXIT_FINDINGS, EXIT_USAGE, EXIT_INTERNAL] as const

export type ExitCode = (typeof EXIT_CODES)[number]

/**
 * The worse of two outcomes, by the fixed priority 3 > 2 > 1 > 0.
 *
 * Written as a switch rather than `Math.max` so the ordering is stated, not
 * inferred from the numbers, and so the return type stays {@link ExitCode}
 * without a cast (this package forbids `as`).
 */
export function worst(a: ExitCode, b: ExitCode): ExitCode {
  if (a === EXIT_INTERNAL || b === EXIT_INTERNAL) return EXIT_INTERNAL
  if (a === EXIT_USAGE || b === EXIT_USAGE) return EXIT_USAGE
  if (a === EXIT_FINDINGS || b === EXIT_FINDINGS) return EXIT_FINDINGS
  return EXIT_OK
}

/**
 * An accumulator for a command that walks several inputs.
 *
 * ```ts
 * const exit = new ExitAccumulator()
 * for (const path of paths) exit.add(handle(path))
 * return exit.code
 * ```
 */
export class ExitAccumulator {
  #code: ExitCode = EXIT_OK

  add(code: ExitCode): void {
    this.#code = worst(this.#code, code)
  }

  get code(): ExitCode {
    return this.#code
  }
}

/**
 * A message the user needs to read and act on, with no stack trace attached.
 *
 * `src/cli.ts` prints `message` to stderr and returns {@link EXIT_USAGE}. Every
 * other throw becomes {@link EXIT_INTERNAL} with the "this is a bug" line, so
 * an agent can tell "I passed the wrong flag" from "the tool broke" without
 * reading prose. Throw this for a usage error, a bad config, an unreadable
 * document: anything the caller can fix by changing the command.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError'

  constructor(message: string) {
    super(message)
  }
}
