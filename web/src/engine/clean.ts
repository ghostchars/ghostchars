/**
 * `strip_invisible.clean()`: the pre-passes, then the classifier loop.
 *
 * ## What comes back
 *
 * `text` is byte-for-byte what the Python CLI writes for the same flags; the
 * golden parity test proves it for every text fixture × 16 flag combinations.
 *
 * `findings` are scanned from the text **the caller passed in**, so
 * `line`/`col`/`index` point at the user's own paste and the findings table can
 * highlight it. Each finding's `action` is then derived from the enabled flags.
 * With no whole-text pre-pass on (the normal case) that is exactly what the
 * cleaner did, character for character. The one place the two can drift is
 * `--nfc`/`--nfkc`: normalisation can dissolve a character before the classifier
 * ever sees it: U+3000 IDEOGRAPHIC SPACE becomes a plain space under NFKC even
 * with `-s` off, so a finding may be reported as `found-not-targeted` although
 * normalisation removed it. `text` is still correct; only the tile it is counted
 * under is debatable, and reporting positions in text the user never typed would
 * be worse.
 *
 * `--gutters` is the one pre-pass with findings behind it. The classifier
 * judges a quote bar by its line in the caller's text, which is where
 * `GUTTER_RE` finds it too, so each bar the pre-pass removes is reported as a
 * `gutter` finding with action `removed`. The single space that goes with it is
 * part of the rule rather than a finding. The two can part only where an
 * earlier pre-pass reshaped the line first. `-n` turning a lone CR into a line
 * break, or NFKC turning an ideographic-space indent into spaces, lets the
 * pre-pass remove a bar the scan of the original did not call a gutter; NFKC
 * turning a later U+FFE8 HALFWIDTH FORMS LIGHT VERTICAL into U+2502 makes a
 * second copy that keeps a bar the scan did call one. As with the NFKC case
 * above, `text` is right and only the tile is debatable.
 */
import { classify, lastCodePoint, mixedScriptWords, toCodePoints, validFlagTagIndices } from './classify'
import { scan, toFinding } from './find'
import { COLLAPSE_RE, DASH_RE, GUTTER_RE, TRAILING_RE, isGlue } from './tables'
import type {
  CleanOptionKey,
  CleanOptions,
  CleanResult,
  CleanSummary,
  Finding,
  Flag,
} from './types'

/** Everything off: the CLI with no arguments. */
export const DEFAULT_OPTIONS: CleanOptions = {
  aggressive: false,
  spaces: false,
  newlines: false,
  bidi: false,
  controls: false,
  pua: false,
  punct: false,
  confusables: false,
  nfc: false,
  nfkc: false,
  gutters: false,
  trailing: false,
  collapse: false,
}

/**
 * `--max`: every pass on. Destructive to emoji and non-Latin text.
 *
 * `nfc` stays off because `nfkc` subsumes it and the Python's pre-pass is an
 * `if/elif`: setting both would be a lie about what ran.
 */
export const MAX_OPTIONS: CleanOptions = {
  aggressive: true,
  spaces: true,
  newlines: true,
  bidi: true,
  controls: true,
  pua: true,
  punct: true,
  confusables: true,
  nfc: false,
  nfkc: true,
  gutters: true,
  trailing: true,
  collapse: true,
}

/**
 * The options that put a flag in the enabled set, paired with that flag: the
 * eight that gate the classifier, then `gutters`, whose flag only ever decides
 * a finding's action (see {@link applyClean}).
 */
const FLAG_BY_OPTION: readonly (readonly [CleanOptionKey, Flag])[] = [
  ['aggressive', '-a'],
  ['spaces', '-s'],
  ['newlines', '-n'],
  ['controls', '--controls'],
  ['bidi', '--bidi'],
  ['pua', '--pua'],
  ['punct', '--punct'],
  ['confusables', '--confusables'],
  ['gutters', '--gutters'],
]

/**
 * `enabled_flags(args)`, plus `--gutters` when that option is on. `"default"`
 * is the pseudo-flag that is always on. The Python leaves `--gutters` out
 * because its set only drives the cleaner; here the same set also decides each
 * finding's action, and a bar the pre-pass removed has to read `removed`.
 */
export function enabledFlags(options: CleanOptions): ReadonlySet<Flag> {
  const on = new Set<Flag>(['default'])
  for (const [key, flag] of FLAG_BY_OPTION) {
    if (options[key]) on.add(flag)
  }
  return on
}

