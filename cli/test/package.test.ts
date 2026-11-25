/**
 * The manifest and the tarball, which are the two things nobody looks at until
 * the day a publish goes wrong.
 *
 * WHY A TEST AND NOT ONLY `prepublishOnly`. `scripts/prepublish-check.mjs` runs
 * the same audit, but only on `npm publish`, which is the one moment where
 * finding out is too late. These run on every `pnpm test`, so a stray file, a
 * runtime dependency added by accident, or a version that drifted away from
 * `strings.ts` fails within seconds of the change that caused it.
 *
 * WHY `--ignore-scripts` ON `npm pack`. Without it `npm pack` runs this
 * package's own `prepack`, which is `scripts/build.mjs`, and build.mjs prints
 * one progress line per output to the same stdout the `--json` report comes back
 * on. `JSON.parse` then dies on `ghostchars: dist/cli.js, 636 bytes`. The
 * suite already requires a current build to exist, so what is audited here is
 * the current `dist/` either way.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { VERSION } from '../src/strings.js'
import { requireBuild, runCli } from './helpers/run.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const MANIFEST = z.object({
  name: z.string(),
  version: z.string(),
  type: z.string(),
  license: z.string(),
  bin: z.record(z.string(), z.string()),
  files: z.array(z.string()),
  engines: z.object({ node: z.string() }),
  dependencies: z.unknown().optional(),
  repository: z.unknown().optional(),
  bugs: z.unknown().optional(),
  private: z.unknown().optional(),
  mcpName: z.string(),
})

const PACK_REPORT = z.array(
  z.object({
    name: z.string(),
    version: z.string(),
    files: z.array(z.object({ path: z.string(), mode: z.number() })),
  }),
)

function manifest(): z.infer<typeof MANIFEST> {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return MANIFEST.parse(raw)
}

function walk(directory: string, prefix: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    const path = `${prefix}${entry}`
    if (statSync(full).isDirectory()) found.push(...walk(full, `${path}/`))
    else found.push(path)
  }
  return found
}

/**
 * The shipped bundles this suite reads as prose, matching the list in
 * `scripts/prepublish-check.mjs`. Not minified on purpose, so a stranger who
 * runs `npm pack` reads them.
 */
const AUDITED_BUNDLES: ReadonlySet<string> = new Set([
  'dist/cli.js',
  'dist/main.js',
  'dist/doc.js',
  'dist/index.js',
])

let packed: string[] = []
let modes = new Map<string, number>()

beforeAll(() => {
  requireBuild()
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const jsonRaw: unknown = JSON.parse(raw)
  const [report] = PACK_REPORT.parse(jsonRaw)
  if (report === undefined) throw new Error('npm pack reported nothing')
  packed = report.files.map((entry) => entry.path).sort()
  modes = new Map(report.files.map((entry) => [entry.path, entry.mode]))
})

