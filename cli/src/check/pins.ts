/**
 * Pins, enforced in both directions.
 *
 * A pin says "this file changes exactly N characters under this bar, and that
 * is deliberate". Most gates enforce one direction: they let a pinned file
 * through. This one enforces both, and the second direction is the reason to
 * copy this design rather than invent one.
 *
 * | Pinned      | Measured   | Result                                        |
 * |-------------|------------|-----------------------------------------------|
 * | 0 (absent)  | 0          | pass, silently                                |
 * | 0 (absent)  | N > 0      | FAIL `changed`, every character listed         |
 * | N           | N          | pass                                          |
 * | N           | M, not N   | FAIL `pin-mismatch`                           |
 * | N > 0       | 0          | FAIL `pin-stale`                              |
 *
 * The last row is the one people forget. Somebody quietly fixes the fixture the
 * pin was protecting, the pin stays, and from then on the file is exempt from a
 * gate it no longer needs. Failing on a stale pin is what keeps a pin list
 * honest over years rather than weeks.
 *
 * WHAT "MEASURED" MEANS. The count of findings whose action under the bar is
 * `removed` or `replaced`. It is equal to the character count the repository's
 * own Python gate computes with `difflib`, for every golden fixture across both
 * bars, which is what `test/parity.gate.test.ts` proves and what makes a pin
 * number interchangeable between the two tools.
 */
import type { CheckStatus } from '../json.js'

/** What the gate decided about one file, before anything is printed. */
export type PinVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: CheckStatus }

/**
 * The whole table above, in one function.
 *
 * `wouldChange` is `cleanText(text, options) !== text`, and it, not the count,
 * is the pass or fail decision. The two agree on every input we can measure;
 * where they ever disagreed, the file would still be reported as changed, so
 * the gate can never pass a file the cleaner would rewrite.
 */
export function verdictFor(pinned: number, measured: number, wouldChange: boolean): PinVerdict {
  const clean = !wouldChange && measured === 0
  if (pinned === 0) return clean ? { ok: true } : { ok: false, status: 'changed' }
  if (clean) return { ok: false, status: 'pin-stale' }
  return measured === pinned ? { ok: true } : { ok: false, status: 'pin-mismatch' }
}

/** The pin recorded for a repository-relative path, or zero when there is none. */
export function pinFor(pins: Readonly<Record<string, number>>, relative: string): number {
  return pins[relative] ?? 0
}
