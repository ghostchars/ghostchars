/**
 * `clean`: the command everything else is measured against.
 *
 * THE TEXT FLOW IS `strip_invisible.py`'s `main()` LINE FOR LINE. Read, clean
 * with the bare-string contract, compare, then take exactly one of three
 * branches: `--check` writes nothing ever, `-i` rewrites only a file that
 * actually changed, and everything else writes the whole cleaned text to
 * stdout. The `-c` delta is counted in CODEPOINTS, because Python's `len()`
 * counts codepoints and JavaScript's `.length` counts UTF-16 units, and a pin
 * copied from one tool has to mean the same thing in the other.
 *
 * WHY THE DOCUMENT BRANCH IS A LAZY IMPORT. `.docx`, `.odt` and `.html` are
 * handled by `dist/doc.js`, which carries a zip reader, an inflater and three
 * XML passes. A Markdown file must not pay to parse any of it, so the extension
 * is matched first and the module is read from disk only after that.
 *
 * WHY AN UNRECOGNIZED EXTENSION IS PLAIN TEXT. `clean_file.py` errors with
 * `unsupported type`; one command here covers both reference tools, so anything
 * that is not one of the four document extensions is text. This differs from
 * the Python reference. `--as text` forces that treatment for a document
 * extension too.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

import { clean, cleanText, summarize } from '@ghostchars/engine'
import type { CleanOptions, Finding } from '@ghostchars/engine'

import type { ParsedCommand } from '../args.js'
import type {
  DocKind,
  DocumentExtras,
  DocumentInspection,
  PackageCleanOutcome,
  PackageFailure,
  PackageKind,
  PackageResult,
} from '../doc/index.js'
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, ExitAccumulator, UsageError } from '../exit.js'
import type { ExitCode } from '../exit.js'
import {
  decodeUtf8,
  errLine,
  errnoOf,
  fileErrorMessage,
  out,
  readStdin,
  writeAtomic,
  writeAtomicBytes,
} from '../io.js'
import type { CleanResultJson, CleanSummaryTotals, ResultError, ResultErrorKind } from '../json.js'
import { baseEnvelope, serializeJson } from '../json.js'
import { optionNames, readBar, readCleanOptions } from '../options.js'
import type { Bar } from '../options.js'
import { cpLength, rewriteSites } from '../positions.js'
import * as strings from '../strings.js'

// ---------------------------------------------------------------------------
// the document bundle
// ---------------------------------------------------------------------------

/**
 * The four functions `dist/doc.js` exports, as this module needs to see them.
 *
 * The shape is checked at load time rather than trusted, because a dynamic
 * import of a URL is typed `any` and this package bans both `any` and `as`. The
 * predicate below is the one place the boundary is crossed, and a bundle that
 * does not answer to all four names fails loudly instead of throwing
 * `undefined is not a function` three frames later.
 */
export interface DocModule {
  inspectPackage(
    kind: PackageKind,
    bytes: Uint8Array,
  ): Promise<PackageResult<DocumentInspection>>
  cleanPackage(
    kind: PackageKind,
    bytes: Uint8Array,
    options: CleanOptions,
    extras: DocumentExtras,
  ): Promise<PackageResult<PackageCleanOutcome>>
  inspectPage(source: string): DocumentInspection
  cleanPage(source: string, options: CleanOptions): string
}

function isDocModule(value: unknown): value is DocModule {
  if (typeof value !== 'object' || value === null) return false
  return (
    'inspectPackage' in value &&
    typeof value.inspectPackage === 'function' &&
    'cleanPackage' in value &&
    typeof value.cleanPackage === 'function' &&
    'inspectPage' in value &&
    typeof value.inspectPage === 'function' &&
    'cleanPage' in value &&
    typeof value.cleanPage === 'function'
  )
}

let cachedDocModule: DocModule | undefined

/**
 * Load `dist/doc.js`, once per process.
 *
 * `import.meta.url` is `dist/main.js` in the shipped bundle and this file's own
 * URL under vitest, and `./doc.js` resolves next to it in both. The natural home
 * for this loader would be a `src/doc/load.ts`, but the entry-point list in
 * `scripts/build.mjs` names only `src/doc/index.ts`, and importing that module
 * from here by value would pull the whole zip reader back into `dist/main.js`,
 * which is the one thing the split exists to prevent. So it lives here, and
 * `src/commands/inspect.ts` imports it.
 */
export async function loadDocModule(): Promise<DocModule> {
  if (cachedDocModule !== undefined) return cachedDocModule
  const specifier = new URL('./doc.js', import.meta.url).href
  const loaded: unknown = await import(specifier)
  if (!isDocModule(loaded)) {
    throw new Error(`${specifier} is not the ghostchars document bundle`)
  }
  cachedDocModule = loaded
  return loaded
}

