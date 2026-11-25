#!/usr/bin/env node
// The logic of the ghostchars GitHub Action, as one dependency-free script.
//
// action.yml installs the CLI and runs this file. Everything that decides what
// gets scanned, what fails the job, and what the job summary says lives here,
// so the same logic runs on a runner and in a local test.
//
// Environment:
//   GHOSTCHARS_CLI         absolute path to the CLI entry point (dist/cli.js)
//   GHOSTCHARS_PATHS       files or directories to scan, one per line
//   GHOSTCHARS_FAIL_ON     payload | hidden | any | never (default hidden)
//   GHOSTCHARS_SARIF       true | false (default true)
//   GHOSTCHARS_SARIF_FILE  where to write the SARIF log (default RUNNER_TEMP)
//   GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT,
//   RUNNER_TEMP            set by the runner
//
// Exit codes: 0 when the job passes, 1 when findings reach the fail-on
// threshold, 2 when the scan itself could not run or the CLI reported an
// error such as an unreadable file or a broken ghostchars.json.
//
// Every string that comes from a scanned file (paths and decoded messages) is
// untrusted. It is escaped before it reaches the job summary or the log, so it
// cannot render as Markdown or HTML, close a code fence, or start a workflow
// command.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FAIL_ON_VALUES = ['payload', 'hidden', 'any', 'never']

/**
 * Directories coding agents read rules, skills and prompts from. Scanned on
 * every run, at any depth, even when the pull request did not touch them. The
 * CLI's own walk enters the same directories.
 */
export const AGENT_DIRECTORIES = [
  '.agents',
  '.claude',
  '.clinerules',
  '.codex',
  '.continue',
  '.cursor',
  '.devin',
  '.gemini',
  '.github',
  '.kiro',
  '.roo',
  '.windsurf',
]

/** Single rule files coding agents read, at any depth. */
export const AGENT_FILES = [
  'AGENTS.md',
  'AGENT.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.goosehints',
]

/** Above this many changed files the whole repository is scanned instead. */
const MAX_NAMED_PATHS = 1000
/** Hits per file asked of the CLI for the threshold. Every character counts. */
const JSON_HIT_LIMIT = 100000
/** Rows in the summary tables, and decoded messages shown in full. */
const MAX_ROWS = 200
const MAX_MESSAGES = 50
const MAX_MESSAGE_LENGTH = 2000
/** The NUL scan the CLI uses to tell a binary file from text. */
const NUL_SCAN_BYTES = 8192
/** Files larger than this are passed to the CLI unread; it skips them by size. */
const PREFILTER_MAX_BYTES = 16 * 1024 * 1024
const GIT_MAX_BUFFER = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------

const HIDDEN_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/u
const SPACE_CHARACTER = /\p{Zs}/u
/** Visible-width blanks that are not in any of the classes above. */
const BLANK_LOOKALIKES = new Set([0x2800, 0x3164, 0xffa0, 0x115f, 0x1160])

/**
 * A string, safe to print where invisible characters cannot be seen. A
 * backslash is doubled; tab, LF and CR are written as \t, \n and \r; every
 * control, format, private-use, unassigned, default-ignorable or variation
 * character, every space other than U+0020, and the blank look-alikes are
 * written as a \u{XXXX} escape. Everything else prints as itself. The result
 * holds no line break.
 */
export function escapeText(text) {
  let out = ''
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0
    if (character === '\\') out += '\\\\'
    else if (character === '\t') out += '\\t'
    else if (character === '\n') out += '\\n'
    else if (character === '\r') out += '\\r'
    else if (
      HIDDEN_CHARACTER.test(character) ||
      (cp !== 0x20 && SPACE_CHARACTER.test(character)) ||
      BLANK_LOOKALIKES.has(cp)
    ) {
      out += `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`
    } else out += character
  }
  return out
}

function longestBacktickRun(text) {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

/** Inline code that no backtick in the text can close. Escapes first. */
function inlineCode(text) {
  const escaped = escapeText(text)
  const ticks = '`'.repeat(longestBacktickRun(escaped) + 1)
  const pad = escaped.startsWith('`') || escaped.endsWith('`') || escaped === '' ? ' ' : ''
  return `${ticks}${pad}${escaped}${pad}${ticks}`
}

/** Inline code for a table cell, where a pipe would split the cell. */
function cellCode(text) {
  return inlineCode(text).replaceAll('|', '\\|')
}

/** A fenced block that no backtick run in the text can close. Escapes first. */
function fencedBlock(text) {
  const escaped = escapeText(text)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(escaped) + 1))
  return `${fence}text\n${escaped}\n${fence}`
}

