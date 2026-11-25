/**
 * Turning a `ghostchars.json` surface into a resolved {@link GateSurface}.
 *
 * WHY THIS IS ITS OWN MODULE. Two callers build surfaces, and they must build
 * them identically: `ghostchars check` on the command line, and the MCP
 * `check_paths` tool. When these lived privately inside `src/commands/check.ts`
 * the MCP tool could not reach them, so it grew a second, smaller gate with no
 * config, no surfaces and no pins. An agent asking `check_paths` about a
 * repository then got a different answer from the one CI would give it about
 * the same files, which is the worst possible failure for a gate: not wrong
 * loudly, but quietly disagreeing with itself.
 *
 * THE COMMAND LINE IS A FLOOR, NOT AN OVERRIDE. A surface sets its own bar.
 * Whatever the caller asked for is unioned UNDER every surface, never over it.
 * That follows the package's single resolution rule, that an option can only be
 * turned on, and it means `--bar text` means the same thing in a repository that
 * has a config as in one that does not. Because `optionsForBar('default')` is
 * all-false, a caller who asked for nothing adds nothing.
 */
import { isAbsolute } from 'node:path'

import { CLEAN_OPTION_KEYS, type CleanOptionKey, type CleanOptions } from '@ghostchars/engine'

import { optionNames, optionsForBar, resolveCleanOptions, type GateBar } from '../options.js'

import { IMPLICIT_SURFACE_ID, MATCH_EVERYTHING, type SurfaceConfig } from './config.js'
import { compileGlobs } from './glob.js'
import type { GateSurface } from './gate.js'

export function fromKeys(keys: readonly CleanOptionKey[]): CleanOptions {
  return resolveCleanOptions({ explicit: keys })
}

export function unionOptions(first: CleanOptions, second: CleanOptions): CleanOptions {
  const merged = { ...first }
  for (const key of CLEAN_OPTION_KEYS) if (second[key]) merged[key] = true
  return merged
}

/**
 * The word the human output uses for a resolved option set.
 *
 * `text` when everything the text bar turns on is on, `default` otherwise. The
 * JSON payload carries the exact option list beside it, so nothing is lost:
 * this is the summary line's vocabulary, not the record.
 */
export function barLabel(options: CleanOptions): GateBar {
  const text = optionsForBar('text')
  return CLEAN_OPTION_KEYS.every((key) => !text[key] || options[key]) ? 'text' : 'default'
}

export function toGateSurface(surface: SurfaceConfig, floor: CleanOptions): GateSurface {
  const own =
    surface.bar === undefined ? fromKeys(surface.options ?? []) : optionsForBar(surface.bar)
  const options = unionOptions(own, floor)
  const include = compileGlobs(surface.include)
  const exclude = compileGlobs(surface.exclude)
  return {
    id: surface.id,
    bar: barLabel(options),
    options,
    optionKeys: optionNames(options),
    decodeEscapes: surface.decodeEscapes,
    pins: surface.pins,
    // An exclusion wins over everything this surface would otherwise claim,
    // including a path the user named on the command line.
    matches: (relative: string): boolean => include(relative) && !exclude(relative),
  }
}

/** The single surface a run with no config file holds the whole tree to. */
export function implicitSurface(options: CleanOptions): GateSurface {
  const include = compileGlobs([MATCH_EVERYTHING])
  return {
    id: IMPLICIT_SURFACE_ID,
    bar: barLabel(options),
    options,
    optionKeys: optionNames(options),
    decodeEscapes: false,
    pins: {},
    // A file named outside the root has a `../` path, which no glob claims.
    // With no config there is no author whose scope that would honour, only a
    // user who named the file, so the implicit surface claims it anyway.
    // `ghostchars check --no-git ../elsewhere/a.md` used to report "0 files
    // pass" and exit 0 on a file it never read.
    matches: (relative: string): boolean => isOutsideRoot(relative) || include(relative),
  }
}

/** True for a root-relative path that climbs out of the root. */
export function isOutsideRoot(relative: string): boolean {
  return relative === '..' || relative.startsWith('../') || isAbsolute(relative)
}
