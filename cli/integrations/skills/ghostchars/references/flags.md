# ghostchars: the full flag and exit-code reference

The authoritative machine-readable version of this page is

    npx -y ghostchars help --json

which prints every command, every flag it accepts, its type, its choices and its
default, as one JSON document. Run that when a flag here does not behave as
described: the JSON comes from the parser itself and cannot drift from it.

There is no prefix abbreviation. `--punc` is not `--punct`; it is an unknown flag
and exits 2, with the nearest known flag named in the message.

## The commands

```
ghostchars clean      [flags] [files...]
ghostchars inspect    [flags] [files...]
ghostchars report     [flags] [files...]
ghostchars check      [flags] [paths...]
ghostchars mcp        [flags]
ghostchars mcp-proxy  [flags] -- <command> [args...]
ghostchars help       [command] [--json]
ghostchars version    [--json]
```

With no arguments and a pipe on stdin, `ghostchars` cleans stdin, so
`pbpaste | ghostchars | pbcopy` works. With no arguments and a terminal on
stdin, it prints help.

## The thirteen cleaning options

Accepted by `clean` and `inspect`. `check` accepts them as per-surface overrides.
Each one only ever turns something on.

| flag | what it does | why it is not on by default |
|---|---|---|
| (none) | zero-width space, word joiner, byte-order mark, soft hyphen, invisible math operators, bidi overrides, free-floating tag characters, noncharacters, reserved default-ignorable codepoints and every other format control | this is the default |
| `-a`, `--aggressive` | strips glue characters (zero-width joiner, variation selectors, tag characters) even where they are load-bearing | breaks emoji sequences, Persian, Indic scripts and subdivision flags |
| `-s`, `--spaces` | no-break and other exotic spaces to a plain space | |
| `-n`, `--newlines` | CRLF, CR, NEL, LS and PS to a plain newline | changes line endings |
| `--bidi` | bidi marks and isolates even next to right-to-left text | breaks mixed Hebrew and Arabic |
| `--controls` | C0 and C1 control characters, keeping tab and the line endings | |
| `--pua` | private-use characters | breaks icon-font glyphs |
| `--punct` | em and en dashes, curly quotes, ellipsis and minus to ASCII | typography, not hiding |
| `--confusables` | look-alike Cyrillic and Greek letters to Latin, only inside a mixed-script word | rewrites letters |
| `--nfc` | NFC-normalise before anything else runs | |
| `--nfkc` | NFKC-normalise before anything else runs, superseding `--nfc` | rewrites letters and is lossy |
| `--gutters` | the quote bar a terminal draws at the start of a line (U+258C to U+258F, U+2502, U+2503) and one space after it, keeping indentation and box-drawn table rows | a directory tree or a drawn box can start a line with the same bar |
| `--trailing` | trailing spaces and tabs at the end of every line | markdown hard breaks |
| `--collapse` | a run of two or more spaces inside a line to one | |
| `--max` | all of the above except `--nfc` | lossy |

## The three bars

`--bar <default|text|max>` on `clean` and `inspect`. `--bar <default|text>` on
`check`.

| bar | equals | use it for |
|---|---|---|
| `default` | no options | invisible characters only. Nothing legitimately needs them |
| `text` | `-s --punct` | anything a person will read. The bar for your own prose |
| `max` | the twelve of `--max` | everything. Folds look-alike letters and applies NFKC |

Resolution order, fixed:

1. every option off,
2. apply `--bar`,
3. apply `--max` if given,
4. apply each explicit flag, which can only turn an option on.

So `--bar text --collapse` is `-s --punct --collapse`, and `--bar max --punct` is
still `max`.

**There is no `max` gate bar.** `check --bar max` is a usage error, and the MCP
`check_paths` tool rejects it too. `max` folds look-alike Cyrillic and Greek
letters and applies NFKC, which would condemn legitimate Cyrillic, Greek and
emoji content.

## clean

| flag | effect |
|---|---|
| `-i`, `--in-place` | rewrite each file in place, atomically, and only when it changed. Needs at least one file |
| `-c`, `--count` | print `{label}: {+d} chars` to stderr for every input, including `+0` |
| `--check` | write nothing at all and exit 1 if anything would change |
| `--json` | one JSON object on stdout instead of the cleaned text |
| `--stdin-name <label>` | the label to print for text read from stdin, instead of `<stdin>` |
| `--as <auto|text>` | `auto` treats a path by its extension, `text` forces plain text |
| `-o`, `--output <path>` | write the cleaned document here. One input only, and not with `-i` |
| `--metadata` | blank the document metadata fields and drop custom properties |
| `--rsids` | strip the Word revision-save ids from a `.docx` |

