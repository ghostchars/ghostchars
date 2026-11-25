/**
 * `ghostchars check`: the gate.
 *
 * This is the command a CI job runs and the one an agent runs before it
 * commits. Everything about it is shaped by one fact: a gate that fails for a
 * reason its owner disagrees with gets deleted, and a deleted gate protects
 * nothing.
 *
 * WHY THE DEFAULT BAR IS `default`. Out of the box it fails only on characters
 * nobody chose: zero-width spaces, bidi overrides, free-floating tag
 * characters. Typography is a house style, so `--bar text` is opt-in. A gate
 * that fails on a repository's deliberate em dashes the first time it runs is
 * a gate nobody keeps.
 *
 * WHY THERE IS NO `max` BAR. `max` folds look-alike Cyrillic and Greek letters
 * and applies NFKC, which rewrites letters. Pointed at a repository it
 * condemns legitimate Cyrillic, Greek and emoji content. `--bar` takes two
 * values here and the MCP tool takes the same two.
 *
 * HOW THE COMMAND LINE AND THE CONFIG FILE COMPOSE. A surface in
 * `ghostchars.json` sets its own bar. Anything given on the command line is a
 * FLOOR under every surface: the resolved options are the union of the
 * surface's own set with the command line's bar and explicit flags. That
 * follows the package's one resolution rule, that an option can only be turned
 * on, and it means `ghostchars check --bar text` means the same thing in a
 * repository with a config as in one without.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { CleanOptions } from '@ghostchars/engine'

import { DEFAULT_CHECK_LIMIT, DEFAULT_MAX_BYTES, type ParsedCommand } from '../args.js'
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE, UsageError, worst, type ExitCode } from '../exit.js'
import { checkFailureBlock, skipReasonText } from '../format.js'
import { errLine, out, outLine, writeAtomic } from '../io.js'
import {
  SKIPPED_LIST_CAP,
  baseEnvelope,
  serializeJson,
  type CheckEnvelope,
  type CheckFailureJson,
  type CheckPassJson,
  type CheckSkipJson,
  type CheckSurfaceJson,
} from '../json.js'
import { explicitOptionKeys, optionsForBar, readGateBar } from '../options.js'
import * as strings from '../strings.js'

import { CONFIG_FILENAME, loadConfig, type GateConfig } from '../check/config.js'
import {
  discover,
  gitOnPath,
  gitToplevel,
  type DiscoveredFile,
  type Discovery,
} from '../check/discover.js'
import { evaluateFile, fixedText, surfaceFor, type GateSurface } from '../check/gate.js'
import { toSarif } from '../check/sarif.js'
import {
  barLabel,
  fromKeys,
  implicitSurface,
  isOutsideRoot,
  toGateSurface,
  unionOptions,
} from '../check/surfaces.js'

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

interface FailureRecord {
  readonly json: CheckFailureJson
  readonly file: DiscoveredFile
  readonly surface: GateSurface
}

interface SurfaceCounts {
  scanned: number
  failed: number
}

interface ScanOutcome {
  readonly failures: readonly FailureRecord[]
  readonly skipped: readonly CheckSkipJson[]
  readonly passed: readonly CheckPassJson[]
  readonly errors: readonly string[]
  readonly scanned: number
  readonly counts: ReadonlyMap<string, SurfaceCounts>
}

function scan(
  files: readonly DiscoveredFile[],
  surfaces: readonly GateSurface[],
  root: string,
  limit: number,
  maxBytes: number,
): ScanOutcome {
  const failures: FailureRecord[] = []
  const skipped: CheckSkipJson[] = []
  const passed: CheckPassJson[] = []
  const errors: string[] = []
  const counts = new Map<string, SurfaceCounts>()
  for (const surface of surfaces) counts.set(surface.id, { scanned: 0, failed: 0 })
  let scanned = 0

  for (const file of files) {
    const surface = surfaceFor(surfaces, file.relative)
    // A path no surface claims is out of scope: not scanned, not skipped, not
    // counted. The config author decided that, and saying nothing is the honest
    // report of a decision somebody made on purpose.
    //
    // EXCEPT A NAMED FILE OUTSIDE THE ROOT. No config glob can claim a `../`
    // path, so dropping it would be no author's decision at all, and the run
    // would print a clean pass over a file it never read. Naming it asserted it
    // should be gated, so it is an error (exit 2), the same line the MCP tools
    // print for a path outside their root.
    if (surface === undefined) {
      if (file.named && isOutsideRoot(file.relative)) {
        errors.push(strings.ERROR_PREFIX + strings.errPathOutsideRoot(file.display, root))
      }
      continue
    }
    const verdict = evaluateFile(file, surface, limit, maxBytes)
    if (verdict.kind === 'skipped') {
      skipped.push({ path: file.display, reason: verdict.reason })
      continue
    }
    if (verdict.kind === 'error') {
      errors.push(verdict.message)
      continue
    }
    scanned += 1
    const surfaceCount = counts.get(surface.id)
    if (surfaceCount !== undefined) surfaceCount.scanned += 1
    if (verdict.kind === 'passed') {
      passed.push({ path: file.display, surface: surface.id, bar: surface.bar })
      continue
    }
    if (surfaceCount !== undefined) surfaceCount.failed += 1
    failures.push({ json: verdict.failure, file, surface })
  }

  return { failures, skipped, passed, errors, scanned, counts }
}

/**
 * Clean the unpinned failures in place, and name the pinned ones left alone.
 *
 * A pinned file is never fixed: the pin records an exact count of deliberate
 * characters, and cleaning them away would invalidate the pin rather than
 * satisfy it. The caller re-scans afterwards, so what is reported is the state
 * of the tree after the writes, not a prediction of it.
 */
