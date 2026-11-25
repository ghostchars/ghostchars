/**
 * The build: five outputs, one launcher, one notices file, the library's type
 * declarations, three guards.
 *
 * WHY FOUR OUTPUTS AND NOT ONE. A single bundle would pay the MCP SDK's whole
 * parse cost on every `clean`, and `clean` is the command an agent and a CI
 * walk call hundreds of times. So the SDK and zod live in `dist/mcp.js`, the
 * zip and document readers live in `dist/doc.js`, and neither is read from disk
 * until something actually needs it. The engine is duplicated across the three
 * bundles (about 110 KB of tarball) on purpose: no bundle then depends on
 * another's internals, and a broken document reader cannot take `clean` down
 * with it.
 *
 * WHY THE LAUNCHER IS A SEPARATE FILE. `engines` only warns. A version guard
 * placed inside `dist/main.js` could never run on an old Node, because the
 * whole `target: node22` file has to PARSE before any statement in it executes,
 * and the failure a user would see is a SyntaxError pointing at a line of our
 * code. `dist/cli.js` is written here, in ES5, so it parses on Node 12.17 and
 * newer and can print a sentence instead.
 *
 * WHY NOT MINIFIED. A stack trace an agent pastes into a bug report has to be
 * readable, and the CLI bundle is small. No sourcemap either: it would roughly
 * double the tarball for a bundle nobody debugs from source.
 */
import { build } from 'esbuild'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const DIST = join(ROOT, 'dist')
const ENGINE = join(ROOT, '..', 'web', 'src', 'engine')
const NODE_MODULES = join(ROOT, 'node_modules')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// Both entries must exist. MEASURED with esbuild 0.28.2: a lone
// '@ghostchars/engine' entry matches as a PREFIX and rewrites
// '@ghostchars/engine/style' to '.../engine/index.ts/style', which fails to
// resolve. With both entries present esbuild prefers the longer match, so the
// ORDER here does not change esbuild's result. It is written specific-first
// anyway to match vitest.config.ts, where order IS load-bearing: Vite matches a
// plain string alias as "equal, or a path under it" and takes the first hit.
const ALIAS = {
  '@ghostchars/engine/style': join(ENGINE, 'style.ts'),
  '@ghostchars/engine/docx': join(ENGINE, 'docx.ts'),
  '@ghostchars/engine/odt': join(ENGINE, 'odt.ts'),
  '@ghostchars/engine/html': join(ENGINE, 'html.ts'),
  '@ghostchars/engine/zip': join(ENGINE, 'zip.ts'),
  '@ghostchars/engine': join(ENGINE, 'index.ts'),
}

/**
 * The four bundled entry points. All four are REQUIRED.
 *
 * `dist/index.js` is the library (`import { clean } from 'ghostchars'`): the
 * engine alone, with no command line around it, so importing it runs nothing.
 *
 * They were once skipped with a printed note when the source did not exist,
 * which was the right call while the entries were still being written and
 * the wrong one now: a build that quietly emits three of four outputs produces a
 * `dist` where `ghostchars mcp` or a `.docx` fails at runtime with a module
 * resolution error, and the test suite runs against it without noticing.
 */
const ENTRIES = [
  { name: 'main', source: join(ROOT, 'src', 'cli.ts'), out: join(DIST, 'main.js') },
  { name: 'doc', source: join(ROOT, 'src', 'doc', 'index.ts'), out: join(DIST, 'doc.js') },
  { name: 'mcp', source: join(ROOT, 'src', 'mcp', 'entry.ts'), out: join(DIST, 'mcp.js') },
  { name: 'lib', source: join(ROOT, 'src', 'lib.ts'), out: join(DIST, 'index.js') },
]

/** Where the library's declarations go, one `.d.ts` per engine module. */
const TYPES = join(DIST, 'types')

/**
 * Every package that may legitimately end up inside a bundle.
 *
 * A future SDK release that pulls express or hono then breaks the build loudly
 * instead of quietly quadrupling the tarball. The fallback, if that ever
 * happens on purpose, is to declare the SDK and zod as real dependencies and
 * bundle only the engine; the CLI path is unaffected either way, which is the
 * point of splitting the outputs.
 */
const ALLOWED_BUNDLED = new Set([
  '@modelcontextprotocol/sdk',
  'zod',
  'zod-to-json-schema',
  'ajv',
  'ajv-formats',
  'fast-deep-equal',
  'fast-uri',
  'json-schema-traverse',
])