/** Fixed CLI vocabulary (scheme, kind, codepoint name), kept to safe characters. */
function plainWord(text) {
  return String(text).replace(/[^A-Za-z0-9 ()+._-]/g, '')
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

class InputError extends Error {}

function readFailOn(raw) {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return 'hidden'
  if (!FAIL_ON_VALUES.includes(value)) {
    throw new InputError(`fail-on must be one of ${FAIL_ON_VALUES.join(', ')}, not ${escapeText(value)}`)
  }
  return value
}

function readBoolean(raw, name) {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new InputError(`${name} must be true or false, not ${escapeText(value)}`)
}

function readPaths(raw) {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8')
  } catch {
    return undefined
  }
}

function splitNul(output) {
  return output.split('\0').filter((name) => name !== '')
}

function hasCommit(top, sha) {
  return git(top, ['cat-file', '-e', `${sha}^{commit}`]) !== undefined
}

function readEvent(path) {
  if (path === undefined || path === '') return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The files a pull request changed, as paths relative to the repository top
 * level, or undefined when they cannot be worked out. The checked-out tree is
 * compared with the base commit, so the list is exactly what differs on disk.
 * A shallow checkout lacks the base commit, so it is fetched once, depth 1.
 */
function changedFiles(top, event) {
  const base = event?.pull_request?.base?.sha
  if (typeof base !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) return undefined
  if (!hasCommit(top, base)) {
    git(top, ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', base])
    if (!hasCommit(top, base)) return undefined
  }
  const output = git(top, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', base, '--'])
  return output === undefined ? undefined : splitNul(output)
}

/** Every tracked or unignored file under an agent directory or named as a rule file. */
function agentFiles(top) {
  const pathspecs = [
    ...AGENT_DIRECTORIES.map((name) => `:(glob)**/${name}/**`),
    ...AGENT_FILES.map((name) => `:(glob)**/${name}`),
  ]
  const output = git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs])
  return output === undefined ? undefined : splitNul(output)
}

// ---------------------------------------------------------------------------
// what to scan
// ---------------------------------------------------------------------------

/**
 * True when a file reads as UTF-8 text, by the CLI's own discovery rules: a
 * regular file, not a symbolic link, no NUL in the first 8 KiB, and a strict
 * UTF-8 decode. A file named on the CLI's command line that is not text is an
 * error, so changed files are filtered here the way a whole-repository walk
 * filters them.
 */
function looksLikeText(absolute) {
  let stat
  try {
    stat = lstatSync(absolute)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  if (stat.size > PREFILTER_MAX_BYTES) return true
  let bytes
  try {
    const descriptor = openSync(absolute, 'r')
    try {
      bytes = Buffer.alloc(stat.size)
      readSync(descriptor, bytes, 0, stat.size, 0)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return false
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return true
}

/**
 * Decide the scope. Explicit paths are passed as given, plus the agent files.
 * In a pull request the changed text files plus the agent files are scanned.
 * Anywhere else, or when the changed files cannot be listed, the whole
 * repository is, and the CLI's own discovery includes the agent directories.
 */
function planScope(cwd, inputPaths, eventName, event) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || undefined
  const toCwd = (fromTop) => relative(cwd, join(top ?? cwd, fromTop)) || '.'

  const agentPaths = () => {
    if (top !== undefined) {
      const listed = agentFiles(top)
      if (listed !== undefined) {
        return listed.map(toCwd).filter((path) => looksLikeText(resolve(cwd, path)))
      }
    }
    const found = []
    for (const name of [...AGENT_DIRECTORIES, ...AGENT_FILES]) {
      try {
        lstatSync(join(cwd, name))
        found.push(name)
      } catch {
        // absent
      }
    }
    return found
  }

  if (inputPaths.length > 0) {
    return { mode: 'paths', paths: unique([...inputPaths, ...agentPaths()]) }
  }

  const isPullRequest = eventName === 'pull_request' || eventName === 'pull_request_target'
  if (!isPullRequest) return { mode: 'repository', paths: [], reason: 'not-a-pull-request' }
  if (top === undefined) return { mode: 'repository', paths: [], reason: 'no-git' }

  const changed = changedFiles(top, event)
  if (changed === undefined) return { mode: 'repository', paths: [], reason: 'no-base' }
  if (changed.length > MAX_NAMED_PATHS) return { mode: 'repository', paths: [], reason: 'too-many' }

  const changedText = changed.map(toCwd).filter((path) => looksLikeText(resolve(cwd, path)))
  const paths = unique([...changedText, ...agentPaths()])
  if (paths.length > MAX_NAMED_PATHS) return { mode: 'repository', paths: [], reason: 'too-many' }
  return { mode: 'changed', paths }
}

function unique(paths) {
  return [...new Set(paths)].sort()
}

// ---------------------------------------------------------------------------
// running the CLI
// ---------------------------------------------------------------------------

function runCli(cli, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { code: result.status ?? 3, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------

const TAG_FIRST = 0xe0000
const TAG_LAST = 0xe007f

function isTag(cp) {
  return cp >= TAG_FIRST && cp <= TAG_LAST
}

function isBidi(kind) {
  return kind === 'bidi-override' || kind === 'bidi-mark'
}

/** Whether one character hit reaches the threshold on its own. */
function hitCounts(failOn, hit) {
  if (failOn === 'any') return true
  if (failOn === 'hidden') return isBidi(hit.kind) || isTag(hit.cp)
  return false
}

/** Whether one decoded payload reaches the threshold. */
function payloadCounts(failOn) {
  return failOn === 'any' || failOn === 'hidden' || failOn === 'payload'
}

function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Whether the CLI that wrote the report cannot decode hidden messages. A CLI
 * that decodes writes a `payloads` array on every failure, empty when nothing
 * decodes, so a report with failures and no such array came from an older CLI.
 * A report with no failures says nothing either way.
 */
function lacksDecoder(report) {
  const failures = arrayOf(report.failures)
  return failures.length > 0 && failures.every((failure) => !Array.isArray(failure.payloads))
}

const NO_DECODER_TEXT =
  'Hidden-message decoding is unavailable: the installed ghostchars CLI does not report decoded messages. ' +
  'Zero-width, variation-selector and other hidden messages are not decoded, so fail-on `payload` finds nothing and ' +
  '`hidden` fails on bidi controls and tag characters only. Set the `version` input to 1.1.0 or later, the first ghostchars release that decodes them.'

function judge(failOn, report) {
  const failures = arrayOf(report.failures)
  let blocking = 0
  let payloads = 0
  for (const failure of failures) {
    const hits = arrayOf(failure.hits)
    const found = arrayOf(failure.payloads)
    payloads += found.length
    const fileBlocks =
      failOn === 'any' ||
      (found.length > 0 && payloadCounts(failOn)) ||
      hits.some((hit) => hitCounts(failOn, hit))
    if (fileBlocks) blocking += 1
  }
  return { blocking, payloads, failing: failures.length }
}

// ---------------------------------------------------------------------------
// the job summary
// ---------------------------------------------------------------------------

const SCOPE_TEXT = {
  paths: 'the paths given, plus the files coding agents read rules from',
  changed: 'the files this pull request changed, plus the files coding agents read rules from',
  repository: 'the whole repository',
}

const REPOSITORY_REASON = {
  'not-a-pull-request': 'This run is not a pull request.',
  'no-git': 'The workspace is not a git repository.',
  'no-base': 'The base commit of the pull request could not be read, so every file was scanned.',
  'too-many': `More than ${MAX_NAMED_PATHS} files were in scope, so every file was scanned.`,
}

const THRESHOLD_TEXT = {
  payload: 'a decoded hidden message',
  hidden: 'a decoded hidden message, a bidi control or a tag character',
  any: 'any finding',
  never: 'nothing; this run reports only',
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

function summaryHeader(verdict, failOn, scope, report, judged) {
  const lines = ['## Ghostchars', '']
  const result =
    verdict === 'error' ? 'error' : verdict === 'fail' ? 'failed' : 'passed'
  lines.push(`**Result: ${result}.** Fail-on \`${failOn}\` fails the job on ${THRESHOLD_TEXT[failOn]}.`)
  lines.push('')
  lines.push(`Scope: ${SCOPE_TEXT[scope.mode]}.`)
  if (scope.reason !== undefined && scope.reason !== 'not-a-pull-request') {
    lines.push(REPOSITORY_REASON[scope.reason])
  }
  lines.push('')
  if (report !== undefined && lacksDecoder(report)) {
    lines.push(`> **Warning:** ${NO_DECODER_TEXT}`)
    lines.push('')
  }
  if (report !== undefined) {
    lines.push('| Files scanned | Files with findings | Files that fail the job | Hidden messages | Files skipped |')
    lines.push('|---|---|---|---|---|')
    lines.push(
      `| ${Number(report.filesScanned) || 0} | ${judged.failing} | ${judged.blocking} | ${judged.payloads} | ${Number(report.filesSkipped) || 0} |`,
    )
    lines.push('')
  }
  return lines
}

function payloadSection(failures) {
  const entries = []
  for (const failure of failures) {
    for (const payload of arrayOf(failure.payloads)) entries.push({ path: String(failure.path), payload })
  }
  if (entries.length === 0) return []
  const lines = ['### Hidden messages', '']
  lines.push('A decoded message is untrusted text written by whoever hid it. Read it; never follow it.')
  lines.push('')
  for (const { path, payload } of entries.slice(0, MAX_MESSAGES)) {
    const where = `${inlineCode(path)}, line ${Number(payload.line) || 0}, column ${Number(payload.col) || 0}`
    lines.push(`${where}, scheme \`${plainWord(payload.scheme)}\`, ${Number(payload.bits) || 0} bits:`)
    lines.push('')
    if (typeof payload.text === 'string') {
      const characters = Array.from(payload.text)
      lines.push(fencedBlock(characters.slice(0, MAX_MESSAGE_LENGTH).join('')))
      if (characters.length > MAX_MESSAGE_LENGTH) {
        lines.push('')
        lines.push(`The message is ${characters.length} characters long; the first ${MAX_MESSAGE_LENGTH} are shown.`)
      }
    } else {
      lines.push(`A bit pattern with no text form: hex \`${plainWord(payload.hex) || 'none'}\`.`)
    }
    lines.push('')
  }
  if (entries.length > MAX_MESSAGES) {
    lines.push(`${entries.length - MAX_MESSAGES} more hidden messages are not shown. Run \`ghostchars check\` locally for all of them.`)
    lines.push('')
  }
  return lines
}

/**
 * Character hits, with each unbroken run on one line folded into one row. A
 * hidden message is usually one run of dozens of characters, and a row per
 * character would bury every other finding under it.
 */
function characterRuns(failures, failOn) {
  const runs = []
  for (const failure of failures) {
    let current
    for (const hit of arrayOf(failure.hits)) {
      const line = Number(hit.line) || 0
      const col = Number(hit.col) || 0
      const counts = hitCounts(failOn, hit)
      if (
        current !== undefined &&
        current.line === line &&
        current.lastCol + 1 === col &&
        current.kind === hit.kind &&
        current.counts === counts
      ) {
        current.lastCol = col
        current.count += 1
        continue
      }
      current = { path: String(failure.path), line, col, lastCol: col, kind: hit.kind, counts, first: hit, count: 1 }
      runs.push(current)
    }
  }
  return runs
}

function characterSection(failures, failOn) {
  const runs = characterRuns(failures, failOn)
  if (runs.length === 0) return []
  const lines = ['### Characters', '']
  lines.push('| File | Line | Column | Character | Kind | Fails the job |')
  lines.push('|---|---|---|---|---|---|')
  for (const run of runs.slice(0, MAX_ROWS)) {
    const first = `${plainWord(run.first.u)} ${plainWord(run.first.name)}`.trim()
    const character = run.count === 1 ? first : `${run.count} in a row, starting with ${first}`
    const column = run.count === 1 ? String(run.col) : `${run.col} to ${run.lastCol}`
    lines.push(
      `| ${cellCode(run.path)} | ${run.line} | ${column} | ${character} | \`${plainWord(run.kind)}\` | ${run.counts ? 'yes' : 'no'} |`,
    )
  }
  lines.push('')
  if (runs.length > MAX_ROWS) {
    lines.push(`${runs.length - MAX_ROWS} more rows are not listed. Run \`ghostchars check\` locally for all of them.`)
    lines.push('')
  }
  return lines
}

function pinSection(failures) {
  const pinned = failures.filter((failure) => failure.status !== 'changed')
  if (pinned.length === 0) return []
  const lines = ['### Pins', '', '| File | Status | Characters | Pinned at |', '|---|---|---|---|']
  for (const failure of pinned.slice(0, MAX_ROWS)) {
    lines.push(
      `| ${cellCode(String(failure.path))} | \`${plainWord(failure.status)}\` | ${Number(failure.changed) || 0} | ${Number(failure.pinned) || 0} |`,
    )
  }
  lines.push('')
  return lines
}

function errorSection(stderr) {
  const text = stderr.trim()
  if (text === '') return []
  const shown = text.split('\n').slice(0, 50).join('\n')
  return ['### Errors', '', fencedBlock(shown), '']
}

// ---------------------------------------------------------------------------
// output plumbing
// ---------------------------------------------------------------------------

function appendTo(path, text) {
  if (path === undefined || path === '') return
  appendFileSync(path, text)
}

function setOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`)
  appendTo(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

/** One log line. Prefixed, so no untrusted text can begin a workflow command. */
function log(text) {
  process.stdout.write(`ghostchars: ${text}\n`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function main() {
  const env = process.env
  const cwd = process.cwd()
  let failOn
  let wantSarif
  try {
    failOn = readFailOn(env.GHOSTCHARS_FAIL_ON)
    wantSarif = readBoolean(env.GHOSTCHARS_SARIF, 'sarif')
    if (env.GHOSTCHARS_CLI === undefined || env.GHOSTCHARS_CLI === '' || !isAbsolute(env.GHOSTCHARS_CLI)) {
      throw new InputError('GHOSTCHARS_CLI must be the absolute path of the ghostchars CLI')
    }
  } catch (error) {
    if (!(error instanceof InputError)) throw error
    log(`error: ${error.message}`)
    setOutputs({ failed: 'true', 'files-scanned': 0, 'files-failing': 0, payloads: 0, 'sarif-file': '' })
    return 2
  }

  const scope = planScope(cwd, readPaths(env.GHOSTCHARS_PATHS), env.GITHUB_EVENT_NAME, readEvent(env.GITHUB_EVENT_PATH))

  if (scope.mode !== 'repository' && scope.paths.length === 0) {
    log(`nothing to scan in ${SCOPE_TEXT[scope.mode]}`)
    appendTo(
      env.GITHUB_STEP_SUMMARY,
      `## Ghostchars\n\n**Result: passed.** Nothing to scan: no text files in ${SCOPE_TEXT[scope.mode]}.\n\n`,
    )
    setOutputs({ failed: 'false', 'files-scanned': 0, 'files-failing': 0, payloads: 0, 'sarif-file': '' })
    return 0
  }

  const positionals = scope.paths.length === 0 ? [] : ['--', ...scope.paths]
  const json = runCli(env.GHOSTCHARS_CLI, cwd, ['check', '--json', '--limit', String(JSON_HIT_LIMIT), ...positionals])
  const report = parseJson(json.stdout)

  let sarifFile = ''
  if (wantSarif) {
    const sarif = runCli(env.GHOSTCHARS_CLI, cwd, ['check', '--sarif', ...positionals])
    if (parseJson(sarif.stdout) !== undefined) {
      sarifFile = env.GHOSTCHARS_SARIF_FILE || join(env.RUNNER_TEMP || tmpdir(), 'ghostchars.sarif')
      writeFileSync(sarifFile, sarif.stdout)
    }
  }

  if (report === undefined || typeof report !== 'object' || report === null) {
    log(`error: the CLI exited ${json.code} without a JSON report`)
    for (const line of json.stderr.split('\n').filter((entry) => entry.trim() !== '')) log(escapeText(line))
    appendTo(
      env.GITHUB_STEP_SUMMARY,
      [...summaryHeader('error', failOn, scope, undefined, undefined), ...errorSection(json.stderr)].join('\n') + '\n',
    )
    setOutputs({ failed: 'true', 'files-scanned': 0, 'files-failing': 0, payloads: 0, 'sarif-file': sarifFile })
    return 2
  }

  const failures = arrayOf(report.failures)
  const judged = judge(failOn, report)
  const errored = json.code === 2 || json.code === 3
  const verdict = errored ? 'error' : judged.blocking > 0 && failOn !== 'never' ? 'fail' : 'pass'

  if (lacksDecoder(report)) log(`warning: ${NO_DECODER_TEXT.replaceAll('`', '')}`)
  for (const failure of failures) {
    const hits = Number(failure.changed) || arrayOf(failure.hits).length
    const messages = arrayOf(failure.payloads).length
    log(`${escapeText(String(failure.path))}: ${plural(hits, 'character', 'characters')}, ${plural(messages, 'hidden message', 'hidden messages')}`)
  }
  for (const line of json.stderr.split('\n').filter((entry) => entry.trim() !== '')) log(escapeText(line))
  log(
    `${verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'error'}: ${Number(report.filesScanned) || 0} files scanned, ${judged.failing} with findings, ${judged.blocking} at fail-on ${failOn}`,
  )

  const summary = [
    ...summaryHeader(verdict, failOn, scope, report, judged),
    ...payloadSection(failures),
    ...characterSection(failures, failOn),
    ...pinSection(failures),
    ...(errored ? errorSection(json.stderr) : []),
  ]
  appendTo(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)

  setOutputs({
    failed: verdict === 'pass' ? 'false' : 'true',
    'files-scanned': Number(report.filesScanned) || 0,
    'files-failing': judged.blocking,
    payloads: judged.payloads,
    'sarif-file': sarifFile,
  })
  return verdict === 'error' ? 2 : verdict === 'fail' ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
