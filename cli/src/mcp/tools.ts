/**
 * The five tools, and the one function that registers them.
 *
 * WHY BARE, VERB-FIRST NAMES. `clean_text`, not `ghostchars_clean_text`. Hosts
 * that flatten namespaces already prefix with the server name (Claude Code
 * shows `mcp__ghostchars__clean_text`), so our own prefix would double-namespace
 * in the common case and cost tokens in every `tools/list` payload. Every
 * description opens with the word Ghostchars, because that is the first token a
 * model reads when it picks a tool out of a list of forty. `--tool-prefix`
 * renames all of them for a genuine collision.
 *
 * WHY `clean_files` IS UNREGISTERED RATHER THAN REFUSING. An agent must never
 * discover a tool that will always fail, because it will plan around it. With
 * `--allow-write` absent the tool does not exist; with it present, it writes.
 *
 * WHY EVERY TOOL RETURNS BOTH `content` AND `structuredContent`. A host that
 * shows only content blocks has to be able to hand the text to the model, and a
 * host that consumes only structured output has to be able to write the file.
 * For `clean_text` the cleaned text therefore appears twice when it changed,
 * and in neither place when it did not, which is the common case for an agent
 * checking its own output and keeps that case near-free.
 *
 * `check_paths` IS THE SAME GATE `ghostchars check` IS. It runs `src/check/`:
 * the same discovery walker, the same four-gate text detection, the same
 * `ghostchars.json` loader and validator, the same surfaces, the same
 * bidirectional pins, the same findings-count change measure. It does not
 * reimplement any of it. That matters more here than anywhere else in the
 * package: an agent that asks `check_paths` about a repository and then watches
 * CI run `ghostchars check` over the same files must get the same answer, and
 * two implementations of a gate are two gates that will eventually disagree.
 * The only thing this surface adds is root confinement, because a tool call is
 * not a shell the user typed.
 *
 * NO DOCUMENTS ANYWHERE IN THIS FILE. A gate walking a repository must not open
 * zip archives, `.docx` and `.odt` are on the binary-extension list, and an
 * agent's text is prose rather than a package.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'

import { CLEAN_OPTION_KEYS, clean, enabledFlags, scan, toCodePoints } from '@ghostchars/engine'
import type { CleanOptions, Finding } from '@ghostchars/engine'
import { analyzeStyle } from '@ghostchars/engine/style'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { DEFAULT_MAX_BYTES } from '../args.js'
import { CONFIG_FILENAME, loadConfig } from '../check/config.js'
import { discover } from '../check/discover.js'
import { evaluateFile, surfaceFor, type GateSurface } from '../check/gate.js'
import { hasBinaryExtension, hasNulByte } from '../check/istext.js'
import { implicitSurface, toGateSurface } from '../check/surfaces.js'
import { checkFailureBlock, showBlock, showLine, styleBlock } from '../format.js'
import { decodeUtf8, writeAtomic } from '../io.js'
import type { CheckFailureJson } from '../json.js'
import { namedAll, toFinding } from '../names.js'
import { optionNames, resolveCleanOptions } from '../options.js'
import type { Bar, CleanOptionKey, GateBar } from '../options.js'
import { payloadLines, payloadsIn, payloadsJson } from '../payloads.js'
import { cpLength, rewriteSites } from '../positions.js'
import * as strings from '../strings.js'

import {
  CHECK_PATHS_INPUT,
  CHECK_PATHS_OUTPUT,
  CLEAN_FILES_INPUT,
  CLEAN_FILES_OUTPUT,
  CLEAN_TEXT_INPUT,
  CLEAN_TEXT_OUTPUT,
  INSPECT_TEXT_INPUT,
  INSPECT_TEXT_OUTPUT,
  STYLE_REPORT_INPUT,
  STYLE_REPORT_OUTPUT,
} from './schemas.js'

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** The unprefixed tool names, in the order they are registered. */
export const TOOL_NAMES = {
  cleanText: 'clean_text',
  inspectText: 'inspect_text',
  styleReport: 'style_report',
  checkPaths: 'check_paths',
  cleanFiles: 'clean_files',
} as const

