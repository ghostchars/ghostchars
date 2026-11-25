/**
 * One file, one surface, one verdict.
 *
 * THE MEASURE. The number of characters a bar would change is the count of
 * findings whose action under that bar is `removed` or `replaced`. That number
 * is equal to `len(changed_chars(before, after))` from `tools/changed_chars.py`
 * for every golden text fixture across both bars, which is what
 * `test/parity.gate.test.ts` proves. Because the two agree, a pin number is
 * interchangeable between the two tools and no `difflib` port is needed here.
 *
 * WHY THE INVARIANT HOLDS. Neither gate bar has a pre-pass without a
 * per-character finding behind it. The `default` bar has no pre-pass at all,
 * and `--punct`'s dash rule always has a dash finding behind it. That is
 * exactly why `--collapse`, `--trailing` and `--nfkc` are not offered as bars:
 * each of them can move characters that no finding points at. `--gutters` is
 * out for the same reason although it has findings: its finding points at the
 * quote bar, and the one space removed after it has none.
 *
 * THE DECISION IS STILL THE TEXT. Pass or fail is `cleanText(text, options) !==
 * text`, not the count. Where the two ever disagreed the file would be reported
 * as changed with a note that no position could be attributed, so the gate can
 * never pass a file the cleaner would rewrite. Three lines, and they close the
 * only hole the measure could have.
 */
import { readFileSync, statSync, lstatSync } from 'node:fs'

import { clean, type CleanOptionKey, type CleanOptions, type Finding } from '@ghostchars/engine'

import { decodeUtf8, fileErrorMessage } from '../io.js'
import type { CheckFailureJson, CheckHitJson, SkipReason } from '../json.js'
import { payloadsIn, payloadsJson } from '../payloads.js'
import { TextIndex } from '../positions.js'
import * as strings from '../strings.js'

import type { DiscoveredFile } from './discover.js'
import { decodeEscapes } from './escapes.js'
import { hasBinaryExtension, hasNulByte } from './istext.js'
import { pinFor, verdictFor } from './pins.js'

/** A surface, with everything already resolved against the command line. */
export interface GateSurface {
  readonly id: string
  /** The word the human output uses: `default` or `text`. */
  readonly bar: string
  readonly options: CleanOptions
  /** The ON option names, sorted, for the JSON payload. */
  readonly optionKeys: readonly CleanOptionKey[]
  readonly decodeEscapes: boolean
  readonly pins: Readonly<Record<string, number>>
  /** True when this surface claims the root-relative path. */
  readonly matches: (relative: string) => boolean
}

export type GateVerdict =
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'passed' }
  | { readonly kind: 'failed'; readonly failure: CheckFailureJson }

/**
 * The surface that claims a path, or nothing.
 *
 * LAST MATCH WINS. A config reads top to bottom, from the broad surface that
 * covers everything to the narrow one that holds a subdirectory to a stricter
 * bar, and the narrow one is meant to win. An exclusion only ever removes a
 * path from the surface that declares it, so a file excluded from `prose` can
 * still be gated by the broader `invisibles` surface above it, which is what
 * the two-surface config in the README is doing.
 */
export function surfaceFor(
  surfaces: readonly GateSurface[],
  relative: string,
): GateSurface | undefined {
  let found: GateSurface | undefined
  for (const surface of surfaces) if (surface.matches(relative)) found = surface
  return found
}

/** Findings whose action under these options means the character moves. */
export function changedFindings(source: string, options: CleanOptions): {
  readonly wouldChange: boolean
  readonly hits: readonly Finding[]
} {
  const result = clean(source, options)
  const hits = result.findings.filter(
    (finding) => finding.action === 'removed' || finding.action === 'replaced',
  )
  return { wouldChange: result.text !== source, hits }
}

/** How the file's bytes turned into either text or a reason to stop. */
type ReadOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'error'; readonly message: string }

/**
 * The four gates, cheapest first, plus the two stat-shaped ones in front.
 *
 * The named-versus-discovered asymmetry lives here and nowhere else: a
 * discovered file that will not decode is skipped in silence, and a file the
 * user named is an error, because naming it asserted that it is text. That rule
 * covers BOTH content gates, the NUL scan and the strict decode. It does not
 * cover the extension short circuit above, and deliberately so: `.docx` and
 * `.odt` are on the binary-extension list precisely because documents are out of
 * scope for the gate, so `ghostchars check essay.docx` has to skip rather than
 * fail.
 */