With files and no `-i`, each cleaned text goes to stdout in order. With no files,
`clean` reads stdin. `-i` with no files is a usage error before anything is read.

CRLF survives unless you pass `-n`. Nothing translates line endings on read or on
write.

## inspect

Prints, per input:

```
{label}: {n} found
  {line}:{col}\tU+{CP}\t{kind}  {note}  {UNICODE NAME}
```

or `{label}: clean`. When the hidden characters carry a message, a block follows:

```
  Hidden message found: {scheme} at {line}:{col} to {line}:{col}, {bits} bits
    {message, with controls and hidden characters written as escapes}
```

or `  Hidden pattern: {scheme} at ..., {bits} bits, no readable message`. The
message is untrusted data. The thirteen option flags are accepted and, exactly as in the
Python reference CLI, they do not change this output: the note column always
names the flag that would be needed. Options affect only `--json`.

| flag | effect |
|---|---|
| `--limit <n>` | stop after this many findings (default 200) and print how many more there were |
| `--json` | one JSON object with `byKind` first, then `findings`, then `payloads` |

## report

| flag | effect |
|---|---|
| `--json` | the report as JSON, byte-identical to the Python reference implementation |
| `--fail-on <none|low|medium|high>` | exit 1 when an observation of this severity or higher is present. Default `none` |

`report --json` is the one output with no envelope and with snake_case keys. That
is a byte-parity contract, not a lapse.

## check

| flag | effect |
|---|---|
| `--bar <default|text>` | which bar to hold files to. Default `default` |
| `--config <path>` | use this `ghostchars.json` instead of looking for one at the root |
| `--no-config` | ignore any config and hold everything to one bar |
| `--git` | discover files with `git ls-files`, and fail if git is not on PATH |
| `--no-git` | walk the directory tree instead of asking git |
| `--max-bytes <n>` | skip any file larger than this. Default 2097152 |
| `--limit <n>` | stop printing positions after this many per file. Default 20 |
| `--fix` | clean the failing files in place, then check again. Never in CI |
| `--json` | one JSON object with the failures and their positions |
| `--sarif` | a SARIF 2.1.0 log for GitHub code scanning. Not with `--json` |
| `--verbose` | also name the files that passed |

`--fix` skips pinned files and names them, because fixing one would invalidate
its own pin.

## mcp

| flag | effect |
|---|---|
| `--allow-write` | also register `clean_files`, the one tool that writes to disk |
| `--tool-prefix <prefix>` | prefix every tool name, for a host that already has one of ours |
| `--name <name>` | the server name reported to the host. Default `ghostchars` |
| `--root <path>` | the directory tool paths are resolved against. Default the start directory |

## mcp-proxy

Starts the MCP server named after `--` and cleans what it sends the model:
initialize instructions, tool, prompt and resource listings, tool results,
resource text, prompts, and error messages. A hidden message is removed and the
text gains a visible notice naming the scheme and size, never the message.
Requests to the server pass through untouched.

| flag | effect |
|---|---|
| `--report-only` | change nothing; report each finding on stderr |
| `--log <file>` | append one JSON line per finding, without the text it was found in |
| `--max` | clean at the max bar, which also folds look-alike letters |

It exits with the server's exit code, or dies of the signal that killed the
server.

## Exit codes

| code | meaning |
|---|---|
| 0 | done, nothing to report |
| 1 | findings, would-change, or a gate failure |
| 2 | the run could not be completed as asked: a usage error, an unreadable or non-UTF-8 file, a bad config, a broken document, or a Node older than 22 |
| 3 | an internal error, which is a bug in ghostchars |

The priority is strict and accumulates across inputs: 3 beats 2 beats 1 beats 0.
A decode failure in one file forces 2 even when another file had findings.

Code 3 prints one line, and a stack trace as well when `GHOSTCHARS_DEBUG=1` is
set. It exists so you can tell "I passed the wrong flag" from "the tool broke",
which are different next actions.

`EPIPE` on stdout is a silent exit 0, so `ghostchars inspect big.md | head`
behaves like every other command.