function applyFix(outcome: ScanOutcome, maxBytes: number): number {
  let fixed = 0
  for (const record of outcome.failures) {
    if (record.json.status !== 'changed') {
      errLine(strings.checkFixSkippedPin(record.json.path))
      continue
    }
    const cleaned = fixedText(record.file, record.surface, maxBytes)
    if (cleaned === undefined) continue
    try {
      writeAtomic(record.file.absolute, cleaned)
      fixed += 1
    } catch (error) {
      errLine(
        strings.errFile(
          record.json.path,
          error instanceof Error ? error.message : 'could not be written',
        ),
      )
    }
  }
  return fixed
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function surfaceDocuments(
  surfaces: readonly GateSurface[],
  counts: ReadonlyMap<string, SurfaceCounts>,
): CheckSurfaceJson[] {
  return surfaces.map((surface) => {
    const count = counts.get(surface.id) ?? { scanned: 0, failed: 0 }
    return {
      id: surface.id,
      bar: surface.bar,
      options: surface.optionKeys,
      decodeEscapes: surface.decodeEscapes,
      scanned: count.scanned,
      failed: count.failed,
    }
  })
}

/** One word for a whole run, used only by the two summary lines. */
function overallBar(surfaces: readonly GateSurface[], floor: CleanOptions): string {
  const first = surfaces[0]
  if (first !== undefined && surfaces.every((surface) => surface.bar === first.bar)) return first.bar
  return barLabel(floor)
}

function printHuman(
  outcome: ScanOutcome,
  surfaces: readonly GateSurface[],
  floor: CleanOptions,
  verbose: boolean,
  configPath: string | null,
): void {
  if (verbose) {
    // Which config governed the run is the one fact the human output never
    // carried, and it is the fact that decides every other number on the screen.
    // `--json` has always reported it; this is the same answer for a person.
    outLine(
      configPath === null ? strings.CHECK_NO_CONFIG : strings.checkConfigUsed(configPath),
    )
    for (const entry of outcome.passed) outLine(strings.checkPassed(entry.path, entry.bar))
  }
  for (const record of outcome.failures) {
    for (const line of checkFailureBlock(record.json)) outLine(line)
    outLine('')
  }
  const skipped = outcome.skipped.length
  if (outcome.failures.length === 0) {
    outLine(strings.checkPassSummary(outcome.scanned, overallBar(surfaces, floor), skipped))
    return
  }
  outLine(
    strings.checkFailSummary(
      outcome.failures.length,
      outcome.scanned,
      skipped,
      skipReasonText(outcome.skipped),
    ),
  )
}

function printJson(
  outcome: ScanOutcome,
  surfaces: readonly GateSurface[],
  counts: ReadonlyMap<string, SurfaceCounts>,
  root: string,
  discovery: Discovery,
  configPath: string | null,
  code: ExitCode,
  verbose: boolean,
): void {
  const payload: CheckEnvelope = {
    ...baseEnvelope('check', code),
    root,
    discovery,
    config: configPath,
    surfaces: surfaceDocuments(surfaces, counts),
    filesScanned: outcome.scanned,
    filesSkipped: outcome.skipped.length,
    filesFailing: outcome.failures.length,
    failures: outcome.failures.map((record) => record.json),
    // Counts before lists, and the whole point of `passed` is that it is absent
    // by default: on a large repository it is the longest array in the payload
    // and the least interesting. `--verbose` is the request for it, and it is
    // the same request that lists them in the human output.
    ...(verbose ? { passed: outcome.passed } : {}),
    skipped: outcome.skipped.slice(0, SKIPPED_LIST_CAP),
    skippedTruncated: outcome.skipped.length > SKIPPED_LIST_CAP,
    skippedTotal: outcome.skipped.length,
  }
  out(serializeJson(payload))
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

interface Setup {
  readonly root: string
  readonly configPath: string | null
  readonly config: GateConfig | null
}

/** The directory a positional argument speaks for: itself, or its parent. */
function directoryOf(absolute: string): string {
  try {
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute)
  } catch {
    return dirname(absolute)
  }
}

/**
 * The nearest `ghostchars.json` at or above a directory, bounded by its own
 * repository.
 *
 * The walk stops at the git top level containing the directory, and at the
 * filesystem root when there is none, so pointing the gate at a path can never
 * pick up a config belonging to some unrelated tree further up the disk. This is
 * the same search every linter does for its own config, and it means
 * `ghostchars check <dir>` finds the same config whether it is run from inside
 * `<dir>` or from anywhere else.
 */
function configAbove(start: string): string | undefined {
  // The repository bound is asked for lazily. In the ordinary case the config
  // sits in the directory that was named, and then no git process runs at all.
  let stop: string | undefined
  let asked = false
  let directory = start
  for (;;) {
    const candidate = join(directory, CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    if (!asked) {
      stop = gitToplevel(start)
      asked = true
    }
    if (directory === stop) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The distinct configs the positional paths point at, in the order given.
 *
 * Memoised by directory, because `ghostchars check $(changed files)` is the
 * ordinary CI shape and those files share a handful of directories between
 * them. The whole search only runs when the working directory's own root has no
 * config, so a repository that has one never reaches this at all.
 */
function configsForPaths(cwd: string, paths: readonly string[]): string[] {
  const seen = new Map<string, string | undefined>()
  const found: string[] = []
  for (const given of paths) {
    const directory = directoryOf(resolve(cwd, given))
    if (!seen.has(directory)) seen.set(directory, configAbove(directory))
    const candidate = seen.get(directory)
    if (candidate !== undefined && !found.includes(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Where the run is rooted and which config governs it.
 *
 * `--config` names the file and its directory becomes the root, so a config
 * carried outside a repository still describes the tree it sits beside.
 * Otherwise the root is the git top level, or the working directory when there
 * is no repository, and a `ghostchars.json` there is picked up. `--no-config`
 * wins over both and holds the whole tree to one bar.
 *
 * THE PATHS GET A SAY, AND USED NOT TO. Root and config were resolved from the
 * working directory alone, and `parsed.positionals` was consulted only
 * afterwards, to pick files. So `ghostchars check <dir>` run from anywhere other
 * than `<dir>`'s own root silently dropped `<dir>/ghostchars.json` and fell back
 * to the implicit single-surface, default-bar, zero-pin gate: a materially
 * weaker check reporting a clean pass, with no diagnostic anywhere and no
 * `--root` flag to work around it. Now, when the working directory's own root
 * has no config, the paths are asked. A single config among them is adopted
 * together with its directory as the root, which is what makes the pins and the
 * globs mean what their author wrote. Two different configs among the paths is
 * an error rather than a silent choice between them: one run has one root.
 */
function setUp(
  cwd: string,
  paths: readonly string[],
  configFlag: string | undefined,
  noConfig: boolean,
): Setup {
  if (!noConfig && configFlag !== undefined) {
    const configPath = resolve(cwd, configFlag)
    return { root: dirname(configPath), configPath, config: loadConfig(configPath) }
  }
  const root = gitToplevel(cwd) ?? cwd
  if (noConfig) return { root, configPath: null, config: null }
  const candidate = join(root, CONFIG_FILENAME)
  if (existsSync(candidate)) return { root, configPath: candidate, config: loadConfig(candidate) }

  const fromPaths = configsForPaths(cwd, paths)
  if (fromPaths.length > 1) throw new UsageError(strings.errConfigAmbiguous(fromPaths))
  const adopted = fromPaths[0]
  if (adopted === undefined) return { root, configPath: null, config: null }
  return { root: dirname(adopted), configPath: adopted, config: loadConfig(adopted) }
}

/**
 * Whether `--git` got what it asked for.
 *
 * With no path arguments the answer is simply whether discovery used git. With
 * path arguments discovery always walks, on purpose, so the question becomes
 * whether git was available at all: an absent git or a directory that is not a
 * repository is the condition `--git` exists to turn into a failure, and it does
 * not stop being that condition because a path was named.
 */
function gitIsUsable(root: string, hasPaths: boolean, discovery: Discovery): boolean {
  return hasPaths ? gitToplevel(root) !== undefined : discovery === 'git'
}

export function run(parsed: ParsedCommand): number {
  const values = parsed.values
  const cliBar = readGateBar(values)
  const floor = unionOptions(optionsForBar(cliBar), fromKeys(explicitOptionKeys(values)))
  const wantJson = values.bool('--json')
  const wantSarif = values.bool('--sarif')
  if (wantJson && wantSarif) throw new UsageError(strings.ERR_JSON_AND_SARIF)
  const verbose = values.bool('--verbose')
  const fix = values.bool('--fix')
  const limit = values.integer('--limit', DEFAULT_CHECK_LIMIT)
  const forceGit = values.bool('--git')
  const noGit = values.bool('--no-git')

  const cwd = process.cwd()
  const setup = setUp(cwd, parsed.positionals, values.string('--config'), values.bool('--no-config'))

  const maxBytes =
    values.string('--max-bytes') !== undefined
      ? values.integer('--max-bytes', DEFAULT_MAX_BYTES)
      : (setup.config?.maxBytes ?? DEFAULT_MAX_BYTES)

  const surfaces: GateSurface[] =
    setup.config === null
      ? [implicitSurface(floor)]
      : setup.config.surfaces.map((surface) => toGateSurface(surface, floor))

  // `--git` is the assertive flag: it says the run must use git or fail, so it
  // wins when both it and `--no-git` are given.
  const preferGit = forceGit ? true : noGit ? false : undefined
  const found = discover({ root: setup.root, cwd, paths: parsed.positionals, preferGit })
  // THE ASSERTION HOLDS WITH PATH ARGUMENTS TOO, AND USED NOT TO. This test was
  // gated on `parsed.positionals.length === 0`, so `--git --json <dir>` on a
  // machine with no git executable at all printed an ordinary report carrying
  // `"discovery": "walk"`, wrote nothing to stderr, and exited on findings
  // alone. The one job the flag exists for is stopping CI from silently
  // switching strategy between a container that has git and one that does not,
  // and a CI step that pins `--git` and then passes a changed-file list, which
  // is the ordinary shape, got exactly that silent switch. Discovery for
  // explicit paths is a walk by design, so what is asserted with paths is that
  // git COULD have been used: it is on PATH and the root is a repository.
  if (forceGit && !gitIsUsable(setup.root, parsed.positionals.length > 0, found.discovery)) {
    throw new UsageError(
      gitOnPath(setup.root)
        ? strings.errGitNotARepository(setup.root)
        : strings.ERR_GIT_MISSING,
    )
  }

  let outcome = scan(found.files, surfaces, setup.root, limit, maxBytes)
  if (fix) {
    const fixedCount = applyFix(outcome, maxBytes)
    errLine(strings.checkFixed(fixedCount))
    outcome = scan(found.files, surfaces, setup.root, limit, maxBytes)
  }

  for (const message of [...found.errors, ...outcome.errors]) errLine(message)

  const code = worst(
    outcome.failures.length > 0 ? EXIT_FINDINGS : EXIT_OK,
    found.errors.length + outcome.errors.length > 0 ? EXIT_USAGE : EXIT_OK,
  )

  if (wantSarif) {
    out(serializeJson(toSarif(outcome.failures.map((record) => record.json), setup.root)))
  } else if (wantJson) {
    printJson(
      outcome,
      surfaces,
      outcome.counts,
      setup.root,
      found.discovery,
      setup.configPath,
      code,
      verbose,
    )
  } else {
    printHuman(outcome, surfaces, floor, verbose, setup.configPath)
  }
  return code
}