/** Fill in the thirteen switches from a partial caller-supplied set. */
export function resolveOptions(options: Partial<CleanOptions> = {}): CleanOptions {
  return {
    aggressive: options.aggressive ?? false,
    spaces: options.spaces ?? false,
    newlines: options.newlines ?? false,
    bidi: options.bidi ?? false,
    controls: options.controls ?? false,
    pua: options.pua ?? false,
    punct: options.punct ?? false,
    confusables: options.confusables ?? false,
    nfc: options.nfc ?? false,
    nfkc: options.nfkc ?? false,
    gutters: options.gutters ?? false,
    trailing: options.trailing ?? false,
    collapse: options.collapse ?? false,
  }
}

/**
 * The whole-text passes that run before any character is classified, in the
 * Python's order. Order matters: `--gutters` runs after `-n` has split lone
 * CRs into lines and before the dash rule, which should see a quoted line
 * without its bar; `--punct`'s dash rule wants the original spacing;
 * `--trailing` comes after `--gutters` so a bare-bar line followed by spaces
 * trails clean; and `--collapse` must not see the trailing runs `--trailing`
 * will delete.
 */
export function prepass(text: string, options: CleanOptions): string {
  let out = text
  if (options.nfkc) out = out.normalize('NFKC')
  else if (options.nfc) out = out.normalize('NFC')
  if (options.newlines) out = out.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (options.gutters) out = out.replace(GUTTER_RE, '$1')
  if (options.punct) out = out.replace(DASH_RE, ' - ')
  if (options.trailing) out = out.replace(TRAILING_RE, '')
  if (options.collapse) out = out.replace(COLLAPSE_RE, ' ')
  return out
}

/**
 * The classifier loop.
 *
 * Note what happens to `prevKept`: an untouched character advances it only when
 * it is not glue, and a *substitution* advances it to the last codepoint of the
 * replacement. A deletion leaves it alone, which is what lets `A<ZWSP><ZWJ>B`
 * still judge the ZWJ against `A`.
 *
 * A `--gutters` hit is left alone even with the flag on, exactly as the
 * Python's `enabled_flags` never contains it: the pre-pass already removed the
 * bar with its space, and what the classifier sees now is the text after that.
 * Acting on it again would strip the inner bar of a nested quote, and the rule
 * is one bar per line.
 */
function applyClean(source: string, enabled: ReadonlySet<Flag>): string {
  const cps = toCodePoints(source)
  const flagTags = validFlagTagIndices(cps)
  const mixed = mixedScriptWords(cps)
  const out: string[] = []
  let prevKept: number | null = null
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i]
    if (cp === undefined) continue
    const hit = classify(cps, i, prevKept, flagTags, mixed)
    if (hit === null || hit.flag === '--gutters' || !enabled.has(hit.flag)) {
      out.push(String.fromCodePoint(cp))
      if (!isGlue(cp)) prevKept = cp
      continue
    }
    out.push(hit.replacement)
    if (hit.replacement !== '') prevKept = lastCodePoint(hit.replacement) ?? prevKept
  }
  return out.join('')
}

/** Tally the four tiles. */
export function summarize(findings: readonly Finding[]): CleanSummary {
  let removed = 0
  let replaced = 0
  let keptLoadBearing = 0
  let foundNotTargeted = 0
  for (const finding of findings) {
    if (finding.action === 'removed') removed += 1
    else if (finding.action === 'replaced') replaced += 1
    else if (finding.action === 'kept-load-bearing') keptLoadBearing += 1
    else foundNotTargeted += 1
  }
  return { removed, replaced, keptLoadBearing, foundNotTargeted }
}

/**
 * Clean `text` under `options`, and report what was found in it.
 *
 * @example
 * clean('A​B', { spaces: true }).text // 'AB'
 */
export function clean(text: string, options: Partial<CleanOptions> = {}): CleanResult {
  const resolved = resolveOptions(options)
  const enabled = enabledFlags(resolved)
  const cleaned = applyClean(prepass(text, resolved), enabled)
  const findings = scan(toCodePoints(text)).map((hit) => toFinding(hit, enabled))
  return { text: cleaned, findings, summary: summarize(findings) }
}

/** Just the cleaned text: the CLI's own contract, without the reporting. */
export function cleanText(text: string, options: Partial<CleanOptions> = {}): string {
  const resolved = resolveOptions(options)
  return applyClean(prepass(text, resolved), enabledFlags(resolved))
}
