/**
 * Spawn the BUILT binary.
 *
 * WHY BLACK BOX. `pnpm test` proves the artifact that ships, not the library it
 * was built from. Almost every behaviour worth pinning here (exit codes, what
 * lands on stdout versus stderr, the atomic write, the stdio transport) only
 * exists in the process, so the tests drive `dist/cli.js` the way a user does.
 * That also means a stale or missing build is a test failure, and
 * {@link requireBuild} says so in one sentence instead of a spawn error.
 *
 * BYTES AND TEXT BOTH. Byte-parity assertions against Python compare raw
 * stdout, and a lossy decode would hide exactly the difference they exist to
 * catch, so every result carries the buffers as well as the decoded strings.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The launcher, which is what `bin` points at and what a user runs. */
export const CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

/** The CLI bundle itself. Only a test that wants to skip the Node guard uses it. */
export const MAIN_PATH = fileURLToPath(new URL('../../dist/main.js', import.meta.url))

/** 64 MiB, so an eight-megabyte pipe test does not trip the child buffer cap. */
const MAX_BUFFER = 64 * 1024 * 1024

export interface RunOptions {
  /** Written to the child's stdin and then closed. */
  readonly input?: string | Uint8Array
  readonly cwd?: string
  /** Merged over the parent environment. */
  readonly env?: Readonly<Record<string, string>>
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: Buffer
  readonly stderrBytes: Buffer
}

export function requireBuild(): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      'dist/cli.js does not exist. The test suite drives the built binary: run the build first.',
    )
  }
}

function environment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  delete base['GHOSTCHARS_DEBUG']
  return extra === undefined ? base : { ...base, ...extra }
}

/** Run the binary and wait. This is the form nearly every test wants. */
export function runCli(args: readonly string[], options: RunOptions = {}): RunResult {
  requireBuild()
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    input: options.input,
    cwd: options.cwd,
    env: environment(options.env),
    maxBuffer: MAX_BUFFER,
  })
  if (result.error !== undefined) throw result.error
  const stdoutBytes = result.stdout ?? Buffer.alloc(0)
  const stderrBytes = result.stderr ?? Buffer.alloc(0)
  return {
    code: result.status ?? -1,
    stdout: stdoutBytes.toString('utf8'),
    stderr: stderrBytes.toString('utf8'),
    stdoutBytes,
    stderrBytes,
  }
}

/**
 * The asynchronous form, for a test that has to interact with the child while
 * it runs: a slow reader on stdout, or a stdin that stays open.
 */
export async function runCliAsync(
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  requireBuild()
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: options.cwd,
      env: environment(options.env),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const stdoutBytes = Buffer.concat(stdout)
      const stderrBytes = Buffer.concat(stderr)
      resolve({
        code: code ?? -1,
        stdout: stdoutBytes.toString('utf8'),
        stderr: stderrBytes.toString('utf8'),
        stdoutBytes,
        stderrBytes,
      })
    })
    if (options.input !== undefined) child.stdin.write(options.input)
    child.stdin.end()
  })
}
