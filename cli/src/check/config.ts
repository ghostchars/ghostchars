/**
 * `ghostchars.json`: read, and validated by hand.
 *
 * WHY JSON AND NOT A JS OR TOML FILE. `JSON.parse` is built in, this package
 * ships zero runtime dependencies, and a config that can execute code is a
 * config a CI runner has to trust.
 *
 * WHY HAND-WRITTEN GUARDS AND NOT ZOD. zod is a devDependency bundled only into
 * the MCP output; the CLI bundle must stay small and dependency free. The lint
 * config also bans `as` outright, so every value crossing this boundary is
 * narrowed by a predicate rather than asserted into shape. That is more code
 * and it is the code that turns a typo into a sentence.
 *
 * WHY AN UNKNOWN KEY IS AN ERROR. A misspelled `pins` key that is silently
 * ignored produces a gate that passes for the wrong reason, which is the worst
 * outcome a gate has. Every rejection names the JSON path it happened at and
 * lists the keys that would have worked, and every rejection exits 2.
 */
import { readFileSync } from 'node:fs'

import { CLEAN_OPTION_KEYS, type CleanOptionKey } from '@ghostchars/engine'

import { UsageError } from '../exit.js'
import { GATE_BARS, isGateBar, type GateBar } from '../options.js'
import * as strings from '../strings.js'

/** The name looked for at the root when `--config` was not given. */
export const CONFIG_FILENAME = 'ghostchars.json'

/** The only version this build understands. */
export const CONFIG_VERSION = 1

/** The id given to the single surface a run with no config file uses. */
export const IMPLICIT_SURFACE_ID = 'all'

/** The include list that implicit surface carries. */
export const MATCH_EVERYTHING = '**/*'

const TOP_LEVEL_KEYS = ['version', 'surfaces', 'maxBytes'] as const
const SURFACE_KEYS = ['id', 'bar', 'options', 'include', 'exclude', 'decodeEscapes', 'pins'] as const

/** One surface, exactly as the file declared it. */
export interface SurfaceConfig {
  readonly id: string
  readonly bar?: GateBar
  readonly options?: readonly CleanOptionKey[]
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly decodeEscapes: boolean
  readonly pins: Readonly<Record<string, number>>
}

export interface GateConfig {
  readonly version: number
  readonly surfaces: readonly SurfaceConfig[]
  readonly maxBytes?: number
}

// ---------------------------------------------------------------------------
// narrowing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isOptionKey(value: unknown): value is CleanOptionKey {
  return typeof value === 'string' && CLEAN_OPTION_KEYS.some((key) => key === value)
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Load and validate a config file.
 *
 * Throws {@link UsageError}, which `src/cli.ts` turns into one line on stderr
 * and exit 2. Nothing here writes to a stream itself.
 */
export function loadConfig(configPath: string): GateConfig {
  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const message = strings.errnoMessage(typeof code === 'string' ? code : undefined)
    throw new UsageError(strings.errConfigProblem(configPath, 'file', message))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'could not be parsed'
    throw new UsageError(strings.errConfigProblem(configPath, 'file', `is not valid JSON. ${detail}`))
  }

  return validate(parsed, configPath)
}

function fail(configPath: string, where: string, problem: string): never {
  throw new UsageError(strings.errConfigProblem(configPath, where, problem))
}

