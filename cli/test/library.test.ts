/**
 * The package as a library: `import { clean, find, decode } from 'ghostchars'`,
 * and the canary marks beside them.
 *
 * WHY A REAL TARBALL. The exports map, the declaration files and the `files`
 * allowlist only meet in what `npm pack` produces, so this packs the package,
 * unpacks it into a scratch project's `node_modules` the way an install lays it
 * out, and imports it from there: once from Node, once from the TypeScript
 * compiler in its strictest module mode, which is where a declaration file with
 * an unresolvable import would silently turn every type into `any`. The
 * `@ts-expect-error` line is what proves the types are real. The bin is run
 * from the same unpacked copy.
 *
 * Every child process here is awaited rather than run synchronously: packing
 * and a compiler run can take a minute on a loaded machine, and a test worker
 * that blocks its event loop that long loses contact with the runner.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { VERSION } from '../src/strings.js'
import { requireBuild } from './helpers/run.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc')

/** Generous, for a loaded machine. An idle one needs a few seconds. */
const SLOW = 300_000

let scratch = ''
let project = ''

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a command to completion without blocking. A non-zero exit is a result, not a throw. */
async function spawnAsync(command: string, args: readonly string[], cwd: string, input?: string): Promise<Ran> {
  return await new Promise<Ran>((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr })
        else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
        else reject(new Error(error.message))
      },
    )
    if (input !== undefined) child.stdin?.write(input)
    child.stdin?.end()
  })
}

async function node(args: readonly string[], input?: string): Promise<Ran> {
  return await spawnAsync(process.execPath, args, project, input)
}

beforeAll(async () => {
  requireBuild()
  scratch = mkdtempSync(join(tmpdir(), 'ghostchars-library-'))
  const packed = await spawnAsync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch],
    ROOT,
  )
  const report = z.array(z.object({ filename: z.string() })).parse(JSON.parse(packed.stdout))
  const tarball = join(scratch, report[0]?.filename ?? '')
  project = join(scratch, 'consumer')
  const installed = join(project, 'node_modules', 'ghostchars')
  mkdirSync(installed, { recursive: true })
  const unpacked = await spawnAsync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'], scratch)
  if (unpacked.code !== 0) throw new Error(`tar failed: ${unpacked.stderr}`)
  writeFileSync(join(project, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n')
}, SLOW)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('the package as a library', () => {
  it('imports clean, find and decode by the package name', async () => {
    writeFileSync(
      join(project, 'use.mjs'),
      [
        "import { clean, find, decode, embedCanary, detectCanary } from 'ghostchars'",
        "const text = 'A\\u200BB' + String.fromCodePoint(0xe0068, 0xe0069)",
        "const marked = embedCanary('Draft for the board.', 'alice')",
        'console.log(JSON.stringify({',
        '  cleaned: clean(text).text,',
        '  found: find(text).map((f) => f.name),',
        '  decoded: decode(text).map((p) => p.text),',
        '  canary: detectCanary(marked).map((m) => m.id),',
        '  unmarked: clean(marked).text,',
        '}))',
        '',
      ].join('\n'),
    )
    const result = await node(['use.mjs'])
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      cleaned: 'AB',
      found: ['ZERO WIDTH SPACE', 'TAG LATIN SMALL LETTER H', 'TAG LATIN SMALL LETTER I'],
      decoded: ['hi'],
      canary: ['alice'],
      unmarked: 'Draft for the board.',
    })
  })

  it('exposes only the library entry, not the bundles behind the bin', async () => {
    writeFileSync(
      join(project, 'deep.mjs'),
      "import('ghostchars/dist/main.js').then(() => console.log('reached'), (e) => console.log(e.code))\n",
    )
    expect((await node(['deep.mjs'])).stdout.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  it('type-checks against the shipped declarations under nodenext resolution', { timeout: SLOW }, async () => {
    writeFileSync(
      join(project, 'use.ts'),
      [
        "import { clean, decode, find } from 'ghostchars'",
        "import type { CleanResult, Payload } from 'ghostchars'",
        '',
        "const result: CleanResult = clean('a', { punct: true })",
        'const payloads: Payload[] = decode(result.text)',
        'export const scheme: string | undefined = payloads[0]?.scheme',
        'export const line: number | undefined = find(result.text)[0]?.line',
        '',
        '// @ts-expect-error clean takes a string, which fails only if the types are real',
        'clean(42)',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2023',
          lib: ['es2023'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['use.ts'],
      }),
    )
    const result = await spawnAsync(TSC, ['-p', project], project)
    expect(`${result.stdout}${result.stderr}`).toBe('')
    expect(result.code).toBe(0)
  })

  it('keeps the bin working from the same install', async () => {
    const bin = join('node_modules', 'ghostchars', 'dist', 'cli.js')
    expect((await node([bin, 'version'])).stdout).toBe(`${VERSION}\n`)
    const cleaned = await node([bin, 'clean'], 'A\u200BB')
    expect(cleaned.code).toBe(0)
    expect(cleaned.stdout).toBe('AB')
  })
})
