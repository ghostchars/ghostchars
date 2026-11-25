/**
 * The Ghostchars engine: a byte-for-byte TypeScript port of the Python CLI in
 * the repository root, with zero dependencies, no I/O and no globals. It runs
 * identically in a browser tab, in Node and in a test.
 *
 * ```ts
 * import { clean, find } from '@/engine'
 *
 * find('A​B')                     // one `invisible` finding at 1:2
 * clean('A​B').text               // 'AB'
 * clean('a—b', { punct: true }).text   // 'a - b'
 * decode('A' + String.fromCodePoint(0xe0068, 0xe0069) + 'B')[0]?.text   // 'hi'
 * detectCanary(embedCanary('Draft for the board.', 'alice'))[0]?.id    // 'alice'
 * ```
 *
 * Parity with `strip_invisible.py` is not a claim, it is a test: every fixture
 * in `__fixtures__/golden.json` is replayed through `find()` and through
 * `clean()` for all sixteen flag combinations in `__tests__/parity.test.ts`.
 *
 * ## Why this barrel stops at plain text
 *
 * The document and prose-report halves (`@/engine/style`, `@/engine/docx`,
 * `@/engine/odt`, `@/engine/html`, `@/engine/zip`) are deliberately **not**
 * re-exported here. The home page imports `@/engine` for `clean()`; adding the
 * document modules to this barrel would put the zip reader/writer, the CRC
 * table and the OOXML parsers on the critical path of the page that needs none
 * of them. Import those modules by path instead:
 *
 * ```ts
 * import { analyzeStyle } from '@/engine/style'
 * import { cleanDocx, inspectDocx } from '@/engine/docx'
 * ```
 */
export type {
  Action,
  Classification,
  CleanOptionKey,
  CleanOptions,
  CleanResult,
  CleanSummary,
  Finding,
  Flag,
  Kind,
} from './types'
export { ACTIONS, CLEAN_OPTION_KEYS, FLAGS, KINDS } from './types'

export { clean, cleanText, enabledFlags, prepass, resolveOptions, summarize, DEFAULT_OPTIONS, MAX_OPTIONS } from './clean'
export { actionFor, find, scan, toFinding, DEFAULT_ENABLED_FLAGS } from './find'
export type { ScanHit } from './find'
export { classify, lastCodePoint, toCodePoints, validFlagTagIndices } from './classify'
export { decode, escapeMessage, PAYLOAD_CONFIDENCES, PAYLOAD_SCHEMES } from './decode'
export type { Payload, PayloadConfidence, PayloadScheme } from './decode'
export {
  canaryIdError,
  CanaryError,
  CANARY_EVERY,
  CANARY_MAX_ID_BYTES,
  CANARY_STATUSES,
  detectCanary,
  embedCanary,
  findCanaryMarks,
} from './canary'
export type { CanaryKey, CanaryMark, CanaryResult, CanaryStatus } from './canary'

export { formatCodepoint, nameOf, UNICODE_NAMES } from './unicode-names'
export { CONFUSABLES } from './confusables'