const LAUNCHER = `#!/usr/bin/env node
// Separate file on purpose. \`engines\` only warns, and a version guard placed
// inside dist/main.js could never run on an old Node, because the whole
// target:node22 file has to PARSE before any statement in it executes. This
// file uses var, string concatenation and one dynamic import, so it parses on
// Node 12.17 and newer, which is every Node a person could plausibly have.
var major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(
    "ghostchars needs Node 22 or newer. This is Node " + process.versions.node + ".\\n"
  );
  process.exit(2);
}
import("./main.js");
`

function ensureVersionLiteral() {
  const source = readFileSync(join(ROOT, 'src', 'strings.ts'), 'utf8')
  const needle = `const FALLBACK_VERSION = '${pkg.version}'`
  if (!source.includes(needle)) {
    throw new Error(
      `src/strings.ts does not carry the package version. Expected to find: ${needle}`,
    )
  }
}

/**
 * The bundled package names, read out of esbuild's own metafile.
 *
 * WHY THE LAST 'node_modules/' AND NOT THE FIRST. pnpm does not put packages at
 * the top level. Every real one lives at
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>/...`, so the FIRST
 * 'node_modules/' segment is the content-addressed store and the name after it
 * is the literal string '.pnpm'. Reading the first match reported one bundled
 * package called '.pnpm' and nothing else, which failed the allowlist below the
 * moment any bundle first contained third-party code. Splitting on the marker
 * and reading the LAST segment yields the real name under every layout: npm's
 * and yarn's flat trees have exactly one marker, pnpm's store has two, and a
 * nested dependency has as many as it has levels.
 */
function bundledPackages(metafiles) {
  const names = new Set()
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const input of Object.keys(output.inputs)) {
        const segments = input.split('node_modules/')
        if (segments.length < 2) continue
        const tail = segments[segments.length - 1]
        const match = /^((?:@[^/]+\/)?[^/]+)\//.exec(tail)
        if (match) names.add(match[1])
      }
    }
  }
  return [...names].sort()
}

function checkAttribution(names) {
  const licenseText = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
  for (const name of names) {
    if (!ALLOWED_BUNDLED.has(name)) {
      throw new Error(
        `${name} was bundled but is not on the known list in scripts/build.mjs. ` +
          'Either it should not be here, or the list and cli/LICENSE both need a line.',
      )
    }
    if (!licenseText.includes(name)) {
      throw new Error(`${name} was bundled but is not named in cli/LICENSE.`)
    }
  }
}

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md']

/**
 * Where a bundled package actually lives on disk, so its version and its licence
 * text can be read for `dist/THIRD-PARTY-NOTICES.txt`.
 *
 * TWO TRAPS, BOTH MEASURED HERE.
 *
 * 1. Under pnpm only DIRECT dependencies get a symlink at `node_modules/<name>`.
 *    The six packages the SDK pulls in transitively (ajv, ajv-formats,
 *    fast-deep-equal, fast-uri, json-schema-traverse, zod-to-json-schema) exist
 *    only inside `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, so
 *    joining NODE_MODULES with the name found nothing for six of the eight and
 *    the shipped notices file carried six entries reading `unknown` and
 *    `(no licence file was shipped with this package)`.
 *
 * 2. `require.resolve('<name>/package.json')` is NOT the way out. It obeys the
 *    package's `exports` map, and `@modelcontextprotocol/sdk` maps that
 *    specifier onto `dist/cjs/package.json`, a two-line `{"type":"commonjs"}`
 *    marker with no `name` and no `version`. It resolved, it parsed, and it
 *    reported the SDK's version as `undefined`.
 *
 * So: look for the real package root in the two places it can be, and verify
 * the manifest found there actually names the package asked for.
 */
function packageDir(name) {
  const candidates = [join(NODE_MODULES, name)]
  const store = join(NODE_MODULES, '.pnpm')
  if (existsSync(store)) {
    const flattened = name.replace('/', '+')
    for (const child of readdirSync(store).sort()) {
      if (child === flattened || child.startsWith(`${flattened}@`)) {
        candidates.push(join(store, child, 'node_modules', name))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name === name) {
        return candidate
      }
    } catch {
      // Not a package root. Try the next candidate.
    }
  }
  return join(NODE_MODULES, name)
}

