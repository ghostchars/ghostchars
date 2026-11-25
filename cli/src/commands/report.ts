/**
 * `report`: the prose-habit measurement, in two renders.
 *
 * WHAT THIS COMMAND IS NOT. It measures habits that make a draft read as
 * machine written. It does not decide who or what wrote a text, it emits no
 * probability and no score, and every string it prints says so in those words.
 *
 * THE HUMAN RENDER IS ASCII. THIS DIFFERS FROM THE PYTHON REFERENCE:
 * `style_report.py` separates the head line with a middle dot, prints the
 * sentence-length range with an en dash and joins a tell to its count with a
 * multiplication sign. We print `, `, ` to ` and `x`. Measured: of those three
 * only the en dash would be changed by our own maximum clean, and going fully
 * ASCII anyway keeps `src/strings.ts` at zero hygiene pins and the shipped
 * bundles at zero bytes above 0x7F. Byte parity for `report` lives in `--json`,
 * where a consumer can actually diff it.
 *
 * ONE THING THAT MUST NOT BE FLATTENED: an observation's `detail` comes from
 * the engine and carries the engine's own U+00D7 inside its `word x count`
 * lists. That is data, not our format string, it survives the maximum clean,
 * and rewriting it would break `--json` parity. It is printed exactly as the
 * engine produced it.
 *
 * `--json` IS BYTE-IDENTICAL TO `python3 style_report.py --json`, which is why
 * every number goes through `src/pyjson.ts` and none through `JSON.stringify`.
 * See the header of `src/pyjson.ts` for the int-versus-float trap it exists
 * to solve.
 *
 * TWO DELIBERATE DIVERGENCES BEYOND THE RENDER. `style_report.py` has no
 * nonzero exit at all, so `--fail-on` defaults to `none` and parity is
 * preserved by default while CI still gets a knob. This differs from the
 * Python reference: a file that cannot be read exits 2 rather than 0, because
 * a CLI that could not read a file the user named must not report success.
 */
import { analyzeStyle } from '@ghostchars/engine/style'

import type { ParsedCommand } from '../args.js'
import { EXIT_FINDINGS, EXIT_USAGE, ExitAccumulator, UsageError } from '../exit.js'
import { styleBlock } from '../format.js'
import { out, outLine, readStdin, readTextFile } from '../io.js'
import type { StyleResult } from '../pyjson.js'
import { stringifyStyleJson } from '../pyjson.js'
import * as strings from '../strings.js'

/** `--fail-on`, lowest to highest. `none` is the default and never fails. */
const FAIL_ON_LEVELS = ['none', 'low', 'medium', 'high'] as const

type FailOn = (typeof FAIL_ON_LEVELS)[number]

/** One rank per severity, so "this severity or higher" is a comparison. */
const RANK: Readonly<Record<string, number>> = { none: 0, low: 1, medium: 2, high: 3 }

function isFailOn(value: string): value is FailOn {
  return FAIL_ON_LEVELS.some((level) => level === value)
}

function readFailOn(parsed: ParsedCommand): FailOn {
  const raw = parsed.values.string('--fail-on')
  if (raw === undefined) return 'none'
  if (!isFailOn(raw)) throw new UsageError(strings.errBadFailOn(raw))
  return raw
}

/**
 * Python keys its results by label in a dict, so naming the same file twice
 * yields ONE entry and the payload is therefore unwrapped rather than wrapped.
 * A `Map` reproduces that exactly: `set` on an existing key replaces the value
 * and keeps the original insertion position. The human render still prints one
 * block per argument, because Python's render loop runs per file, not per
 * result.
 */
function byLabel(results: readonly StyleResult[]): StyleResult[] {
  const unique = new Map<string, StyleResult>()
  for (const result of results) unique.set(result.label, result)
  return [...unique.values()]
}

/** True when any observation is at `threshold` or above. */
function reachesThreshold(results: readonly StyleResult[], threshold: FailOn): boolean {
  const wanted = RANK[threshold] ?? 0
  if (wanted === 0) return false
  return results.some((result) =>
    result.report.observations.some((observation) => (RANK[observation.severity] ?? 0) >= wanted),
  )
}

export async function run(parsed: ParsedCommand): Promise<number> {
  const failOn = readFailOn(parsed)
  const asJson = parsed.values.bool('--json')
  const paths = parsed.positionals
  const exit = new ExitAccumulator()

  const results: StyleResult[] = []
  if (paths.length === 0) {
    const label = parsed.values.string('--stdin-name') ?? strings.STDIN_LABEL
    const text = await readStdin(label)
    results.push({ label, text, report: analyzeStyle(text) })
  } else {
    for (const path of paths) {
      // `readTextFile` has already printed `{path}: {message}` on stderr.
      const text = readTextFile(path)
      if (text === null) {
        exit.add(EXIT_USAGE)
        continue
      }
      results.push({ label: path, text, report: analyzeStyle(text) })
    }
  }

  if (asJson) {
    out(stringifyStyleJson(byLabel(results)))
  } else {
    for (const result of results) {
      for (const line of styleBlock(result.label, result.text, result.report)) outLine(line)
      // Python prints a blank line inside the loop when it was given more than
      // one FILE ARGUMENT, so the last block is followed by one too.
      if (paths.length > 1) outLine('')
    }
  }

  // Added last, and through the accumulator, so a file that could not be read
  // still reports 2: the priority is 3 beats 2 beats 1 beats 0, always.
  if (reachesThreshold(results, failOn)) exit.add(EXIT_FINDINGS)
  return exit.code
}
