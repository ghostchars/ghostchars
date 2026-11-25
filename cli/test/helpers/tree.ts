/**
 * Fixture trees, built in the system temp directory and thrown away after.
 *
 * WHY NOT COMMITTED. The gate tests need files that are deliberately dirty: a
 * zero-width space here, an em dash there, a byte that is not UTF-8. Committing
 * those would put contraband inside a repository whose own hygiene gate walks
 * every text file it can find, and the two gates would fight. Generating them
 * at test time from ordinary JavaScript escapes keeps the repository clean and
 * keeps the fixture visible in the test that uses it.
 *
 * WRITE SPECIMENS AS `\uXXXX` ESCAPES IN THE TEST FILE. The escape is resolved
 * by the JavaScript parser long before this helper sees the string, so what
 * lands on disk is the real character while the source stays plain ASCII. The
 * repository's tier-1 gate reads source bytes and leaves escapes alone, which
 * is exactly why this is the right way to write one.
 *
 * WHY `git init` IS AN OPTION. `check` discovers files with
 * `git ls-files --cached --others --exclude-standard` inside a repository and
 * walks the tree otherwise. Both paths need proving, and the only honest way to
 * prove the first is a real repository, so `makeTree` can make one.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Relative POSIX path to contents. A `Uint8Array` writes raw bytes. */
export type TreeFiles = Readonly<Record<string, string | Uint8Array>>

export interface TreeOptions {
  /** Run `git init` in the new root. */
  readonly git?: boolean
  /** Also `git add -A`, so the files show up under `--cached` and not just `--others`. */
  readonly stage?: boolean
}

/** Create a tree and return its absolute root. */
export function makeTree(files: TreeFiles, options: TreeOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ghostchars-'))
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  if (options.git === true || options.stage === true) {
    git(root, ['init', '-q'])
    if (options.stage === true) git(root, ['add', '-A'])
  }
  return root
}

/** Remove a tree. Safe to call twice. */
export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** Read a file back out of a tree, as text. */
export function readTreeFile(root: string, relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

/** Read a file back out of a tree, as bytes, for a byte-for-byte assertion. */
export function readTreeBytes(root: string, relative: string): Buffer {
  return readFileSync(join(root, relative))
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'ghostchars tests',
      GIT_AUTHOR_EMAIL: 'tests@localhost',
      GIT_COMMITTER_NAME: 'ghostchars tests',
      GIT_COMMITTER_EMAIL: 'tests@localhost',
    },
  })
}