function readForGate(file: DiscoveredFile, maxBytes: number): ReadOutcome {
  if (hasBinaryExtension(file.absolute)) return { kind: 'skipped', reason: 'binary-ext' }

  let stat
  try {
    stat = file.named ? statSync(file.absolute) : lstatSync(file.absolute)
  } catch (error) {
    return { kind: 'error', message: fileErrorMessage(file.display, error) }
  }
  if (!file.named && stat.isSymbolicLink()) return { kind: 'skipped', reason: 'symlink' }
  if (!stat.isFile()) return { kind: 'skipped', reason: 'binary' }
  if (stat.size > maxBytes) return { kind: 'skipped', reason: 'too-large' }

  let bytes: Buffer
  try {
    bytes = readFileSync(file.absolute)
  } catch (error) {
    return { kind: 'error', message: fileErrorMessage(file.display, error) }
  }
  // THE NUL SCAN IS A DISCOVERY HEURISTIC, NOT A VERDICT ON A NAMED FILE. It is
  // there so a walk over a repository does not report every compiled object as
  // an error, and for a discovered file it stands. For a file the user NAMED it
  // was wrong twice over: it ran before the named check below, so
  // `ghostchars check utf16.md` printed `0 files pass the default bar, 1
  // skipped` and exited 0 on a file it had never read, while
  // `strip_invisible.py --show utf16.md` prints `not valid UTF-8, skipped` and
  // exits 2; and a CI step or an agent gating on the exit code alone got a clean
  // pass. Naming a file asserts that it is text, so a named file goes straight
  // to the strict decode and the decode decides. A named file that really is
  // UTF-8 with an embedded NUL is then gated, which is what the reference
  // implementation does with it too.
  if (!file.named && hasNulByte(bytes)) return { kind: 'skipped', reason: 'binary' }

  const text = decodeUtf8(bytes)
  if (text === null) {
    if (file.named) return { kind: 'error', message: strings.errNotUtf8(file.display) }
    return { kind: 'skipped', reason: 'not-utf8' }
  }
  return { kind: 'text', text }
}

/** The positions printed under a failing file, capped and already quoted. */
function hitsFor(source: string, hits: readonly Finding[], limit: number): CheckHitJson[] {
  const index = new TextIndex(source)
  return hits.slice(0, Math.max(0, limit)).map((finding) => ({
    line: finding.line,
    col: finding.col,
    cp: finding.cp,
    u: strings.codepointLabel(finding.cp),
    name: finding.name,
    kind: finding.kind,
    flag: finding.flag,
    lineText: index.contextAt(finding.line),
  }))
}

/** Hold one file to one surface. Reads the file; writes nothing, ever. */
export function evaluateFile(
  file: DiscoveredFile,
  surface: GateSurface,
  limit: number,
  maxBytes: number,
): GateVerdict {
  const read = readForGate(file, maxBytes)
  if (read.kind !== 'text') return read

  // The escape pass runs BEFORE the clean, because an escape is how a character
  // was typed and not whether it ships, and those are different questions.
  const source = surface.decodeEscapes ? decodeEscapes(read.text) : read.text
  const { wouldChange, hits } = changedFindings(source, surface.options)
  const pinned = pinFor(surface.pins, file.relative)
  const verdict = verdictFor(pinned, hits.length, wouldChange)
  if (verdict.ok) return { kind: 'passed' }

  return {
    kind: 'failed',
    failure: {
      path: file.display,
      surface: surface.id,
      bar: surface.bar,
      status: verdict.status,
      changed: hits.length,
      pinned,
      // A pin failure has no character to point at: the count is simply not the
      // pinned one, and listing characters would bury that in noise.
      hits: verdict.status === 'changed' ? hitsFor(source, hits, limit) : [],
      // Decoded only for a failing file: a pass costs nothing extra, and a
      // payload always rides on characters the gate already fails on, except
      // for the visible channels (spaces, apostrophes), which no bar changes.
      payloads: payloadsJson(source, payloadsIn(source)),
    },
  }
}

/**
 * What `--fix` would write, or nothing when there is nothing to write.
 *
 * The RAW file text is cleaned, never the escape-decoded text. Writing back a
 * decoded surface would resolve every escape in the file into a literal
 * character, which is a rewrite nobody asked for. The consequence is honest and
 * documented: `--fix` cannot fix a character that was typed as an escape, and
 * the re-check after the fix still reports it.
 */
export function fixedText(file: DiscoveredFile, surface: GateSurface, maxBytes: number): string | undefined {
  const read = readForGate(file, maxBytes)
  if (read.kind !== 'text') return undefined
  const cleaned = clean(read.text, surface.options).text
  return cleaned === read.text ? undefined : cleaned
}