/**
 * What every read-only tool declares. `openWorldHint: false` is the honest one:
 * this package makes no network call of any kind.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** `clean_files` writes. It still never deletes and is still idempotent. */
const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** How many finding rows the changed-text content block carries. */
const CONTENT_FINDING_ROWS = 10

/** What the tools call text that arrived over the wire rather than from a file. */
const WIRE_LABEL = strings.STDIN_LABEL

/** The thirteen overrides, as the schema hands them over. */
export type OptionOverrides = { readonly [K in CleanOptionKey]?: boolean | undefined }

/** What `registerTools` needs to know. A subset of the server's own options. */
export interface ToolOptions {
  /** Register `clean_files`, which writes to disk. */
  readonly allowWrite: boolean
  /** Prepended to every tool name. Empty by default. */
  readonly toolPrefix: string
  /** The directory every tool path is resolved against and confined to. */
  readonly root: string
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/**
 * The bar sets the baseline and an override can only turn an option ON, which
 * is the CLI's resolution order with steps 1, 2 and 4 and no `--max` alias.
 */
function optionsFrom(bar: Bar | GateBar, overrides: OptionOverrides | undefined): CleanOptions {
  const explicit = CLEAN_OPTION_KEYS.filter((key) => overrides?.[key] === true)
  return resolveCleanOptions({ bar, explicit })
}

function textBlocks(...texts: readonly string[]): CallToolResult['content'] {
  return texts.map((text) => ({ type: 'text', text }))
}

/** A tool that cannot do what it was asked. `isError` skips output validation. */
function toolError(message: string): CallToolResult {
  return { content: textBlocks(message), isError: true }
}

function findingJson(finding: Finding): Record<string, unknown> {
  const base = {
    line: finding.line,
    col: finding.col,
    cp: finding.cp,
    u: strings.codepointLabel(finding.cp),
    name: finding.name,
    kind: finding.kind,
    flag: finding.flag,
    action: finding.action,
  }
  return finding.replacement === undefined ? base : { ...base, replacement: finding.replacement }
}

/**
 * Every suspicious character in `text`, with actions resolved under `options`.
 *
 * `toFinding` is `src/names.ts`'s wrapper, so an agent reading a finding over
 * the wire gets the same name column the CLI prints, look-alike letters
 * included.
 */
function findingsUnder(text: string, options: CleanOptions): Finding[] {
  const enabled = enabledFlags(options)
  return scan(toCodePoints(text)).map((hit) => toFinding(hit, enabled))
}

function summaryJson(summary: {
  readonly removed: number
  readonly replaced: number
  readonly keptLoadBearing: number
  readonly foundNotTargeted: number
}): Record<string, number> {
  return {
    removed: summary.removed,
    replaced: summary.replaced,
    kept_load_bearing: summary.keptLoadBearing,
    found_not_targeted: summary.foundNotTargeted,
  }
}

function siteJson(site: {
  readonly line: number
  readonly col: number
  readonly u: string
  readonly name: string
  readonly hint: string
}): Record<string, unknown> {
  return { line: site.line, col: site.col, u: site.u, name: site.name, hint: site.hint }
}

// ---------------------------------------------------------------------------
// clean_text
// ---------------------------------------------------------------------------

export function cleanTextResult(
  text: string,
  bar: Bar,
  overrides: OptionOverrides | undefined,
  cap: number,
): CallToolResult {
  const options = optionsFrom(bar, overrides)
  const result = clean(text, options)
  const changed = result.text !== text
  const before = cpLength(text)
  const after = cpLength(result.text)
  // `max_findings` caps the rewrite sites too. One record per dash, each with a
  // quoted source line, is unbounded in exactly the way the findings list is,
  // and a single 200 KB paragraph of dashes built a 23 MB response before this
  // cap existed. The total is still counted and reported, so nothing is
  // truncated in silence.
  const sites = rewriteSites(text, options, undefined, cap)
  // The engine's own findings, with the name column filled in for a look-alike
  // letter. `clean()` builds them with the engine's `toFinding`, which cannot
  // reach this package's supplementary name table, so the list is renamed on
  // the way out rather than every reader having to remember to do it.
  const findings = namedAll(result.findings)
  const shown = findings.slice(0, cap)
  const payloads = payloadsIn(text)
  const hidden = payloadLines(text, payloads)

  const structuredContent = {
    changed,
    ...(changed ? { cleaned: result.text } : {}),
    chars_before: before,
    chars_after: after,
    options_applied: optionNames(options),
    summary: summaryJson(result.summary),
    rewrite_sites: sites.sites.map(siteJson),
    rewrite_sites_total: sites.total,
    rewrite_sites_truncated: sites.sites.length < sites.total,
    findings: shown.map(findingJson),
    findings_total: findings.length,
    findings_truncated: shown.length < findings.length,
    payloads: payloadsJson(text, payloads),
  }

  if (!changed) {
    return {
      content: textBlocks([strings.mcpNoChanges(bar), ...hidden].join('\n')),
      structuredContent,
    }
  }

  const acted = result.summary.removed + result.summary.replaced
  const verdict = [
    strings.mcpChanged(bar, acted, before - after),
    ...findings.slice(0, CONTENT_FINDING_ROWS).map(showLine),
    ...sites.sites
      .slice(0, CONTENT_FINDING_ROWS)
      .map((site) => strings.mcpRewriteSite(site.u, site.name, site.line, site.col)),
    ...hidden,
    strings.MCP_CLEANED_TEXT_NOTE,
  ].join('\n')

  // Two blocks on purpose: the second one is the cleaned text and nothing else,
  // so a model can copy it without unescaping anything.
  return { content: textBlocks(verdict, result.text), structuredContent }
}

// ---------------------------------------------------------------------------
// inspect_text
// ---------------------------------------------------------------------------

export function inspectTextResult(
  text: string,
  bar: Bar,
  overrides: OptionOverrides | undefined,
  cap: number,
): CallToolResult {
  const options = optionsFrom(bar, overrides)
  const findings = findingsUnder(text, options)
  const shown = findings.slice(0, cap)
  const payloads = payloadsIn(text)

  const byKind = new Map<string, { kind: string; flag: string; count: number }>()
  for (const finding of findings) {
    // Written as an escape, not as the character. A raw U+0000 in the source
    // makes grep call this file binary and refuse to search it, and a package
    // whose subject is invisible characters should not carry one in its own
    // text. The runtime string is byte-identical either way.
    const key = `${finding.kind}\u0000${finding.flag}`
    const entry = byKind.get(key)
    if (entry === undefined) byKind.set(key, { kind: finding.kind, flag: finding.flag, count: 1 })
    else entry.count += 1
  }

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

  return {
    content: textBlocks(
      [...showBlock(WIRE_LABEL, findings, cap), ...payloadLines(text, payloads)].join('\n'),
    ),
    structuredContent: {
      clean: findings.length === 0,
      total: findings.length,
      returned: shown.length,
      truncated: shown.length < findings.length,
      summary: summaryJson({ removed, replaced, keptLoadBearing, foundNotTargeted }),
      by_kind: [...byKind.values()],
      findings: shown.map(findingJson),
      payloads: payloadsJson(text, payloads),
    },
  }
}

// ---------------------------------------------------------------------------
// style_report
// ---------------------------------------------------------------------------

export function styleReportResult(text: string): CallToolResult {
  const report = analyzeStyle(text)
  return {
    content: textBlocks(styleBlock(WIRE_LABEL, text, report).join('\n')),
    structuredContent: { ...report },
  }
}

// ---------------------------------------------------------------------------
// path confinement
// ---------------------------------------------------------------------------

/** `realpath`, or the path itself when it does not exist yet. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Resolve `candidate` against `root` and refuse anything outside it.
 *
 * Both sides go through `realpath` first, so a symlink pointing out of the tree
 * is refused rather than followed. A path that does not exist yet resolves to
 * itself, which is the right answer: it is judged on where it would be.
 */
function confine(root: string, candidate: string): string | null {
  const realRoot = realOrSelf(resolve(root))
  const resolved = realOrSelf(resolve(realRoot, candidate))
  if (resolved === realRoot) return resolved
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  return resolved.startsWith(prefix) ? resolved : null
}

/** The path a caller sees back: relative to the root, with forward slashes. */
function displayPath(root: string, absolute: string): string {
  const rel = relative(realOrSelf(resolve(root)), absolute)
  return rel === '' ? '.' : rel.split(sep).join(posix.sep)
}

// ---------------------------------------------------------------------------
// text detection, for clean_files
// ---------------------------------------------------------------------------

type SkipReason = 'binary-ext' | 'too-large' | 'binary' | 'not-utf8' | 'unreadable'

type Detected = { readonly text: string } | { readonly skip: SkipReason }

/**
 * The four gates, cheapest first, for a file `clean_files` was handed.
 *
 * `check_paths` does NOT come through here: it runs the real gate in
 * `src/check/`, which has the same four gates plus the named-versus-discovered
 * asymmetry a walk needs. This is the write tool's copy, and it exists because
 * `clean_files` is given an explicit list and has no walk, no surfaces and no
 * pins to consult. The lists and the threshold are imported rather than
 * repeated, so the two can only ever disagree about policy, never about facts.
 */
function detectText(path: string): Detected {
  if (hasBinaryExtension(path)) return { skip: 'binary-ext' }
  let bytes: Buffer
  try {
    if (statSync(path).size > DEFAULT_MAX_BYTES) return { skip: 'too-large' }
    bytes = readFileSync(path)
  } catch {
    return { skip: 'unreadable' }
  }
  if (hasNulByte(bytes)) return { skip: 'binary' }
  const text = decodeUtf8(bytes)
  return text === null ? { skip: 'not-utf8' } : { text }
}

// ---------------------------------------------------------------------------
// check_paths
// ---------------------------------------------------------------------------

/**
 * Which surfaces govern this run.
 *
 * Exactly the resolution `ghostchars check` does, through exactly the same
 * functions: an explicit `config` path, else a `ghostchars.json` at the root,
 * else one implicit surface covering everything. The caller's `bar` and
 * `options` are the FLOOR under whatever comes back, never an override, so
 * asking for `bar: "text"` in a repository whose config already sets `text`
 * changes nothing, and asking for it in one that does not raises the whole tree
 * to it.
 */
function surfacesFor(
  realRoot: string,
  configPath: string | undefined,
  floor: CleanOptions,
): { readonly surfaces: readonly GateSurface[]; readonly config: string | null } {
  const explicit = configPath === undefined ? undefined : resolve(realRoot, configPath)
  const discovered = join(realRoot, CONFIG_FILENAME)
  const path = explicit ?? (existsSync(discovered) ? discovered : undefined)
  if (path === undefined) return { surfaces: [implicitSurface(floor)], config: null }
  const config = loadConfig(path)
  return { surfaces: config.surfaces.map((surface) => toGateSurface(surface, floor)), config: path }
}

export function checkPathsResult(
  root: string,
  paths: readonly string[],
  bar: GateBar,
  overrides: OptionOverrides | undefined,
  configPath: string | undefined,
  maxFiles: number,
  maxHits: number,
): CallToolResult {
  const floor = optionsFrom(bar, overrides)
  const realRoot = realOrSelf(resolve(root))

  // Confinement happens BEFORE anything is read, and on every path, so a
  // symlink pointing out of the tree is refused rather than followed: `confine`
  // realpaths both sides, which the discovery walker deliberately does not.
  for (const given of paths) {
    if (confine(realRoot, given) === null) {
      return toolError(strings.errPathOutsideRoot(given, realRoot))
    }
  }

  // Discovery gets the caller's OWN strings, not the confined absolutes. It
  // resolves them against the root exactly as `confine` did, so it reaches the
  // same files, and it echoes a named path back as the caller wrote it. Handing
  // it absolutes made every failure report an absolute path out of the server's
  // temp root, when the whole contract of this tool is that paths are relative
  // to the root going in and coming back.

  let surfaces: readonly GateSurface[]
  let config: string | null
  try {
    ;({ surfaces, config } = surfacesFor(realRoot, configPath, floor))
  } catch (error) {
    // A malformed ghostchars.json is the caller's problem to fix, and the
    // message already names the JSON path and the offending key.
    return toolError(error instanceof Error ? error.message : String(error))
  }

  const found = discover({ root: realRoot, cwd: realRoot, paths, preferGit: false })
  const truncated = found.files.length > maxFiles
  const considered = found.files.slice(0, maxFiles)

  const failures: CheckFailureJson[] = []
  const errors: string[] = [...found.errors]
  let scanned = 0
  let skipped = 0
  for (const file of considered) {
    const surface = surfaceFor(surfaces, file.relative)
    // A path no surface claims is out of scope: not scanned, not skipped, not
    // counted. The config author decided that on purpose.
    if (surface === undefined) continue
    const verdict = evaluateFile(file, surface, maxHits, DEFAULT_MAX_BYTES)
    if (verdict.kind === 'skipped') {
      skipped += 1
      continue
    }
    if (verdict.kind === 'error') {
      errors.push(verdict.message)
      continue
    }
    scanned += 1
    if (verdict.kind === 'failed') failures.push(verdict.failure)
  }

  const lines: string[] = []
  for (const failure of failures) lines.push(...checkFailureBlock(failure))
  lines.push(
    failures.length === 0
      ? strings.mcpCheckPassed(scanned, bar)
      : strings.mcpCheckFailed(failures.length, bar),
  )
  lines.push(...errors)

  return {
    content: textBlocks(lines.join('\n')),
    structuredContent: {
      ok: failures.length === 0 && errors.length === 0,
      root: realRoot,
      config,
      files_scanned: scanned,
      files_skipped: skipped,
      files_failing: failures.length,
      truncated,
      failures: failures.map((failure) => ({
        path: failure.path,
        bar: failure.bar,
        status: failure.status,
        changed: failure.changed,
        pinned: failure.pinned,
        hits: failure.hits.map((hit) => ({
          line: hit.line,
          col: hit.col,
          u: hit.u,
          name: hit.name,
          line_text: hit.lineText,
        })),
        payloads: failure.payloads,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// clean_files
// ---------------------------------------------------------------------------

/**
 * The rewrite sites `clean_files` builds per file.
 *
 * `clean_files` takes no `max_findings`: its answer is which files changed, and
 * the sites are the follow-up the agent acts on afterwards. So the cap is a
 * constant rather than a knob, and it is the same number `clean_text` defaults
 * to. A caller who wants every site for one file calls `clean_text` on it.
 */
const MAX_REWRITE_SITES_PER_FILE = 50

interface CleanedFile {
  readonly path: string
  readonly removed: number
  readonly replaced: number
  readonly chars_delta: number
  readonly rewrite_sites: readonly Record<string, unknown>[]
  readonly rewrite_sites_total: number
}

export function cleanFilesResult(
  root: string,
  paths: readonly string[],
  bar: Bar,
  overrides: OptionOverrides | undefined,
  dryRun: boolean,
): CallToolResult {
  const options = optionsFrom(bar, overrides)
  const realRoot = realOrSelf(resolve(root))

  const changed: CleanedFile[] = []
  const unchanged: string[] = []
  const skipped: { path: string; reason: string }[] = []
  let delta = 0

  for (const given of paths) {
    const absolute = confine(realRoot, given)
    if (absolute === null) return toolError(strings.errPathOutsideRoot(given, realRoot))
    const display = displayPath(realRoot, absolute)
    const detected = detectText(absolute)
    if ('skip' in detected) {
      skipped.push({ path: display, reason: detected.skip })
      continue
    }
    const text = detected.text
    const result = clean(text, options)
    // An unchanged file is never opened for writing, so its mtime and inode
    // survive. That is the reference implementation's behaviour and the reason
    // a repeated run over a clean tree costs nothing.
    if (result.text === text) {
      unchanged.push(display)
      continue
    }
    if (!dryRun) {
      try {
        writeAtomic(absolute, result.text)
      } catch {
        skipped.push({ path: display, reason: 'unwritable' })
        continue
      }
    }
    delta += cpLength(text) - cpLength(result.text)
    const sites = rewriteSites(text, options, undefined, MAX_REWRITE_SITES_PER_FILE)
    changed.push({
      path: display,
      removed: result.summary.removed,
      replaced: result.summary.replaced,
      chars_delta: cpLength(text) - cpLength(result.text),
      rewrite_sites: sites.sites.map(siteJson),
      rewrite_sites_total: sites.total,
    })
  }

  // Three different sentences for three different facts, none of them claiming
  // a write that did not happen: a dry run says what WOULD be cleaned, a real
  // run says what it cleaned and by how much, and a run that found nothing says
  // the files pass.
  const headline =
    changed.length === 0
      ? strings.mcpCheckPassed(unchanged.length, bar)
      : dryRun
        ? strings.mcpFilesWouldChange(changed.length, bar)
        : strings.mcpFilesCleaned(changed.length, bar, delta)

  return {
    content: textBlocks([headline, ...changed.map((entry) => `  ${entry.path}`)].join('\n')),
    structuredContent: { changed, unchanged, skipped },
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/**
 * Register every tool this server offers and return their names.
 *
 * The caller uses the returned list for the readiness line, and
 * `mcp.stdio.test.ts` asserts that `tools/list` returns exactly it.
 */
export function registerTools(server: McpServer, options: ToolOptions): string[] {
  const named = (name: string): string => `${options.toolPrefix}${name}`
  const registered: string[] = []

  server.registerTool(
    named(TOOL_NAMES.cleanText),
    {
      description: strings.TOOL_DESCRIPTIONS.clean_text,
      inputSchema: CLEAN_TEXT_INPUT,
      outputSchema: CLEAN_TEXT_OUTPUT,
      annotations: { ...READ_ONLY },
    },
    (args) => cleanTextResult(args.text, args.bar, args.options, args.max_findings),
  )
  registered.push(named(TOOL_NAMES.cleanText))

  server.registerTool(
    named(TOOL_NAMES.inspectText),
    {
      description: strings.TOOL_DESCRIPTIONS.inspect_text,
      inputSchema: INSPECT_TEXT_INPUT,
      outputSchema: INSPECT_TEXT_OUTPUT,
      annotations: { ...READ_ONLY },
    },
    (args) => inspectTextResult(args.text, args.bar, args.options, args.max_findings),
  )
  registered.push(named(TOOL_NAMES.inspectText))

  server.registerTool(
    named(TOOL_NAMES.styleReport),
    {
      description: strings.TOOL_DESCRIPTIONS.style_report,
      inputSchema: STYLE_REPORT_INPUT,
      outputSchema: STYLE_REPORT_OUTPUT,
      annotations: { ...READ_ONLY },
    },
    (args) => styleReportResult(args.text),
  )
  registered.push(named(TOOL_NAMES.styleReport))

  server.registerTool(
    named(TOOL_NAMES.checkPaths),
    {
      description: strings.TOOL_DESCRIPTIONS.check_paths,
      inputSchema: CHECK_PATHS_INPUT,
      outputSchema: CHECK_PATHS_OUTPUT,
      annotations: { ...READ_ONLY },
    },
    (args) =>
      checkPathsResult(
        options.root,
        args.paths,
        args.bar,
        args.options,
        args.config,
        args.max_files,
        args.max_findings_per_file,
      ),
  )
  registered.push(named(TOOL_NAMES.checkPaths))

  if (options.allowWrite) {
    server.registerTool(
      named(TOOL_NAMES.cleanFiles),
      {
        description: strings.TOOL_DESCRIPTIONS.clean_files,
        inputSchema: CLEAN_FILES_INPUT,
        outputSchema: CLEAN_FILES_OUTPUT,
        annotations: { ...WRITES },
      },
      (args) =>
        cleanFilesResult(options.root, args.paths, args.bar, args.options, args.dry_run),
    )
    registered.push(named(TOOL_NAMES.cleanFiles))
  }

  return registered
}
