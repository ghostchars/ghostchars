/**
 * The Unicode name column, and the one table the engine does not carry.
 *
 * WHY THIS FILE EXISTS. `inspect` reproduces `strip_invisible.py --show` byte
 * for byte, and the last column of a finding row is the character's Unicode
 * name. The engine's `nameOf()` reads a table generated for what the engine
 * CLASSIFIES: the cleaner's own tables, every Cf and Co codepoint, every
 * codepoint in the golden fixtures. The look-alike table is not in that set, so
 * 1500 of its 1508 nameable source codepoints came out as `U+0440` where the
 * reference prints CYRILLIC SMALL LETTER ER.
 *
 * WHY THE FIX IS LOCAL AND NOT IN THE ENGINE. The same 1500 names cost 69 kB of
 * source and 10 kB gzip in `web/src/engine/unicode-names.ts`, which is on the
 * critical path of every page of the web build, to widen a column that only
 * this CLI prints. Here there is nothing to download and no budget: the
 * table is bundled into `dist/main.js` and `dist/mcp.js` and read only when the
 * engine has no name. The engine and the web bundle are untouched, and the
 * names are identical either way, which `test/parity.names.test.ts` asserts
 * against Python row by row.
 *
 * WHY THE PLACEHOLDER IS COMPARED RATHER THAN THE MAP CONSULTED. "The engine
 * has no name for this codepoint" is exactly "nameOf() returned its `U+XXXX`
 * fallback". Reading `UNICODE_NAMES` directly would miss the variation
 * selectors, which `nameOf()` answers from a rule and not from a row. No
 * Unicode name contains a `+`, so the comparison cannot collide with a real one.
 */
import {
  formatCodepoint,
  nameOf as engineNameOf,
  toFinding as engineToFinding,
  type Finding,
  type Flag,
  type ScanHit,
} from '@ghostchars/engine'

import { CONFUSABLE_NAMES } from './confusable-names.js'

/**
 * The Unicode name of a codepoint, or `U+XXXX` when nothing here has one.
 *
 * Engine first, so a codepoint both tables know keeps the engine's answer and
 * this file can only ever fill a hole.
 */
export function nameOf(cp: number): string {
  const fromEngine = engineNameOf(cp)
  if (fromEngine !== formatCodepoint(cp)) return fromEngine
  return CONFUSABLE_NAMES.get(cp) ?? fromEngine
}

/** A finding with the name this CLI prints, which is the reference's name. */
export function named(finding: Finding): Finding {
  const name = nameOf(finding.cp)
  return name === finding.name ? finding : { ...finding, name }
}

/** {@link named} over a list. */
export function namedAll(findings: readonly Finding[]): readonly Finding[] {
  return findings.map(named)
}

/**
 * The engine's `toFinding()` with the name column corrected.
 *
 * Every finding this package prints is built here or passed through
 * {@link namedAll}, so no output path can pick up the engine's placeholder by
 * forgetting a call.
 */
export function toFinding(hit: ScanHit, enabled: ReadonlySet<Flag>): Finding {
  return named(engineToFinding(hit, enabled))
}