describe('the manifest', () => {
  it('declares no runtime dependencies at all', () => {
    /**
     * The MCP SDK and zod are devDependencies and are bundled into
     * `dist/mcp.js`. Declaring them would make a cold `npx ghostchars` pull
     * roughly ninety packages, and an MCP host spawns the server at every
     * session start.
     */
    expect(manifest().dependencies).toBeUndefined()
  })

  it('names its own public repository and issue tracker, and nothing else', () => {
    expect(manifest().repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/ghostchars/ghostchars.git',
      directory: 'cli',
    })
    expect(manifest().bugs).toEqual({ url: 'https://github.com/ghostchars/ghostchars/issues' })
  })

  it('is not private, because the guard is a real check and not a flag', () => {
    expect(manifest().private).toBeUndefined()
  })

  it('declares exactly one bin, named ghostchars, pointing at the launcher', () => {
    const bin = manifest().bin
    expect(Object.keys(bin)).toEqual(['ghostchars'])
    expect(bin['ghostchars']).toBe('./dist/cli.js')
  })

  it('agrees with strings.ts and with the running binary about the version', () => {
    expect(manifest().version).toBe(VERSION)
    const result = runCli(['version'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${VERSION}\n`)
  })

  it('is an ESM package that needs Node 22 or newer', () => {
    expect(manifest().type).toBe('module')
    expect(manifest().engines.node).toBe('>=22')
  })

  it('exports the library entry with its types, and nothing behind the bin', () => {
    const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const library = z
      .object({ main: z.string(), types: z.string(), exports: z.unknown(), sideEffects: z.boolean() })
      .parse(raw)
    expect(library.exports).toEqual({
      '.': { types: './dist/types/index.d.ts', default: './dist/index.js' },
      './package.json': './package.json',
    })
    expect(library.main).toBe('./dist/index.js')
    expect(library.types).toBe('./dist/types/index.d.ts')
    expect(library.sideEffects).toBe(false)
  })

  it('allowlists exactly dist, integrations, the README and the licence', () => {
    expect(manifest().files.sort()).toEqual(['LICENSE', 'README.md', 'dist', 'integrations'])
  })
})

/**
 * `server.json` is what `mcp-publisher publish` sends to the official MCP
 * registry, and the registry accepts it only when its name matches the
 * `mcpName` of the published npm version it points at. Nothing reads it at run
 * time, so without this block a release bumps `package.json` and leaves the
 * registry entry pointing at the version before.
 */
const SERVER = z.object({
  name: z.string(),
  version: z.string(),
  packages: z.array(
    z.object({ registryType: z.literal('npm'), identifier: z.string(), version: z.string() }),
  ),
})

describe('server.json', () => {
  it('names the package and version the manifest publishes', () => {
    const raw: unknown = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'))
    const server = SERVER.parse(raw)
    const { name, version, mcpName } = manifest()
    expect(server.name).toBe(mcpName)
    expect(server.version).toBe(version)
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: name, version }),
    ])
  })
})

describe('the tarball', () => {
  it('ships the five dist outputs, the library types and the notices file', () => {
    for (const required of [
      'dist/cli.js',
      'dist/main.js',
      'dist/doc.js',
      'dist/mcp.js',
      'dist/index.js',
      'dist/types/index.d.ts',
      'dist/THIRD-PARTY-NOTICES.txt',
    ]) {
      expect(packed).toContain(required)
    }
  })

  it('ships every integration file, and the tarball copy matches the tree', () => {
    const onDisk = walk(join(ROOT, 'integrations'), 'integrations/').sort()
    expect(onDisk.length).toBe(26)
    expect(packed.filter((path) => path.startsWith('integrations/'))).toEqual(onDisk)
  })

  it('ships nothing outside the allowlist', () => {
    const allowedTop = new Set(['package.json', 'README.md', 'LICENSE'])
    const strays = packed.filter(
      (path) =>
        !allowedTop.has(path) && !path.startsWith('dist/') && !path.startsWith('integrations/'),
    )
    expect(strays).toEqual([])
  })

  it('ships no TypeScript source, no sourcemap and no node_modules', () => {
    // Declaration files are the one `.ts` a library ships, and only under dist/types.
    const forbidden = packed.filter(
      (path) =>
        (path.endsWith('.ts') && !(path.startsWith('dist/types/') && path.endsWith('.d.ts'))) ||
        path.endsWith('.map') ||
        path.includes('node_modules/'),
    )
    expect(forbidden).toEqual([])
    expect(packed.filter((path) => path.endsWith('.d.ts')).length).toBeGreaterThan(1)
  })

  it('carries no absolute or parent-relative source path', () => {
    /**
     * The needles are the ones `scripts/prepublish-check.mjs` refuses, asserted
     * here as well so the failure arrives during development rather than during
     * a publish. The bundles are in this list: the build does not minify, so
     * esbuild's per-module banner comment survives into the shipped file, and
     * for the engine modules that banner is the relative path from this package
     * to the engine source. `scripts/build.mjs` rewrites those banners; this is
     * the assertion that says so about the file `npm pack` would ship.
     */
    const needles = ['github.com', 'gitlab', '.git/']
    // The package's own repository is the one URL that is allowed to appear.
    const ownRepository = 'github.com/ghostchars/ghostchars'
    const readable = packed.filter(
      (path) =>
        path === 'package.json' ||
        path === 'README.md' ||
        AUDITED_BUNDLES.has(path) ||
        path.startsWith('integrations/'),
    )
    expect(readable.length).toBeGreaterThan(16)
    for (const required of AUDITED_BUNDLES) expect(readable).toContain(required)
    for (const path of readable) {
      const text = readFileSync(join(ROOT, path), 'utf8').replaceAll(ownRepository, '')
      for (const needle of needles) {
        expect(text.includes(needle), `${path} mentions ${needle}`).toBe(false)
      }
    }
  })

  it('rewrites the module banners rather than deleting them', () => {
    /**
     * The banner is worth keeping: it tells a reader which module a line came
     * from, which is the whole reason the bundles are not minified. What it must
     * not do is name a directory outside this package, so a banner pointing up
     * out of the tree fails here and in the build itself.
     */
    for (const path of AUDITED_BUNDLES) {
      if (path === 'dist/cli.js') continue
      const text = readFileSync(join(ROOT, path), 'utf8')
      expect(text, `${path} lost its module banners`).toMatch(/^\/\/ engine\/tables\.ts$/m)
      expect(text, `${path} has a banner pointing outside the package`).not.toMatch(
        /^\/\/ (?:\.\.\/)+/m,
      )
    }
  })

  it('leaves no engine banner pointing out of the package in dist/mcp.js either', () => {
    /**
     * `dist/mcp.js` is exempt from the needle scan, because third-party SDK code
     * is not ours to police. The banners this package is responsible for are not
     * exempt, and they are the eight engine modules bundled in there too.
     */
    const text = readFileSync(join(ROOT, 'dist', 'mcp.js'), 'utf8')
    expect(text).not.toMatch(/^\/\/ (?:\.\.\/)+/m)
  })
})

describe('the launcher', () => {
  it('starts with the shebang, on the first byte', () => {
    const bytes = readFileSync(join(ROOT, 'dist', 'cli.js'))
    expect(bytes.subarray(0, 19).toString('utf8')).toBe('#!/usr/bin/env node')
  })

  it('is executable on disk and in the tarball', () => {
    const mode = statSync(join(ROOT, 'dist', 'cli.js')).mode & 0o777
    expect(mode & 0o111, `mode ${mode.toString(8)}`).not.toBe(0)
    expect(mode).toBe(0o755)
    const packedMode = modes.get('dist/cli.js') ?? 0
    expect(packedMode & 0o111, `packed mode ${packedMode.toString(8)}`).not.toBe(0)
  })

  it('parses on an old Node, which is the whole reason it is a separate file', () => {
    /**
     * The guard cannot live inside `dist/main.js`: the whole `target: node22`
     * bundle has to parse before any statement in it runs, so a person on Node
     * 18 would get a SyntaxError instead of a sentence. This asserts the
     * launcher itself uses nothing newer: `var`, string concatenation and one
     * dynamic import.
     */
    const source = readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8')
    expect(source).toContain('process.versions.node')
    expect(source).toContain('import("./main.js")')
    expect(source).not.toMatch(/\bconst\b|\blet\b|=>|\?\?|\?\./)
  })
})