function writeNotices(names) {
  const blocks = [
    'THIRD-PARTY NOTICES',
    '',
    'Generated by scripts/build.mjs from esbuild\'s own metafile. Every package',
    'whose code is present in a bundle in this directory is listed below.',
    '',
  ]
  if (names.length === 0) {
    blocks.push('No third-party code is bundled in this build.')
  }
  for (const name of names) {
    const dir = packageDir(name)
    let version
    try {
      version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    } catch {
      // Handled by the check below.
    }
    // A hole in a shipped attribution file is a defect, not a cosmetic gap, and
    // a missing version always means packageDir() failed rather than that the
    // package is odd. Fail the build rather than ship `undefined`.
    if (typeof version !== 'string') {
      throw new Error(
        `Could not read a version for the bundled package ${name}. ` +
          `Looked in ${relative(ROOT, dir)}. dist/THIRD-PARTY-NOTICES.txt would ship incomplete.`,
      )
    }
    let text = '(no licence file was shipped with this package)'
    for (const filename of LICENSE_FILENAMES) {
      const candidate = join(dir, filename)
      if (existsSync(candidate)) {
        text = readFileSync(candidate, 'utf8').trimEnd()
        break
      }
    }
    blocks.push('='.repeat(72), `${name} ${version}`, '='.repeat(72), '', text, '')
  }
  writeFileSync(join(DIST, 'THIRD-PARTY-NOTICES.txt'), `${blocks.join('\n')}\n`)
}

/**
 * Repository-host references a shipped bundle must not carry.
 *
 * A shipped bundle carries no absolute or parent-relative source path; the
 * parent-relative case is caught by the banner check below. These are the
 * remaining generic needles.
 * `dist/mcp.js` is checked only for the module banner below: the rest of it is
 * third-party SDK code whose own strings are not ours to police.
 */
const FORBIDDEN_IN_BUNDLE = ['github.com', '.git/', 'gitlab']

/** esbuild's per-module banner comment: `// ../web/src/engine/tables.ts`. */
const ENGINE_BANNER = /^\/\/ (?:\.\.\/)+web\/src\/engine\//gm

/** Any banner still pointing out of the package, whatever it points at. */
const ESCAPING_BANNER = /^\/\/ (?:\.\.\/)+.*$/m

/**
 * Rewrite the banner comments esbuild writes above each bundled module.
 *
 * WHY THIS EXISTS. The bundles are deliberately NOT minified, so a stack trace
 * an agent pastes into a bug report stays readable. The cost of that choice is
 * that esbuild's per-module banner survives into the shipped file, and for the
 * engine modules that banner is the relative path from this package to the
 * engine source: `// ../web/src/engine/tables.ts`. A shipped bundle must carry
 * no absolute or parent-relative source path, which is exactly what
 * `scripts/prepublish-check.mjs` exists to refuse. The audit there never
 * looked at `dist/`, so it passed while the leak sat in the artifact it was
 * auditing.
 *
 * The banner is rewritten rather than deleted: `// engine/tables.ts` still tells
 * a reader which module a line came from, which is the only thing the comment
 * was ever worth.
 */
function scrubPathComments(file) {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(ENGINE_BANNER, '// engine/')
  if (after !== before) writeFileSync(file, after)
}

/**
 * A shipped bundle carries no absolute or parent-relative source path.
 *
 * Runs after the rewrite above, so it is a guard and not a cleanup: if a future
 * esbuild version writes the path in a shape the rewrite does not recognise, or
 * a new engine module arrives under a different directory, the BUILD fails
 * rather than the publish.
 */
function checkNoTreeMap(files) {
  for (const { path, deep } of files) {
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const escaping = ESCAPING_BANNER.exec(text)
    if (escaping) {
      throw new Error(
        `${relative(ROOT, path)} carries a module banner pointing outside the package:\n` +
          `  ${escaping[0]}\n` +
          'Teach scrubPathComments() in scripts/build.mjs to rewrite it.',
      )
    }
    if (!deep) continue
    for (const needle of FORBIDDEN_IN_BUNDLE) {
      const at = text.indexOf(needle)
      if (at < 0) continue
      const line = text.slice(0, at).split('\n').length
      throw new Error(
        `${relative(ROOT, path)} mentions ${needle} at line ${line}. ` +
          'A shipped bundle must carry no absolute or parent-relative source path.',
      )
    }
  }
}

/**
 * The tool that finds hidden characters must ship none of its own.
 *
 * esbuild's default `charset: 'ascii'` escapes every non-ASCII STRING LITERAL,
 * so no character the engine handles can reach a bundle as itself. It does not
 * touch COMMENTS, which it copies through verbatim from source, and that is the
 * only way this guard has ever fired: four trailing comments in
 * `web/src/engine/tables.ts` naming the characters beside their codepoints.
 *
 * The guard is deliberately not relaxed to ignore comments. `dist/main.js` is a
 * file a user can run `ghostchars check --bar text` over, and it would fail on
 * an em dash in one of our own comments. The fix is always to write the
 * character as its U+XXXX name in the source comment, which reads better
 * anyway. `dist/mcp.js` is exempt: third-party code is not ours to police.
 */