function validate(parsed: unknown, configPath: string): GateConfig {
  if (!isRecord(parsed)) {
    fail(configPath, 'the file', 'must be a JSON object with a version and a surfaces list')
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.some((known) => known === key)) {
      fail(configPath, 'the file', strings.errConfigUnknownKey(key, TOP_LEVEL_KEYS))
    }
  }

  const version = parsed['version']
  if (version !== CONFIG_VERSION) {
    fail(configPath, 'version', `must be the number ${CONFIG_VERSION}`)
  }

  const rawSurfaces = parsed['surfaces']
  if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
    fail(configPath, 'surfaces', 'must be a non-empty array of surface objects')
  }

  const surfaces: SurfaceConfig[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rawSurfaces.length; i += 1) {
    const surface = readSurface(rawSurfaces[i], `surfaces[${i}]`, configPath)
    if (seen.has(surface.id)) {
      fail(configPath, `surfaces[${i}].id`, `is used twice. Every surface id must be unique`)
    }
    seen.add(surface.id)
    surfaces.push(surface)
  }

  const rawMaxBytes = parsed['maxBytes']
  if (rawMaxBytes !== undefined && (!isWholeNumber(rawMaxBytes) || rawMaxBytes === 0)) {
    fail(configPath, 'maxBytes', 'must be a whole number greater than zero')
  }

  return rawMaxBytes === undefined
    ? { version: CONFIG_VERSION, surfaces }
    : { version: CONFIG_VERSION, surfaces, maxBytes: readNumber(rawMaxBytes) }
}

/** Narrow a value already proven to be a whole number, without a cast. */
function readNumber(value: unknown): number {
  return isWholeNumber(value) ? value : 0
}

function readSurface(raw: unknown, where: string, configPath: string): SurfaceConfig {
  if (!isRecord(raw)) fail(configPath, where, 'must be an object')
  for (const key of Object.keys(raw)) {
    if (!SURFACE_KEYS.some((known) => known === key)) {
      fail(configPath, where, strings.errConfigUnknownKey(key, SURFACE_KEYS))
    }
  }

  const id = raw['id']
  if (typeof id !== 'string' || id === '') fail(configPath, `${where}.id`, 'must be a non-empty string')

  const rawBar = raw['bar']
  const rawOptions = raw['options']
  if (rawBar !== undefined && rawOptions !== undefined) {
    fail(configPath, where, 'sets both bar and options. Set exactly one of them')
  }
  if (rawBar === undefined && rawOptions === undefined) {
    fail(configPath, where, 'sets neither bar nor options. Set exactly one of them')
  }

  let bar: GateBar | undefined
  if (rawBar !== undefined) {
    if (typeof rawBar !== 'string' || !isGateBar(rawBar)) {
      fail(configPath, `${where}.bar`, `must be one of ${GATE_BARS.join(', ')}. The gate has no max bar`)
    }
    bar = rawBar
  }

  let options: CleanOptionKey[] | undefined
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions) || !rawOptions.every(isOptionKey)) {
      fail(configPath, `${where}.options`, `must be an array of: ${CLEAN_OPTION_KEYS.join(', ')}`)
    }
    options = rawOptions.filter(isOptionKey)
  }

  const rawInclude = raw['include']
  if (!isStringArray(rawInclude) || rawInclude.length === 0) {
    fail(configPath, `${where}.include`, 'must be a non-empty array of glob strings')
  }

  const rawExclude = raw['exclude']
  if (rawExclude !== undefined && !isStringArray(rawExclude)) {
    fail(configPath, `${where}.exclude`, 'must be an array of glob strings')
  }

  const rawDecode = raw['decodeEscapes']
  if (rawDecode !== undefined && typeof rawDecode !== 'boolean') {
    fail(configPath, `${where}.decodeEscapes`, 'must be true or false')
  }

  const pins = readPins(raw['pins'], `${where}.pins`, configPath)

  const base = {
    id,
    include: isStringArray(rawInclude) ? rawInclude : [],
    exclude: isStringArray(rawExclude) ? rawExclude : [],
    decodeEscapes: rawDecode === true,
    pins,
  }
  if (bar !== undefined) return { ...base, bar }
  return { ...base, options: options ?? [] }
}

function readPins(
  raw: unknown,
  where: string,
  configPath: string,
): Readonly<Record<string, number>> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    fail(configPath, where, 'must be an object mapping a repository-relative path to a count')
  }
  const pins: Record<string, number> = {}
  for (const [path, count] of Object.entries(raw)) {
    if (!isWholeNumber(count)) {
      fail(configPath, `${where}['${path}']`, 'must be a whole number of characters, zero or more')
    }
    pins[path] = readNumber(count)
  }
  return pins
}
