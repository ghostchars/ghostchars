/**
 * Which files the gate looks at, and in which order.
 *
 * TWO STRATEGIES, ONE ORDER. Inside a git repository the list comes from
 * `git ls-files -z --cached --others --exclude-standard`, which gives
 * `.gitignore` semantics and untracked-but-not-ignored files for free and costs
 * one process. Anywhere else a walker does the job, skipping the directories
 * nobody gates. `--git` makes a missing git a hard error and `--no-git` forces
 * the walker, so a CI job pins the strategy instead of silently switching
 * between a container that has git and one that does not.
 *
 * ORDERING IS PART OF THE CONTRACT. Results are sorted by byte order on the
 * root-relative POSIX path, so two runs of the same command over the same tree
 * print the same lines in the same order whether the list came from git or from
 * `readdir`. A gate whose output reorders between runs cannot be diffed, and a
 * diffable gate output is the thing a reviewer actually reads.
 *
 * SYMLINKS ARE NOT FOLLOWED. The target is either inside the tree, in which
 * case it is already in the list under its own name, or outside it, in which
 * case it is not ours to gate. A link named on the command line is different:
 * naming it was an assertion, so that one is followed.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { errnoOf } from '../io.js'
import * as strings from '../strings.js'

/** Directories a repository gate has no business walking into. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
])

/**
 * Dot-directories the walk DOES enter, although every other one is skipped.
 *
 * These hold the instructions coding agents read: rules, skills, prompts,
 * workflows. They are where a hidden-character injection does its damage, and
 * `git ls-files` already lists them, so a walk that skipped them gated less than
 * a git run over the same tree. Named rather than inferred, so a cache such as
 * `.pytest_cache` or `.parcel-cache` still stays out.
 */
export const WALKED_DOT_DIRECTORIES: ReadonlySet<string> = new Set([
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
])

/** How the list was produced. Reported in the JSON payload. */
export type Discovery = 'git' | 'walk'

export interface DiscoveredFile {
  /** The absolute path actually opened. */
  readonly absolute: string
  /** Root-relative POSIX path. Globs match this, and pins are keyed by it. */
  readonly relative: string
  /** What the output calls the file: the relative path, or what the user typed. */
  readonly display: string
  /** True when the user named this exact file on the command line. */
  readonly named: boolean
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return stdout.toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Whether a `git` executable exists at all.
 *
 * Only ever asked after discovery has already declined to use git, and only to
 * pick which of the two `--git` failure sentences to print: "git is not on
 * PATH" and "this is not a git repository" are different problems, and telling
 * someone standing in a plain directory to install git sends them after
 * something they already have.
 */
export function gitOnPath(cwd: string): boolean {
  return runGit(cwd, ['--version']) !== undefined
}

/** The repository root containing `cwd`, or nothing when there is none. */
export function gitToplevel(cwd: string): string | undefined {
  const stdout = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (stdout === undefined) return undefined
  const line = stdout.trim()
  return line === '' ? undefined : line
}

/**
 * Every path git knows about under the root: tracked, plus untracked that is
 * not ignored. Returns nothing when git is absent or the root is not a
 * repository, which is the caller's cue to walk instead or to fail.
 */
export function gitFiles(root: string): string[] | undefined {
  const stdout = runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])
  if (stdout === undefined) return undefined
  const names = stdout.split('\0').filter((name) => name !== '')
  return [...new Set(names)]
}

function entryFor(root: string, absolute: string, named: boolean, display?: string): DiscoveredFile {
  const relativePath = toPosix(relative(root, absolute))
  return {
    absolute,
    relative: relativePath,
    display: display ?? relativePath,
    named,
  }
}