function checkAscii(files) {
  for (const file of files) {
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] > 0x7f) {
        const before = bytes.subarray(0, i).toString('utf8')
        const line = before.split('\n').length
        const text = bytes.toString('utf8').split('\n')[line - 1] ?? ''
        throw new Error(
          `${relative(ROOT, file)} holds a byte above 0x7F at offset ${i} (line ${line}):\n` +
            `  ${text.trim()}\n` +
            'Bundled comments are copied from source verbatim. Write the character ' +
            'as its U+XXXX name in the source comment.',
        )
      }
    }
  }
}

/** `\u200B` for a BMP character, `\u{1F600}` above it. Valid in a comment and in a string type. */
function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7f]/gu, (ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
  })
}

/** `from './clean'` to `from './clean.js'`, which is what Node16 resolution needs. */
function withJsExtensions(text) {
  return text.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)\2/g, (match, lead, quote, specifier) =>
    /\.(?:js|mjs|cjs|json)$/.test(specifier) ? match : `${lead}${quote}${specifier}.js${quote}`,
  )
}

/**
 * The library's types: the engine's own declarations, emitted by the
 * TypeScript compiler from the same source esbuild bundles.
 *
 * WHY ONE FILE PER MODULE AND A REWRITE. The engine imports its siblings
 * without an extension, which a bundler accepts and Node16 resolution, the
 * mode a strict consumer runs in, does not: an extensionless specifier in an
 * ESM declaration file fails to resolve and the types silently become `any`.
 * So every relative specifier gets `.js`, which names the sibling `.d.ts`
 * under every resolution mode. Declarations keep their doc comments, and the
 * engine's comments name the characters they handle, so every non-ASCII
 * character is written as an escape: the package ships no hidden character of
 * its own.
 */
async function emitTypes() {
  const { default: ts } = await import('typescript')
  const options = {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: TYPES,
    rootDir: ENGINE,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    skipLibCheck: true,
  }
  const program = ts.createProgram({ rootNames: [join(ENGINE, 'index.ts')], options })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const written = []
  const result = program.emit(undefined, (fileName, text) => {
    mkdirSync(dirname(fileName), { recursive: true })
    writeFileSync(fileName, escapeNonAscii(withJsExtensions(text)))
    written.push(fileName)
  })
  const problems = [...diagnostics, ...result.diagnostics]
  if (problems.length > 0) {
    const host = {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    }
    throw new Error(`the library declarations did not compile:\n${ts.formatDiagnostics(problems, host)}`)
  }
  if (!existsSync(join(TYPES, 'index.d.ts'))) throw new Error('dist/types/index.d.ts was not emitted')
  return written.sort()
}

async function main() {
  ensureVersionLiteral()
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })

  const metafiles = []
  const built = []
  for (const entry of ENTRIES) {
    if (!existsSync(entry.source)) {
      throw new Error(
        `${relative(ROOT, entry.source)} does not exist, so ${relative(ROOT, entry.out)} ` +
          'cannot be built. All four entry points are required.',
      )
    }
    const result = await build({
      entryPoints: [entry.source],
      outfile: entry.out,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: false,
      sourcemap: false,
      metafile: true,
      legalComments: 'none',
      alias: ALIAS,
      define: { __GHOSTCHARS_VERSION__: JSON.stringify(pkg.version) },
      logLevel: 'warning',
    })
    metafiles.push(result.metafile)
    built.push(entry.out)
  }

  writeFileSync(join(DIST, 'cli.js'), LAUNCHER)
  chmodSync(join(DIST, 'cli.js'), 0o755)
  const declarations = await emitTypes()

  const names = bundledPackages(metafiles)
  checkAttribution(names)
  writeNotices(names)
  for (const file of built) scrubPathComments(file)
  checkNoTreeMap([
    { path: join(DIST, 'cli.js'), deep: true },
    { path: join(DIST, 'main.js'), deep: true },
    { path: join(DIST, 'doc.js'), deep: true },
    { path: join(DIST, 'mcp.js'), deep: false },
    { path: join(DIST, 'index.js'), deep: true },
    ...declarations.map((path) => ({ path, deep: true })),
  ])
  checkAscii([
    join(DIST, 'cli.js'),
    join(DIST, 'main.js'),
    join(DIST, 'doc.js'),
    join(DIST, 'index.js'),
    ...declarations,
  ])

  for (const file of [join(DIST, 'cli.js'), ...built]) {
    const size = readFileSync(file).length
    console.log(`ghostchars: ${relative(ROOT, file)}, ${size} bytes`)
  }
  console.log(`ghostchars: dist/types, ${declarations.length} declaration files`)
}

await main()
