# Ghostchars

Ghostchars finds and removes the characters that hide in text: zero-width
spaces, bidi overrides, tag characters, soft hyphens, stray variation selectors,
noncharacters, and the typography that reads as machine written. It runs
offline. Nothing you clean leaves your machine.

This repository is the engine behind [ghostchars.com](https://ghostchars.com)
and the free tools built on it. The same cleaner exists twice, in Python and in
TypeScript, and one fixture file proves the two agree on every codepoint.

## What is here

| path | what it is |
|---|---|
| `strip_invisible.py` | The reference engine. Stdlib only, one file. See `PYTHON.md`. |
| `clean_file.py`, `style_report.py` | Documents (.docx, .odt, .html) and the style report, on the same engine. |
| `web/src/engine/` | The TypeScript port. The website, the CLI and the MCP server run this. |
| `cli/` | `ghostchars` on npm: a Node CLI, a stdio MCP server, and the agent skill, hook and pre-commit files. |
| `tools/` | The generators for the Unicode tables and the golden fixtures, and the parity gates. |
| `tests/` | The Python tests. |

## Quick start

```
npx -y ghostchars check --bar text        # the gate: exit 1 if the tree is dirty
pbpaste | npx -y ghostchars clean         # clean the clipboard
./strip_invisible.py --show draft.md      # the reference engine, no install
```

`cli/README.md` documents every command, the three bars, `ghostchars.json`
and the agent integrations.

## How the two engines stay identical

The Python engine is the specification. `tools/gen_golden.py` runs it over
every fixture and records the findings and the cleaned output for each flag
combination in `web/src/engine/__fixtures__/golden.json`. The TypeScript
engine replays that file in its test suite, so a port that disagrees with the
reference by one codepoint fails its build. The Unicode property tables the
port needs are generated from the same `unicodedata` snapshot by
`tools/gen_unicode_tables.py`. Two commands fail when anything drifts:

```
python3 tools/gen_golden.py --check
python3 tools/gen_unicode_tables.py --check
```

## Working on it

Python 3.10 or newer for the reference engine and the tools. Node 22 or newer
with pnpm for `cli/` and the engine tests under `web/`. The tree holds its own
prose to the text bar with its own CLI: `ghostchars.json` at the root names
the surface and its pins, and `npx -y ghostchars check` from the root runs it.

The Mac app and the Chrome extension are built on this engine and available
at [ghostchars.com](https://ghostchars.com).

## Issues

Bugs and questions about the engine or the CLI go to
[github.com/ghostchars/ghostchars/issues](https://github.com/ghostchars/ghostchars/issues).

## Licence

MIT, with the Unicode licence covering the generated character tables. See
`LICENSE`. The npm package carries its own copy with the notices for what it
bundles.