const DOC_EXTENSIONS: Readonly<Record<string, DocKind>> = {
  '.docx': 'docx',
  '.odt': 'odt',
  '.html': 'html',
  '.htm': 'html',
}

/** Which treatment a path gets. Decided once, from the extension, case-folded. */
export function kindOf(path: string | null, forceText: boolean): DocKind | 'text' {
  if (path === null || forceText) return 'text'
  return DOC_EXTENSIONS[extname(path).toLowerCase()] ?? 'text'
}

/** `essay.docx` becomes `essay.clean.docx`, exactly as `clean_file.py` does. */
export function siblingCleanPath(path: string): string {
  const ext = extname(path)
  return `${path.slice(0, path.length - ext.length)}.clean${ext}`
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

interface Settings {
  readonly bar: Bar
  readonly options: CleanOptions
  readonly inPlace: boolean
  readonly count: boolean
  readonly check: boolean
  readonly json: boolean
  readonly label: string
  readonly forceText: boolean
  readonly output: string | undefined
  readonly extras: DocumentExtras
}

function readSettings(parsed: ParsedCommand): Settings {
  const values = parsed.values
  const bar = readBar(values)
  const mode = values.string('--as') ?? 'auto'
  if (mode !== 'auto' && mode !== 'text') throw new UsageError(strings.errBadAs(mode))
  return {
    bar,
    options: readCleanOptions(values, bar),
    inPlace: values.bool('--in-place'),
    count: values.bool('--count'),
    check: values.bool('--check'),
    json: values.bool('--json'),
    label: values.string('--stdin-name') ?? strings.STDIN_LABEL,
    forceText: mode === 'text',
    output: values.string('--output'),
    extras: { metadata: values.bool('--metadata'), rsids: values.bool('--rsids') },
  }
}

// ---------------------------------------------------------------------------
// one input
// ---------------------------------------------------------------------------

interface Outcome {
  readonly code: ExitCode
  readonly result: CleanResultJson
}

/**
 * The message without its `{path}: ` prefix.
 *
 * `src/strings.ts` owns every sentence and spells each of these with the path
 * already attached, which is right for stderr and wrong for a JSON field that
 * already has a `path` key beside it. Trimming the prefix here keeps one copy
 * of the words rather than a second, drifting one in this module.
 */
function withoutPath(path: string, whole: string): string {
  return whole.startsWith(`${path}: `) ? whole.slice(path.length + 2) : whole
}

function failure(path: string, kind: ResultErrorKind, message: string): Outcome {
  return { code: EXIT_USAGE, result: { path, ok: false, error: { kind, message } } }
}

/** Read a file as bytes, printing the diagnostic and classifying the failure. */
export function readInputBytes(
  path: string,
): { ok: true; bytes: Buffer } | { ok: false; error: ResultError } {
  try {
    return { ok: true, bytes: readFileSync(path) }
  } catch (error) {
    const message = strings.errnoMessage(errnoOf(error))
    errLine(strings.errFile(path, message))
    return { ok: false, error: { kind: 'unreadable', message } }
  }
}

/**
 * Read a file as text.
 *
 * This is `io.readTextFile` with the failure kept rather than collapsed into
 * `null`: the two ways a read can fail mean different things to a caller, and
 * `--json` has a field that says which one happened. The stderr output is the
 * same in both, because it comes from the same two strings.
 */
export function readInputText(
  path: string,
): { ok: true; text: string } | { ok: false; error: ResultError } {
  const read = readInputBytes(path)
  if (!read.ok) return read
  const text = decodeUtf8(read.bytes)
  if (text === null) {
    const whole = strings.errNotUtf8(path)
    errLine(whole)
    return { ok: false, error: { kind: 'not-utf8', message: withoutPath(path, whole) } }
  }
  return { ok: true, text }
}

/**
 * One result, built as cheaply as the run allows.
 *
 * WITHOUT `--json` NOTHING BELOW IS PRINTED, so nothing below is computed. That
 * matters: `clean` is the command a CI walk calls over hundreds of files, and
 * the summary needs a second full scan of the text that the bare-string clean
 * never had to do. The batched golden replay cleans 134 files per spawn and
 * would pay for it 134 times.
 */
function resultFor(
  path: string,
  changed: boolean,
  written: boolean,
  text: string,
  cleanedText: () => string,
  settings: Settings,
  includeText: boolean,
): CleanResultJson {
  if (!settings.json) return { path, ok: true, changed, written }
  const cleaned = cleanedText()
  const findings: readonly Finding[] = clean(text, settings.options).findings
  // Uncapped on purpose here, unlike the MCP tool: this payload already carries
  // the whole cleaned text, it goes to one caller's stdout rather than into a
  // shared server's response, and `clean` has no `--limit`.
  const sites = settings.options.punct ? rewriteSites(text, settings.options).sites : undefined
  return {
    path,
    ok: true,
    changed,
    written,
    summary: summarize(findings),
    charsDelta: cpLength(text) - cpLength(cleaned),
    ...(sites === undefined ? {} : { rewriteSites: sites }),
    ...(includeText ? { text: cleaned } : {}),
  }
}

/**
 * Plain text, from stdin or from a file.
 *
 * The order of the three branches is the reference CLI's own, and so is the
 * rule that `-c` prints its line AFTER the write and only when `--check` is off:
 * under `--check` the reference prints `would change` instead, and only when
 * something would.
 */
async function handleText(path: string | null, settings: Settings): Promise<Outcome> {
  const label = path ?? settings.label
  let text: string
  if (path === null) {
    text = await readStdin(settings.label)
  } else {
    const read = readInputText(path)
    if (!read.ok) return { code: EXIT_USAGE, result: { path: label, ok: false, error: read.error } }
    text = read.text
  }

  const cleaned = cleanText(text, settings.options)
  const changed = cleaned !== text
  const provide = (): string => cleaned

  if (settings.check) {
    if (changed && settings.count && !settings.json) errLine(strings.wouldChangeLine(label))
    return {
      code: changed ? EXIT_FINDINGS : EXIT_OK,
      result: resultFor(label, changed, false, text, provide, settings, false),
    }
  }

  let written = false
  const destination = settings.inPlace && path !== null ? path : settings.output
  if (destination !== undefined) {
    // Under `-i` an unchanged file is never opened, so its mtime and inode
    // survive. A named `-o` destination is always written: the caller asked for
    // that file to exist.
    if (changed || !settings.inPlace) {
      try {
        writeAtomic(destination, cleaned)
        written = true
      } catch (error) {
        const message = strings.errnoMessage(errnoOf(error))
        errLine(fileErrorMessage(destination, error))
        return failure(label, 'unwritable', message)
      }
    }
  } else if (!settings.json) {
    out(cleaned)
  }

  if (settings.count && !settings.json) {
    errLine(strings.countLine(label, cpLength(text) - cpLength(cleaned)))
  }

  return {
    code: EXIT_OK,
    result: resultFor(label, changed, written, text, provide, settings, !written),
  }
}

/** Where a cleaned document goes when it is not being rewritten in place. */
function destinationFor(path: string, settings: Settings): string {
  if (settings.inPlace) return path
  return settings.output ?? siblingCleanPath(path)
}

/**
 * Broken versus hostile, kept apart because the distinction is the only part a
 * person can act on: one says the file came from somewhere bad, the other says
 * do not open it at all.
 */
export function reportPackageFailure(
  path: string,
  kind: PackageKind,
  failed: PackageFailure,
): ResultError {
  const whole =
    failed === 'expands-too-far' ? strings.errExpandsTooFar(path) : strings.errBadPackage(path, kind)
  errLine(whole)
  return { kind: failed, message: withoutPath(path, whole) }
}

/** `.docx` and `.odt`: one archive read, then either a report or a rewrite. */
async function handlePackage(
  path: string,
  kind: PackageKind,
  settings: Settings,
): Promise<Outcome> {
  const doc = await loadDocModule()
  const read = readInputBytes(path)
  if (!read.ok) return { code: EXIT_USAGE, result: { path, ok: false, error: read.error } }

  if (settings.check) {
    const inspected = await doc.inspectPackage(kind, read.bytes)
    if (!inspected.ok) {
      return {
        code: EXIT_USAGE,
        result: { path, ok: false, error: reportPackageFailure(path, kind, inspected.failure) },
      }
    }
    const text = inspected.value.text
    const cleaned = cleanText(text, settings.options)
    // A document also changes when only its metadata or its rsids would go, and
    // neither of those shows up in the text. `clean_file.py` says the same.
    const changed = cleaned !== text || settings.extras.metadata || settings.extras.rsids
    if (changed && settings.count && !settings.json) errLine(strings.wouldChangeLine(path))
    return {
      code: changed ? EXIT_FINDINGS : EXIT_OK,
      result: resultFor(path, changed, false, text, () => cleaned, settings, false),
    }
  }

  const cleaned = await doc.cleanPackage(kind, read.bytes, settings.options, settings.extras)
  if (!cleaned.ok) {
    return {
      code: EXIT_USAGE,
      result: { path, ok: false, error: reportPackageFailure(path, kind, cleaned.failure) },
    }
  }
  const destination = destinationFor(path, settings)
  try {
    writeAtomicBytes(destination, cleaned.value.bytes)
  } catch (error) {
    const message = strings.errnoMessage(errnoOf(error))
    errLine(fileErrorMessage(destination, error))
    return failure(path, 'unwritable', message)
  }

  if (settings.count && !settings.json) {
    const extra =
      (settings.extras.metadata ? strings.DOCUMENT_EXTRA_METADATA : '') +
      (settings.extras.rsids ? strings.DOCUMENT_EXTRA_RSIDS : '')
    errLine(strings.documentCountLine(path, cleaned.value.changedNodes, extra, destination))
  }

  const text = cleaned.value.text
  return {
    code: EXIT_OK,
    result: resultFor(
      path,
      cleaned.value.changedParts.length > 0,
      true,
      text,
      () => cleanText(text, settings.options),
      settings,
      false,
    ),
  }
}

/**
 * `.html` and `.htm`, cleaned structurally.
 *
 * The `-c` delta is measured over the whole SOURCE, not over the visible text,
 * because that is the number `clean_file.py` prints and it is the honest answer
 * to "how much did this file shrink".
 */
async function handlePage(path: string, settings: Settings): Promise<Outcome> {
  const doc = await loadDocModule()
  const read = readInputText(path)
  if (!read.ok) return { code: EXIT_USAGE, result: { path, ok: false, error: read.error } }
  const source = read.text

  const cleaned = doc.cleanPage(source, settings.options)
  const changed = cleaned !== source
  const provide = (): string => cleaned

  if (settings.check) {
    if (changed && settings.count && !settings.json) errLine(strings.wouldChangeLine(path))
    return {
      code: changed ? EXIT_FINDINGS : EXIT_OK,
      result: resultFor(path, changed, false, source, provide, settings, false),
    }
  }

  const destination = destinationFor(path, settings)
  let written = false
  if (changed || destination !== path) {
    try {
      writeAtomic(destination, cleaned)
      written = true
    } catch (error) {
      const message = strings.errnoMessage(errnoOf(error))
      errLine(fileErrorMessage(destination, error))
      return failure(path, 'unwritable', message)
    }
  }

  if (settings.count && !settings.json) {
    errLine(strings.documentCharsLine(path, cpLength(source) - cpLength(cleaned), destination))
  }

  return {
    code: EXIT_OK,
    result: resultFor(path, changed, written, source, provide, settings, false),
  }
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function totals(results: readonly CleanResultJson[]): CleanSummaryTotals {
  let removed = 0
  let replaced = 0
  let keptLoadBearing = 0
  let foundNotTargeted = 0
  let filesChanged = 0
  let filesUnchanged = 0
  let filesSkipped = 0
  for (const result of results) {
    if (!result.ok) {
      filesSkipped += 1
      continue
    }
    const summary = result.summary
    if (summary !== undefined) {
      removed += summary.removed
      replaced += summary.replaced
      keptLoadBearing += summary.keptLoadBearing
      foundNotTargeted += summary.foundNotTargeted
    }
    if (result.changed === true) filesChanged += 1
    else filesUnchanged += 1
  }
  return {
    removed,
    replaced,
    keptLoadBearing,
    foundNotTargeted,
    filesChanged,
    filesUnchanged,
    filesSkipped,
  }
}

export async function run(parsed: ParsedCommand): Promise<number> {
  const settings = readSettings(parsed)
  const paths = parsed.positionals

  // Every usage error is raised before a single byte is read, so a command that
  // cannot possibly work never half-rewrites a tree first.
  if (settings.inPlace && paths.length === 0) {
    throw new UsageError(strings.ERR_IN_PLACE_NEEDS_FILES)
  }
  if (settings.output !== undefined && settings.inPlace) {
    throw new UsageError(strings.ERR_OUTPUT_WITH_IN_PLACE)
  }
  if (settings.output !== undefined && paths.length > 1) {
    throw new UsageError(strings.ERR_OUTPUT_NEEDS_ONE_INPUT)
  }

  const inputs: readonly (string | null)[] = paths.length === 0 ? [null] : paths
  const exit = new ExitAccumulator()
  const results: CleanResultJson[] = []

  for (const path of inputs) {
    const kind = kindOf(path, settings.forceText)
    const outcome =
      path === null || kind === 'text'
        ? await handleText(path, settings)
        : kind === 'html'
          ? await handlePage(path, settings)
          : await handlePackage(path, kind, settings)
    exit.add(outcome.code)
    results.push(outcome.result)
  }

  const code = exit.code
  if (settings.json) {
    out(
      serializeJson({
        ...baseEnvelope('clean', code),
        bar: settings.bar,
        options: optionNames(settings.options),
        summary: totals(results),
        results,
      }),
    )
  }
  return code
}