/**
 * Walk a directory tree.
 *
 * A symlink to a directory arrives here as a non-directory entry (readdir uses
 * link semantics), so it is never descended into and lands in the file list,
 * where the gate's own stat reports it as a skipped symlink. One rule, one
 * place.
 *
 * A DIRECTORY THIS CANNOT OPEN IS AN ERROR, NOT A SHRUG. It used to be `catch {
 * return }`, and the consequence was the worst thing a gate can do: a tree with
 * one `chmod 000` directory holding an em dash reported `"ok": true`,
 * `"filesScanned": 1`, `"filesSkipped": 0`, exit 0. Nothing appeared in
 * `scanned`, in `skipped`, or in the exit code. A permission-restricted
 * directory is an ordinary thing to meet in a CI image, a mounted cache or a
 * half-extracted artifact, and content the gate could not examine has to be
 * visible in the report, which is the same rule `check/istext.ts` states for a
 * file it cannot decode. The message goes into `DiscoverResult.errors`, which
 * `commands/check.ts` prints and turns into exit 2.
 */
function walk(root: string, start: string, into: DiscoveredFile[], errors: string[]): void {
  let entries
  try {
    entries = readdirSync(start, { withFileTypes: true })
  } catch (error) {
    // A directory outside the root, which happens whenever a path argument
    // points somewhere else, is named absolutely rather than as a run of `..`.
    const inside = toPosix(relative(root, start))
    const label = inside === '' || inside.startsWith('..') ? start : inside
    errors.push(strings.errFile(label, strings.errnoMessage(errnoOf(error))))
    return
  }
  for (const entry of entries) {
    const full = join(start, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      if (entry.name.startsWith('.') && !WALKED_DOT_DIRECTORIES.has(entry.name)) continue
      walk(root, full, into, errors)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    into.push(entryFor(root, full, false))
  }
}

export interface DiscoverRequest {
  readonly root: string
  readonly cwd: string
  /** Positional arguments, exactly as typed. Empty means "the whole root". */
  readonly paths: readonly string[]
  /** True for `--git`, false for `--no-git`, undefined to decide by what works. */
  readonly preferGit: boolean | undefined
}

export interface DiscoverResult {
  readonly files: readonly DiscoveredFile[]
  readonly discovery: Discovery
  /**
   * One message per path argument that could not be resolved, and one per
   * directory the walk could not open. Both mean content nobody looked at, and
   * the caller turns them into exit 2.
   */
  readonly errors: readonly string[]
}

/** Sort by byte order on the root-relative path, not by UTF-16 code unit. */
function sortByBytes(files: DiscoveredFile[]): DiscoveredFile[] {
  return files
    .map((file) => ({ key: Buffer.from(file.relative, 'utf8'), file }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map((entry) => entry.file)
}

/**
 * Resolve the file list.
 *
 * With path arguments there is no git question to ask: each argument is either
 * a file, which the user asserted is text, or a directory, which is walked.
 * Without them the whole root is the subject and the strategy matters.
 */
export function discover(request: DiscoverRequest): DiscoverResult {
  const files: DiscoveredFile[] = []
  const errors: string[] = []

  if (request.paths.length > 0) {
    for (const given of request.paths) {
      const absolute = resolve(request.cwd, given)
      let stat
      try {
        stat = statSync(absolute)
      } catch (error) {
        errors.push(strings.errFile(given, strings.errnoMessage(errnoOf(error))))
        continue
      }
      if (stat.isDirectory()) walk(request.root, absolute, files, errors)
      else files.push(entryFor(request.root, absolute, true, given))
    }
    return { files: sortByBytes(dedupe(files)), discovery: 'walk', errors }
  }

  if (request.preferGit !== false) {
    const names = gitFiles(request.root)
    if (names !== undefined) {
      for (const name of names) {
        files.push(entryFor(request.root, join(request.root, name), false))
      }
      return { files: sortByBytes(dedupe(files)), discovery: 'git', errors }
    }
  }

  walk(request.root, request.root, files, errors)
  return { files: sortByBytes(dedupe(files)), discovery: 'walk', errors }
}

/** A path named twice, or named inside a directory also named, is checked once. */
function dedupe(files: readonly DiscoveredFile[]): DiscoveredFile[] {
  const byPath = new Map<string, DiscoveredFile>()
  for (const file of files) {
    const existing = byPath.get(file.absolute)
    // A file named explicitly wins over the same file found by a walk, because
    // naming it changes what an undecodable file means.
    if (existing === undefined || (file.named && !existing.named)) byPath.set(file.absolute, file)
  }
  return [...byPath.values()]
}
