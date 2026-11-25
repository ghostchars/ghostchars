/**
 * The gate `npm publish` has to pass.
 *
 * WHY THIS EXISTS INSTEAD OF `private: true`. This package is meant to be
 * publishable, and a flag someone has to remember to flip back is not a safety
 * mechanism. This runs the whole quality gate and then audits the tarball
 * that `npm pack` would actually produce, so an accidental publish fails on a
 * real check rather than on a forgotten field.
 *
 * WHAT IT REFUSES. A tarball with a `.ts` file other than the library's
 * declarations, or a sourcemap. A tarball missing any of the five `dist`
 * outputs or the library's types. Any mention of a repository host or
 * a `.git` path in the files a stranger reads: this package ships as itself,
 * with no absolute or parent-relative source path.
 *
 * It calls the local binaries directly rather than a package manager, so it
 * behaves identically under npm, pnpm and yarn.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BIN = join(ROOT, 'node_modules', '.bin')

const failures = []

function fail(message) {
  failures.push(message)
}

function run(command, args) {
  console.log(`ghostchars: ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' })
}

function gate() {
  run(join(BIN, 'eslint'), ['.', '--max-warnings', '0'])
  run(join(BIN, 'tsc'), ['--noEmit'])
  run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')])
  run(join(BIN, 'vitest'), ['run'])
}

const REQUIRED_DIST = [
  'dist/cli.js',
  'dist/main.js',
  'dist/doc.js',
  'dist/mcp.js',
  'dist/index.js',
  'dist/types/index.d.ts',
]

const ALLOWED_TOP_LEVEL = new Set(['package.json', 'README.md', 'LICENSE'])

// `.git/` and not `.git`: the needle is a PATH into a checkout, which is what
// would give the tarball an absolute or parent-relative source path. The bare
// four characters also match `.github/instructions/`, which is where a
// Copilot rule file has to be installed, and `.gitignore`, which is the
// ignore file `ghostchars check` honours and therefore has to be able to
// name. Both are documentation a stranger needs, not a leak. `github.com`
// below still catches a repository URL.
const FORBIDDEN_TEXT = ['github.com', '.git/', 'gitlab']
// The one repository URL this package may name: its own. It is stripped before
// the needles run, so a link to the source is documentation and any other host
// path is still a leak.
const OWN_REPOSITORY = 'github.com/ghostchars/ghostchars'

function auditFileList() {
  // `--ignore-scripts` is load-bearing, not an optimisation. Without it `npm
  // pack` runs this package's own `prepack`, which is scripts/build.mjs, and
  // build.mjs prints one progress line per output to the SAME stdout the
  // `--json` report comes back on. `JSON.parse` then died on
  // `ghostchars: dist/cli.js, 636 bytes`. gate() has already run the identical
  // build a moment ago, so what is audited here is the current dist either way.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const [report] = JSON.parse(raw)
  const files = report.files.map((entry) => entry.path)

  for (const required of REQUIRED_DIST) {
    if (!files.includes(required)) fail(`the tarball is missing ${required}`)
  }
  for (const path of files) {
    if (ALLOWED_TOP_LEVEL.has(path)) continue
    if (path.startsWith('dist/') || path.startsWith('integrations/')) continue
    fail(`unexpected file in the tarball: ${path}`)
  }
  for (const path of files) {
    // Declaration files under dist/types are the library's types, not source.
    const declaration = path.startsWith('dist/types/') && path.endsWith('.d.ts')
    if ((path.endsWith('.ts') && !declaration) || path.endsWith('.map')) fail(`the tarball ships ${path}`)
    if (path.includes('node_modules/')) fail(`the tarball ships ${path}`)
  }
  return files
}

/**
 * The shipped bundles are readable on purpose, so they are audited for the
 * same forbidden text as the rest of the tarball.
 *
 * `dist/mcp.js` is exempt for the same reason the ASCII guard exempts it:
 * third-party SDK code is not ours to police, and the build guard already covers
 * the banners this package is responsible for.
 */
const AUDITED_BUNDLES = new Set(['dist/cli.js', 'dist/main.js', 'dist/doc.js', 'dist/index.js'])

function auditText(files) {
  const readable = files.filter(
    (path) =>
      path === 'package.json' ||
      path === 'README.md' ||
      AUDITED_BUNDLES.has(path) ||
      (path.startsWith('integrations/') && !path.endsWith('.png')),
  )
  for (const path of readable) {
    const full = join(ROOT, path)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8').replaceAll(OWN_REPOSITORY, '')
    for (const needle of FORBIDDEN_TEXT) {
      if (text.includes(needle)) fail(`${path} mentions ${needle}`)
    }
  }
}

function auditLauncher() {
  const launcher = join(ROOT, 'dist', 'cli.js')
  if (!existsSync(launcher)) {
    fail('dist/cli.js does not exist')
    return
  }
  const text = readFileSync(launcher, 'utf8')
  if (!text.startsWith('#!/usr/bin/env node')) fail('dist/cli.js has no shebang')
  const mode = statSync(launcher).mode & 0o777
  if ((mode & 0o111) === 0) fail(`dist/cli.js is not executable (mode ${mode.toString(8)})`)
}

function auditManifest() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.dependencies !== undefined) fail('package.json declares runtime dependencies')
  // The only repository and issue tracker the manifest may name are the
  // package's own public ones. Anything else is a path back to a tree that
  // is not this package.
  const ownRepositoryUrl = `git+https://${OWN_REPOSITORY}.git`
  if (pkg.repository?.url !== ownRepositoryUrl) {
    fail(`package.json repository must be ${ownRepositoryUrl}`)
  }
  if (pkg.bugs?.url !== `https://${OWN_REPOSITORY}/issues`) {
    fail(`package.json bugs must be https://${OWN_REPOSITORY}/issues`)
  }
  if (pkg.private !== undefined) fail('package.json is private')
  const bins = Object.keys(pkg.bin ?? {})
  if (bins.length !== 1 || bins[0] !== 'ghostchars') fail('package.json must declare one bin named ghostchars')
}

gate()
auditManifest()
const files = auditFileList()
auditText(files)
auditLauncher()

if (failures.length > 0) {
  for (const failure of failures) console.error(`ghostchars: ${failure}`)
  process.exit(1)
}
console.log(`ghostchars: publish check passed, ${files.length} files in the tarball`)
