/**
 * Run the Python reference implementation and capture its raw stdout.
 *
 * WHY RAW BYTES. `report --json` claims byte-identity with
 * `python3 style_report.py --json`, and the whole point of that claim is the
 * difference between `2` and `2.0`. Comparing decoded, re-parsed JSON would
 * throw away exactly the evidence, so this helper hands back a `Buffer` and the
 * caller compares buffers.
 *
 * WHY IT FAILS LOUDLY. A parity suite that silently skips itself when `python3`
 * is missing is worse than no parity suite: the reassurance stays and the
 * evidence goes. So a missing interpreter throws, and the only way to skip is
 * `GHOSTCHARS_SKIP_PYTHON=1`, set by a person who knows what they are giving
 * up. CI never sets it.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** The repository root, three levels up from `cli/test/helpers/`. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const STRIP_INVISIBLE = join(REPO_ROOT, 'strip_invisible.py')
export const STYLE_REPORT = join(REPO_ROOT, 'style_report.py')
export const CLEAN_FILE = join(REPO_ROOT, 'clean_file.py')

export interface PythonResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
}

/** Whether `python3` answers at all. */
export function pythonAvailable(): boolean {
  const probe = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' })
  return probe.error === undefined && probe.status === 0
}

/** Whether the caller has deliberately opted out of the Python comparisons. */
export function pythonSkipped(): boolean {
  return process.env['GHOSTCHARS_SKIP_PYTHON'] === '1'
}

/**
 * Assert that Python is usable, or explain what to do about it. Call this once
 * at the top of a suite so the failure names the cause instead of arriving as
 * twenty spawn errors.
 */
export function requirePython(): void {
  if (pythonSkipped()) return
  if (!pythonAvailable()) {
    throw new Error(
      'python3 is not on PATH, and this suite compares against the Python reference ' +
        'implementation byte for byte. Install python3, or set GHOSTCHARS_SKIP_PYTHON=1 ' +
        'to run the rest of the suite without the parity evidence.',
    )
  }
}

const MAX_BUFFER = 64 * 1024 * 1024

/** Run one of the repository's Python scripts with text on stdin. */
export function runPythonScript(
  script: string,
  args: readonly string[] = [],
  input?: string | Uint8Array,
): PythonResult {
  const result = spawnSync('python3', [script, ...args], {
    input,
    cwd: REPO_ROOT,
    maxBuffer: MAX_BUFFER,
  })
  if (result.error !== undefined) throw result.error
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
  }
}

/**
 * Run a snippet with the repository root on `sys.path`, for a test that needs
 * to import a module rather than run a script: the gate's `changed_chars`, for
 * instance, which has no command-line form.
 */
export function runPythonCode(code: string, input?: string | Uint8Array): PythonResult {
  return runPythonScript('-c', [code], input)
}
