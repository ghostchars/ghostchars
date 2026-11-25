/**
 * The invariant that removes the difflib port.
 *
 * `check` decides how many characters a bar would change by counting findings
 * whose action is `removed` or `replaced`. `tools/changed_chars.py` is the
 * same measurement the repository's own Python gate reports with. If those
 * two numbers ever disagree, a pin number written for one tool is a lie in
 * the other, and the README's claim that they are interchangeable has to
 * come out.
 *
 * So the claim is measured twice, not argued.
 *
 * 1. IN PROCESS, for every golden text fixture across both gate bars: the
 *    finding count is zero if and only if the cleaner would leave the text
 *    alone. That is the hard correctness property the pass or fail decision
 *    rests on, and it is what makes a zero count safe to trust.
 * 2. AGAINST PYTHON, for the same corpus and the same two bars: one `python3`
 *    process imports the gate's own `changed_chars` and the reference cleaner,
 *    and every number it prints must equal the number the shipped counter
 *    produces.
 *
 * A failure here is a hard stop, not a warning. It means a pin somebody wrote
 * against one gate does not mean what they thought in the other.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { changedFindings } from '../src/check/gate.js'
import { GATE_BARS, optionsForBar } from '../src/options.js'

import { golden } from './helpers/golden.js'
import { requirePython, runPythonCode, pythonSkipped } from './helpers/python.js'

/**
 * The reference side, as one process.
 *
 * `strip_invisible.py` is imported for its `clean`, and the gate module is
 * loaded from its path for `changed_chars`, so both halves of the comparison
 * are the real code the repository runs rather than a restatement of it. The
 * corpus arrives on stdin as JSON so no fixture text is ever spelled out in
 * this file.
 */
const GATE_SCRIPT = [
  'import importlib.util, json, pathlib, sys, types',
  'root = pathlib.Path.cwd()',
  'sys.path.insert(0, str(root))',
  'import strip_invisible as si',
  "spec = importlib.util.spec_from_file_location('gate', root / 'tools' / 'changed_chars.py')",
  'gate = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(gate)',
  "KEYS = ['aggressive', 'spaces', 'newlines', 'bidi', 'controls', 'pua',",
  "        'punct', 'confusables', 'nfc', 'nfkc', 'gutters', 'trailing', 'collapse']",
  "BARS = {'default': [], 'text': ['spaces', 'punct']}",
  "payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
  'out = {}',
  'for item in payload:',
  '    counts = {}',
  '    for name, keys in BARS.items():',
  '        args = types.SimpleNamespace(**{k: (k in keys) for k in KEYS})',
  "        after = si.clean(item['text'], args)",
  "        counts[name] = len(gate.changed_chars(item['text'], after))",
  "    out[item['id']] = counts",
  'sys.stdout.write(json.dumps(out))',
].join('\n')

const PYTHON_COUNTS = z.record(
  z.string(),
  z.object({ default: z.number().int(), text: z.number().int() }),
)

/** The count the shipped gate would record for one text at one bar. */
function countFor(text: string, bar: 'default' | 'text'): number {
  return changedFindings(text, optionsForBar(bar)).hits.length
}

describe('the findings-count invariant, in process', () => {
  it('counts zero if and only if the cleaner would leave the text alone', () => {
    const disagreements: string[] = []
    for (const bar of GATE_BARS) {
      const options = optionsForBar(bar)
      for (const fixture of golden.text) {
        const { wouldChange, hits } = changedFindings(fixture.text, options)
        if ((hits.length === 0) !== !wouldChange) {
          disagreements.push(
            `${fixture.id} at bar ${bar}: ${hits.length} findings but wouldChange=${wouldChange}`,
          )
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it('covers the whole corpus at both bars', () => {
    expect(golden.text.length).toBe(golden.meta.counts.text)
    expect(GATE_BARS).toEqual(['default', 'text'])
  })
})

describe('the findings-count invariant, against the Python gate', () => {
  it('matches changed_chars for every fixture at both bars', () => {
    requirePython()
    if (pythonSkipped()) return

    const payload = JSON.stringify(golden.text.map((fixture) => ({ id: fixture.id, text: fixture.text })))
    const result = runPythonCode(GATE_SCRIPT, payload)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    const parsed: unknown = JSON.parse(result.stdout.toString('utf8'))
    const counts = PYTHON_COUNTS.parse(parsed)
    expect(Object.keys(counts).length).toBe(golden.text.length)

    const mismatches: string[] = []
    for (const fixture of golden.text) {
      const python = counts[fixture.id]
      if (python === undefined) {
        mismatches.push(`${fixture.id}: the reference produced no counts`)
        continue
      }
      for (const bar of GATE_BARS) {
        const ours = countFor(fixture.text, bar)
        if (ours !== python[bar]) {
          mismatches.push(`${fixture.id} at bar ${bar}: ghostchars ${ours}, python ${python[bar]}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('proves the corpus is not silently empty at either bar', () => {
    let dirtyAtDefault = 0
    let dirtyAtText = 0
    for (const fixture of golden.text) {
      if (countFor(fixture.text, 'default') > 0) dirtyAtDefault += 1
      if (countFor(fixture.text, 'text') > 0) dirtyAtText += 1
    }
    expect(dirtyAtDefault).toBeGreaterThan(0)
    expect(dirtyAtText).toBeGreaterThan(dirtyAtDefault)
  })
})
