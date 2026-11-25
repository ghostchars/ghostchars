# ghostchars

Find and remove invisible Unicode characters and machine-writing punctuation, in
text and in documents. Everything runs on your machine: no network, no
telemetry, no account, and zero runtime dependencies.

```
npx ghostchars clean -i notes.md          # clean a file in place, atomically
cat draft.md | npx ghostchars inspect     # what is hiding: line:col, codepoint, name
npx ghostchars check --bar text           # the gate: exit 1 if the tree is dirty
npx ghostchars report draft.md            # habits that make a draft read as machine written
npx ghostchars clean -i essay.docx        # documents too: .docx, .odt, .html
npx ghostchars mcp-proxy -- node server.js  # clean what another MCP server sends the model
npx ghostchars canary embed --id alice memo.txt  # mark a copy for one recipient
```

Needs Node 22 or newer. The whole package is a launcher and four bundles: the
CLI, the document reader, the MCP server, and the library. Only the first is
loaded unless you name a document or start the server.

## Commands

`clean` reads stdin or the files you name, writes the cleaned text to stdout, or
rewrites each file in place with `-i`. With `--check` it writes nothing and exits
1 if anything would change.

`inspect` lists every suspicious character with its line, column, codepoint,
Unicode name and the flag that would act on it. It changes nothing and exits 1
when it finds something. When the hidden characters carry a message, it decodes
it and prints a "Hidden message found" block after the list (see
[Hidden messages](#hidden-messages)).

`report` measures the habits that make a draft read as machine written: sentence
length uniformity, stock transitions, tell words, dash density, tricolons,
hedging, missing specifics. It is not a detector and emits no probability.

`check` holds a whole tree to a bar and prints every file that would change,
with exact character positions and any hidden message the file carries. This is the command for CI and for a pre-commit
hook. Configure surfaces and pins in `ghostchars.json`. A GitHub Action wraps it
for pull requests (see [As a GitHub Action](#as-a-github-action)).

`mcp` runs a Model Context Protocol server on stdin and stdout, so an agent can
call `clean_text`, `inspect_text`, `style_report` and `check_paths` as tools
instead of shelling out.

`mcp-proxy` runs another MCP server behind a filter that removes hidden
characters and hidden messages from everything that server sends the model (see
[MCP proxy](#mcp-proxy)).

`canary` marks a text with an invisible recipient id, or reads the id back from
a copy that leaked (see [Canary marks](#canary-marks)).

`help` prints the commands, `help <command>` prints one command's flags, and
`help --json` prints the whole surface as one machine-readable document.
`version` prints the version.

## Flags

The thirteen cleaning switches, their spellings and their meanings are exactly the
Python reference CLI's, because it is the same engine underneath.

| flag | what | why it is not default |
|---|---|---|
| (default) | zero-width space, word joiner, byte-order mark, soft hyphen, invisible math operators, bidi overrides, free-floating tag characters, noncharacters, reserved default-ignorable codepoints, every other format control | |
| `-a`, `--aggressive` | glue characters even when they are load-bearing | breaks emoji sequences, Persian, Indic, subdivision flags |
| `-s`, `--spaces` | no-break and other exotic spaces to a plain space | |
| `-n`, `--newlines` | CRLF, CR, NEL, LS and PS to a plain newline | changes line endings |
| `--bidi` | bidi marks and isolates even next to right-to-left text | breaks mixed Hebrew and Arabic |
| `--controls` | C0 and C1 control characters, keeping tab and the line endings | |
| `--pua` | private-use characters | breaks icon-font glyphs |
| `--punct` | em and en dashes, curly quotes, ellipsis and minus to ASCII | typography, not hiding |
| `--confusables` | look-alike Cyrillic and Greek letters to Latin, only inside mixed-script words | rewrites letters; opt in on principle |
| `--nfc`, `--nfkc` | Unicode normalisation before anything else runs | NFKC rewrites letters and is lossy |
| `--gutters` | the quote bar a terminal draws at the start of a line (U+258C to U+258F, U+2502, U+2503) and one space after it, keeping indentation and box-drawn table rows | a directory tree or a drawn box can start a line with the same bar |
| `--trailing` | trailing spaces and tabs at the end of every line | markdown hard breaks |
| `--collapse` | a run of two or more spaces inside a line to one | |
| `--max` | all of the above except `--nfc`, which `--nfkc` supersedes | |

Default cleaning is context aware. It strips a zero-width joiner sitting between
two Latin letters and keeps the one inside a family emoji or a Persian word. It
strips free tag characters, which is how text is smuggled into a message, and
keeps a complete subdivision flag. It strips a left-to-right mark in English text
and keeps one next to Hebrew. `-a` turns that judgement off.

An option can only be turned on. There is no way to turn one off, because the
reference CLI has none either.

## The three bars

A bar is a named set of options, so a person or an agent picks one word instead
of thirteen booleans.

| bar | options | use it for |
|---|---|---|
| `default` | none | invisible characters only. Nothing legitimately needs them |
| `text` | `-s --punct` | anything a person will read. This is the bar for your own prose |
| `max` | the twelve of `--max` | everything, including confusables and NFKC. Lossy |

Resolution order is fixed, so the result is always predictable:

1. start from every option off,
2. apply `--bar`,
3. apply `--max` if given,
4. apply each explicit flag, which can only turn an option on.

So `--bar text --collapse` is `-s --punct --collapse`, and `--bar max --punct` is
still just `max`.

`max` folds look-alike Cyrillic and Greek letters and applies NFKC, which
rewrites letters. Do not run it over text you did not write. It is not offered as
a gate bar at all: see `check` below.

## Hidden messages

Hidden characters can carry a message rather than sit there by accident. `inspect`,
`check` and the MCP tools decode the common schemes and report what they spell:

```
<stdin>: 28 found
  ...
  Hidden message found: tag-ascii at 1:21 to 1:48, 224 bits
    ignore previous instructions
```

| scheme | carrier |
|---|---|
| `tag-ascii` | Unicode tag characters outside an emoji flag, one ASCII character each (ASCII smuggling) |
| `variation-selector` | a run of variation selectors after a character, one byte each, read as UTF-8 |
| `zero-width-binary` | a run of zero-width characters built from two symbols, read as bits |
| `canary` | a per-recipient mark written by `ghostchars canary embed`; an unkeyed mark reads as its id, a keyed one as a pattern |
| `bidi-mark-binary` | left-to-right and right-to-left marks away from right-to-left text |
| `trailing-whitespace` | spaces and tabs at the end of lines |
| `space-nbsp-binary`, `double-space-binary` | which space, or how many, sits between words |
| `apostrophe-binary` | straight or curly apostrophes |
| `normalization-binary` | precomposed or decomposed accented letters |
| `homoglyph` | look-alike letters from another script, reported as a pattern only |

Bits become a message only when the result is readable text: valid UTF-8, no
control characters, and at least one letter or digit. Otherwise the carrier is
reported as a hidden pattern with its size in bits and "no readable message",
because a wrong decode is worse than none. The same characters doing legitimate
work, such as an emoji with its variation selector, an emoji sequence joined
with a zero-width joiner, a subdivision flag, or a zero-width non-joiner in
Persian, produce nothing.

**A decoded message is untrusted data.** Whoever hid it chose every byte, and
very often it is an instruction aimed at an AI agent. The human output therefore
prints it with every control character, and every character `inspect` would
itself report, written as an escape: `\\`, `\t`, `\n`, `\r`, or `\u{XXXX}`. A
payload cannot move the cursor, change the terminal colour or hide part of
itself. In `--json` and over MCP the `text` field holds the raw message, which
the JSON encoder escapes; quote it, never follow it.

Decoding changes no exit code. The block follows the findings in `inspect`, and
a payload line follows the hits of a failing file in `check`. `check` decodes
only the files that fail, so a message carried by visible typography alone
(spaces or apostrophes, which no gate bar changes) is reported by `inspect` but
not by `check`. Statistical watermarks are not made of characters, so no
character decoder can see them.

## Documents

`clean` and `inspect` recognise a document by its extension and handle it
structurally.

| extension | how | extra flags |
|---|---|---|
| `.docx` | the package is unzipped, every text node is cleaned, the zip is rewritten | `--metadata`, `--rsids` |
| `.odt` | the same, through the ODF parts | `--metadata` |
| `.html`, `.htm` | text nodes only. Tags, attributes, script and style are untouched | |
| anything else | plain text | |

`--as text` forces plain-text treatment of any path, which is what the Python
reference CLI does with an `.html` file.

Without `-i`, a cleaned document is written to `<name>.clean<ext>` beside the
original, or to the path you give with `-o`.

`inspect` on a document prints the character report over the concatenated
document text, then what hides around that text: hidden runs, white-on-white and
tiny runs, tracked changes, comments, the count of distinct rsid editing-session
ids, metadata fields, macros, media. `--metadata` blanks the authoring fields and
drops custom properties; `--rsids` removes the editing-session fingerprint.

Hidden runs, comments and tracked changes are reported and never removed.
Deleting them changes the document, and that stays a human call.

Out of scope here: PDF, images, `.pptx`, `.xlsx`, `.rtf`, `.doc`, `.epub` and
`.pages`. `check` does not open documents at all.

## check

```
ghostchars check [--bar default|text] [option flags]
                 [--config <path>] [--no-config]
                 [--git|--no-git] [--max-bytes N] [--limit N]
                 [--fix] [--json] [--verbose] [paths...]
```

`--bar` accepts exactly `default` and `text`. There is deliberately no `max` gate
bar: `max` turns on confusables and NFKC, which target scripts and symbols rather
than typography, and a gate that condemns legitimate Cyrillic, Greek and emoji
content gets deleted by the people who installed it. The default bar is
`default`, for the same reason: typography is a house style and has to be opted
into.

With no path arguments, `check` finds files with `git ls-files`, so it honours
the same ignore rules your repository already has and still sees files that are
new and not yet added. Outside a repository, or with `--no-git`, it walks the
tree instead and skips `node_modules`, build output, virtual environments and
every directory whose name starts with a dot, except the ones coding agents read
instructions from (`.cursor`, `.github`, `.claude`, `.agents`, `.windsurf`,
`.devin`, `.gemini`, `.codex`, `.clinerules`, `.continue`, `.kiro`, `.roo`). `--git` makes a git that cannot be
used a hard error, whether or not you named paths, so CI cannot silently switch
strategy between one container and another. Path arguments are always walked
rather than looked up in git, so `--git <paths>` asserts that git was available
and reports `"discovery": "walk"`. Results are sorted by path, so the output
never depends on directory order. A directory the walk cannot open is an error
on stderr and exit 2, never a silent omission.

A file is skipped, silently and without failing the run, when its extension is a
known binary one, when it is larger than `--max-bytes` (2 MiB by default), when
one of its first 8192 bytes is NUL, or when it is not valid UTF-8. A file you
name on the command line is different: you asserted it is text, so both content
checks stop applying to it, the strict decode decides, and a decode failure is an
error that exits 2.

`check <dir>` finds `<dir>`'s own `ghostchars.json` even when you run it from
somewhere else: with no config beside the working directory, the search moves up
from each path you named, stopping at that path's repository root. Two paths
governed by two different config files is an error, because one run has one root
and a pin is written relative to it. `--verbose` prints which config was used.

### ghostchars.json

Put it at the root of the tree, or point at it with `--config`.

```json
{
  "version": 1,
  "surfaces": [
    {
      "id": "invisibles",
      "bar": "default",
      "include": ["**/*"],
      "exclude": ["vendor/**"]
    },
    {
      "id": "prose",
      "bar": "text",
      "include": ["**/*.md", "src/messages/*.ts"],
      "decodeEscapes": true,
      "pins": { "docs/glyphs.md": 12 }
    }
  ],
  "maxBytes": 2097152
}
```

A surface names a bar (or an `options` list, one of the two, never both), the
globs it covers, and its pins. A file that matches no surface is not checked at
all. An exclusion wins over everything, including a path you named explicitly.
An unknown key is an error that lists the known keys, so a typo in `pins` is
never silently ignored.

The glob subset is `**` for any run of path segments, `*` for any run inside one
segment, and `?` for one character. No braces, no character classes.

`decodeEscapes` resolves `\uXXXX` and `\u{XXXX}` to the characters they render
before the file is checked. Turn it on for a source file whose strings a person
reads, and leave it off everywhere else: a table of codepoints is full of escapes
that match characters rather than ship them.

### Pins

A pin says a file changes by exactly N characters on purpose. It is enforced in
both directions.

| pinned | measured | result |
|---|---|---|
| none | 0 | passes, silently |
| none | N greater than 0 | FAIL `changed`, every character listed |
| N | N | passes |
| N | M, and M is not N | FAIL `pin-mismatch`: changes M characters, but exactly N are pinned |
| N greater than 0 | 0 | FAIL `pin-stale`: pinned as deliberately dirty but now changes nothing. Unpin it |

That last row is the one people forget. It catches a pin that went stale when
somebody quietly fixed the file.

### Output

```
docs/post.md: the text bar would change this file:
  docs/post.md:1:26 U+2014 EM DASH
      Ghostchars is a text tool<EM DASH>it finds what a reader cannot see.
  docs/post.md:2:43 U+200B ZERO WIDTH SPACE
      There is a zero<ZWSP>width space in this one.

ghostchars: 1 file would change, 3 scanned
```

The two placeholders stand for the real characters. This file is held to the
`text` bar itself, so it names a codepoint where it would otherwise print one.

One `path:line:col U+XXXX NAME` line per offending character, and the source line
printed once per distinct line number. Exit 1. When everything passes, one line:
`ghostchars: 3 files pass the text bar`. `--verbose` also names the files that
passed.

### In CI

```
npx -y ghostchars check --bar text
```

That is the whole step. Never pass `--fix` in CI. `--fix` cleans the failing
files in place and then re-checks, which turns a red build green without anyone
reading what changed. It also skips pinned files and names them, because fixing
one would invalidate its own pin.

After a local `--fix`, read back any file that had a dash finding. The cleaner
turns an em dash between two words into a space, a hyphen and a space, which is
correct and reads badly. Those positions are exactly what `rewriteSites` in the
JSON output lists.

`--sarif` prints the same run as a SARIF 2.1.0 log, one result per offending
character with its line, column and source line, one result per pin failure, and
one `hidden-message` result per decoded payload, with the escaped message in the
result text and the scheme, bit count and raw bytes as hex in `properties`.
GitHub code scanning shows those inline on the pull request:

```
- run: npx -y ghostchars check --bar text --sarif > ghostchars.sarif || true
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: ghostchars.sarif
```

The `|| true` is there because exit 1 means findings, and the upload step is
what turns them into annotations. Keep a second plain `check` step if the job
must also fail. `--sarif` and `--json` are two formats for one stdout, so the
command refuses both at once.

### As a GitHub Action

`integrations/github-action/` is a composite Action that does all of the above
in one step. On a pull request it scans the files the pull request changed,
plus every rules file and skill coding agents read (`.claude`, `.cursor`,
`.github`, `AGENTS.md`, `CLAUDE.md` and the rest), whether the pull request
touched them or not. Outside a pull request it scans the whole repository. It
writes a job summary that lists each finding with its file, line and scheme,
shows each decoded hidden message escaped in a fenced block, and uploads SARIF
to code scanning:

```
- uses: actions/checkout@v4
- uses: ghostchars/ghostchars/cli/integrations/github-action@main
  with:
    fail-on: hidden
```

`fail-on` decides what fails the job: `payload` for a decoded hidden message,
`hidden` (the default) for a hidden message, a bidi control or a tag character,
`any` for anything `check` reports, and `never` to report only. The other inputs
are `paths`, `sarif` and `version`. `integrations/github-action/README.md` has
the full reference, and `example-workflow.yml` beside it is a complete workflow
to copy.

### As a pre-commit hook

`integrations/pre-commit/pre-commit-config.yaml` is a paste block for
`.pre-commit-config.yaml`. It is a `repo: local` hook with `language: node`, so
the framework installs the pinned npm package into its own environment and no
repository is cloned. It runs over the staged text files and, like the CI step,
never passes `--fix`.

## Exit codes

| code | meaning | from |
|---|---|---|
| 0 | done, nothing to report | every command |
| 1 | findings, would-change, or a gate failure; for `canary detect`, no mark found | `inspect`, `clean --check`, `check`, `report --fail-on`, `canary detect` |
| any | the wrapped server's own exit code | `mcp-proxy` |
| 2 | the run could not be completed as asked: a usage error, an unreadable or non-UTF-8 file, a bad config, a broken document, a Node older than 22 | every command |
| 3 | an internal error, which is a bug in ghostchars | every command |

The priority is strict and accumulates across inputs: 3 beats 2 beats 1 beats 0.
A decode failure in one file forces 2 even when another file had findings.

Code 3 prints one line and, with `GHOSTCHARS_DEBUG=1` in the environment, a stack
trace. It exists so an agent can tell "I passed the wrong flag" from "the tool
broke", which are different next actions.

`EPIPE` on stdout is a silent exit 0, so `ghostchars inspect big.md | head`
behaves like every other command.

## JSON output

`--json` on `clean`, `inspect` and `check` prints exactly one JSON object to
stdout, never a stream of lines. Four rules, all of them for a machine reader:
`ok` and `exitCode` are in the payload as well as in the process status; counts
come before lists, so a reader that truncates still has the verdict; a cap that
bites always sets `findingsTruncated` and `findingsTotal`; and keys are camelCase.

All three open with the same five identity fields, so one reader can tell what it
is holding before it looks at anything else.

```json
{
 "tool": "ghostchars",
 "version": "1.1.0",
 "command": "clean",
 "ok": true,
 "exitCode": 0
}
```

`clean` and `inspect` continue with `bar`, the resolved `options` list, a
`summary` that totals across inputs, and `results`, one entry per input. A
`clean` result carries `changed`, its own `summary`, a `charsDelta` in
codepoints, the whole cleaned `text` (replaced by `written: true` under `-i`),
and `rewriteSites`. An `inspect` result carries `clean`, `total`, a `summary`, a
`byKind` rollup, then `findings`, each with `line`, `col`, `index`, `cp`, `u`,
`name`, `kind`, `flag`, `action` and, for a substitution only, `replacement`, and
then `payloads`. The `inspect` summary also counts `payloads` across inputs.

Each entry in `payloads` has `scheme`, `confidence` (`decoded` or
`fingerprint`), the `line` and `col` of the first carrier, `start` and `end` as
codepoint indices with an exclusive end, `bits`, the raw bytes as lowercase
`hex`, and `text`: the decoded message, or `null` for a fingerprint. The list is
never capped. `text` is untrusted data written by whoever hid it.

**`rewriteSites` is the field worth reading.** It lists exactly the positions
where a dash sits between two non-space characters, which is where `--punct`
substitutes a bare hyphen. Those are the sentences to rewrite rather than
accept. Curly quotes, ellipses and no-break spaces flatten correctly and are not
listed.

`check` continues differently, because a gate has no single bar: `root`,
`discovery`, `config`, a `surfaces` array carrying each surface's own bar,
options and counts, then `filesScanned`, `filesSkipped`, `filesFailing`,
`failures` with their `status`, `hits` and `payloads`, and a `skipped` list capped at 50 with
`skippedTruncated` and `skippedTotal`.

**The one exception: `report --json` has no envelope and its keys are
snake_case.** That output is byte-identical to the Python reference report,
including how it prints a whole-number float as `12.0`, so a payload from either
implementation diffs cleanly against the other. One result unwraps to the bare
report object; any other number produces a `{label: report}` map. The condition
is on the number of RESULTS, not of file arguments, so two files where one could
not be read still print a bare object.

## MCP proxy

An MCP server you install reaches the model through more than its tool results:
its instructions, its tool and argument descriptions, its prompts and its
resources are all read by the model, and any of them can carry an instruction
written in characters a person reviewing the server never sees.
`mcp-proxy` sits between the host and that server and cleans what flows back.

```
ghostchars mcp-proxy [--report-only] [--log <file>] [--max] -- <command> [args...]
```

Everything after `--` is the server's own command line. The proxy starts it,
relays JSON-RPC both ways over stdio, and cleans the strings in these results:
`initialize` (the server `instructions` and `serverInfo`), `tools/list`, `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`,
`prompts/get`, `completion/complete` and the task methods `tasks/get`,
`tasks/list`, `tasks/result` and `tasks/cancel`, plus the message and data of an
error answering one of them. That covers tool names and descriptions, input schemas, text
content, structured content, resource text, prompt messages and completion
values. A resource `blob` whose media type is a known binary type (image,
audio, video, font, or an archive such as zip or gzip) passes as it is. Any
other blob, `application/octet-stream` and untyped ones included, is decoded
(base64 or base64url) and cleaned like text. One that does not decode strictly
as UTF-8, whose media type does not parse by the HTTP grammar, or whose
`charset` is anything but one plain UTF-8 or ASCII, is replaced with a notice,
because a lenient host might still read it.

It also cleans what the server sends on its own: the params of
`sampling/createMessage` (the messages, the system prompt and any tools),
`elicitation/create` (the message and the requested schema), and the
`notifications/message`, `notifications/progress`, `notifications/cancelled`
and `notifications/tasks/status` notifications.

A message counts as a response when it has a `result` or an `error`, even if it
also has a `method`, so a server cannot slip a response past the filter by
dressing it as a request. A response to an id the host has no open request for
(one it never sent, or one already answered) has its whole result cleaned,
since a lenient client might still read it.

What cleaning means here:

- Every string gets the default clean (or the max clean under `--max`), with
  controls and private-use characters removed too.
- On top of that the proxy applies a stricter policy than the default clean,
  because a server has no reason to send what the default clean keeps for
  ordinary writing: tag characters outside the England, Scotland and Wales
  flags; any variation selector except VS16 after a character drawn as text by
  default or VS15 after one drawn as emoji by default, so a selector that
  restates the default goes; left-to-right, right-to-left and Arabic letter
  marks and the bidi isolates; and joiners between letters packed denser than
  one per eight letters of the scripts that use them, judged over the whole
  string (with three or more) and over every stretch of 64 letters (Persian
  prose has one per 15 to 40). Each such removal is named on stderr and in
  the notice.
- When the decoder finds a hidden message, it is removed: a run of tag
  characters, variation selectors or zero-width characters is deleted outright,
  and a pattern in visible typography (trailing whitespace, no-break spaces,
  doubled spaces, curly apostrophes, decomposed letters) is flattened by turning
  on the matching clean option for that string.
- A text, description, instructions or error message that lost a hidden message
  ends with a visible notice, such as
  `[ghostchars removed hidden content from this text: tag-ascii, 28 characters]`.
  The notice names the scheme and the number of characters that carried it, never
  the decoded text, because the decoded text is the attack.
- Look-alike letters are a fingerprint rather than a message, and folding them
  rewrites letters, so they are reported and kept unless you pass `--max`.

Fields a client compares exactly keep their visible text exactly, and each
removal from them is reported:

- Protocol fields (`uri`, `uriTemplate`, `url`, `mimeType`, `protocolVersion`,
  base64 `data` and `blob`, and the schema keywords `type`, `format`,
  `pattern`, `$ref` and the like), object keys, the `enum`, `const` and
  `required` values of a schema, everything in `_meta`, the method name, any
  member JSON-RPC does not define, and the whole of a response or server
  message whose method is not listed above lose every invisible, bidi, format
  and control character and everything the policy above removes. Glue the
  classifier binds stays (the joiner in a Persian word, the ZWJ and VS16 of an
  emoji), so a property name and the `required` entry naming it still match,
  but a value with more than two joiners between letters loses them all.
  A message hidden in no-break spaces or another visible channel is flattened
  by that channel. A `data` value that is not base64 is text and gets the full
  clean.
- A schema's `default`, examples, `title` and `description` are free text and
  get the full clean.
- An id the host matches against its own copy cannot be rewritten without
  breaking the match, so a message with any hidden character in one is
  withheld. That holds where the id really is one: `params.progressToken` of a
  progress notification, `params.requestId` of a cancellation, `params.taskId`
  of a task status or task request, `params.elicitationId` of an elicitation,
  a list's `result.nextCursor`, and a task's `taskId` in a result. The same
  names anywhere else are cleaned like any other text.
- A message's own `id` and `jsonrpc` are never rewritten either. A message is
  withheld when its `jsonrpc` is not exactly `"2.0"`, when its id is not a
  string, a number or null, or when a string id holds a hidden character.

When the proxy withholds a response to a request the host has open, the host
gets a JSON-RPC error for that request instead (code -32603, with the reason),
so it does not wait for an answer that never comes. A message nested more than
512 levels deep is withheld the same way, before it is parsed.

Every key is cleaned before the proxy reads a field by its name, so a key
dressed with a hidden character is judged as the name a client will read. An
object with two keys that are the same once cleaned is replaced with a notice,
and a message with two such members is withheld.

Left alone on purpose: requests from the host to the server, which pass through
byte for byte, and a `blob` of a known binary media type.

Every message from the server is forwarded as the JSON the proxy parsed and
checked, written out again, never as the bytes the server wrote, even when
nothing changed. That way the host reads exactly what was checked, whatever
its own parser does with a duplicated member name or an unusual escape. Under
`--report-only`, which changes nothing, the server's bytes go on as they
arrived.

On stdio, MCP is one JSON-RPC message per line and a server may write nothing
else to stdout. A line that is not a JSON-RPC message is a protocol error a
client discards, so the proxy drops it and names it on stderr by size, never by
content. Under `--report-only` it is passed on and still named.

| flag | effect |
|---|---|
| `--report-only` | change nothing, and report each finding on stderr |
| `--log <file>` | append one JSON line per finding: the method, a JSON pointer to the field, counts by kind, and each hidden message's scheme, size and what was done with it. Never the text it was found in |
| `--max` | clean at the max bar, which also folds look-alike letters |

Each finding is also one line on stderr, which most hosts show in their MCP
log. The server's own stderr goes on line by line, each line cleaned like
prose, and a finding in a line is reported after it.

The proxy exits with the server's exit code. If the server dies of a signal,
the proxy dies of the same signal, and SIGINT, SIGTERM and SIGHUP sent to the
proxy are passed on to the server. A server command that cannot be started exits
2 with the reason.

Limits. The proxy narrows what a server can hide; it does not close every
channel:

- Joiners between letters below the density threshold, up to one per eight
  letters of Arabic, Persian, Indic and similar scripts, can still carry a
  slow message.
- Visible text is not judged: word choice, spacing patterns the decoder does
  not recognise, and look-alike letters, which are kept unless you pass `--max`.
- A blob of a known binary type (image, audio, video, font, archive) passes as
  it is, so anything inside its bytes passes too.

Cleaning a tool name has a cost: if a name itself carried hidden characters, the
host calls the cleaned name and the server may not recognise it. That is the
right failure for a name built to hide something.

`integrations/mcp/` has three examples that wrap a server this way, for Claude
Code (`claude-code.proxy.mcp.json`), Cursor (`cursor.proxy.mcp.json`) and Codex
(`codex.proxy.config.toml`). The pattern is the same in every host: the
command becomes `npx`, and the arguments become
`-y ghostchars mcp-proxy --` followed by the server's original command and
arguments.

## Canary marks

Before a confidential draft goes out, give each recipient their own copy with
their id hidden in it. If a copy turns up where it should not, `canary detect`
names the recipient it was sent to.

```
ghostchars canary embed --id alice memo.txt > memo.alice.txt
ghostchars canary embed --ids recipients.txt --out-dir marked memo.txt
ghostchars canary detect leaked.txt
```

`embed --id` writes the marked text to stdout. `embed --ids <file>` reads one id
per line (blank lines and lines starting with `#` are skipped), checks every id
first, and writes one copy per id to `--out-dir`, named after the input and the
id: `marked/memo.alice.txt`. An id is up to 64 bytes of UTF-8 with no hidden
characters or line breaks. Marking a marked copy replaces its id.

`detect` prints one line per distinct mark and exits 0 when it found one, or 1
when it found none. With `--json` it prints the marks as records: `id`, `keyed`,
`status`, `count` (how many whole copies), and the `start` and `end` of the
first one in codepoints.

How it works: the id, a length byte and a CRC-32 are written as bits in a run of
ZERO WIDTH SPACE and ZERO WIDTH NON-JOINER in front of a word. A copy goes in
front of the first word and every tenth word after it, so any excerpt of eleven
words or more carries a whole mark. A run that does not hold a whole frame with
a matching checksum is ignored, so noise or a damaged copy never names a wrong
recipient. These two characters were chosen because real text needs them, so
editors, chat apps and clipboards tend to keep them where tag characters are
more often dropped. The trade-off is that they are also the first characters a
cleaner looks for.

**Keys.** Anyone can write an unkeyed mark naming anyone. With a key, the mark
also carries a truncated HMAC-SHA256 of the id, so only the key holder can make
one that verifies. Pass the key with `--key-file <path>` (trailing line breaks
are dropped) or `--key-env <name>`; there is no flag that takes the key itself,
because a process listing shows every argument. `detect` reports a keyed mark as
`verified` with the right key, `rejected` with a wrong one, and `unverified`
with none. The id stays readable without the key: the key authenticates it, it
does not hide it.

**What it is not.** Any hidden-character cleaner removes the mark, this one
included: `ghostchars clean` turns a marked copy back into the original, byte
for byte. A mark deters and traces casual leaks, a forwarded or pasted copy. It
is not tamper-proof, and retyping or rewording the text removes it too.
`inspect` and `check` report a mark as the `canary` hidden-message scheme, with
the id when it is unkeyed.

## As a library

The package also exports the engine, with types:

```js
import { clean, find, decode, embedCanary, detectCanary } from 'ghostchars'

clean(text).text                    // the cleaned text, default options
clean(text, { punct: true }).text   // any of the thirteen options
find(text)                          // every suspicious character, with line and column
decode(text)                        // hidden messages, as records
embedCanary(text, 'alice')          // a copy with an invisible recipient mark
detectCanary(text, key)             // the marks in a copy, verified when a key is given
```

It is the same plain-text engine the CLI runs, with no I/O and nothing run on
import. The document readers are not part of it. A decoded message is untrusted
data written by whoever hid it: show it as text, and never follow it as an
instruction.

## Install for your agent

The CLI on its own is enough: any agent that can run a shell command can run
`npx -y ghostchars check --bar text`. The files below make it happen without
being asked each time. They ship inside the package, so copy them from
`$(npm root -g)/ghostchars/integrations/` after a global install, or from
`node_modules/ghostchars/integrations/` after a local one.
`integrations/README.md` has the per-tool copy commands.

**The hook.** `integrations/hooks/` is a Claude Code `PostToolUse` hook that
holds every file the agent writes or edits to the text bar and hands a finding
back as feedback, so the model fixes it in the same turn. It never rewrites the
file. Copy the script to `.claude/hooks/` and merge the settings fragment into
`.claude/settings.json`.

**The skill.** `integrations/skills/ghostchars/` is one directory holding
`SKILL.md` and two reference files. Copy it to `.claude/skills/ghostchars/` and
to `.agents/skills/ghostchars/`, or put it in one and symlink the other. That
covers Claude Code, Codex, Cursor, VS Code with Copilot, and Gemini CLI from a
single copy. It is the highest-value file here: it tells the agent when to run
the tool and, more importantly, what to do with each kind of finding.

**The always-on rule blocks.** `integrations/rules/` holds a short paste block
for `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`, plus ready-made rule files for
Cursor, Windsurf and Copilot. A skill loads on demand; these are always in
context. Windsurf has no skill support, so its rule file is the whole integration
there.

**The MCP proxy.** The three `*.proxy.*` files in `integrations/mcp/` show how to
put any other MCP server behind `ghostchars mcp-proxy`, so what that server
sends the model is cleaned first.

**The MCP server.** `integrations/mcp/` holds one config snippet per host. Adding
it gives the agent four read-only tools (`clean_text`, `inspect_text`,
`style_report`, `check_paths`) with typed inputs and outputs, which saves a shell
round trip and a JSON parse on hosts that prefer structured tools. A fifth tool,
`clean_files`, writes to disk and is registered only under `--allow-write`.

**The GitHub Action.** `integrations/github-action/` scans every pull request,
including the rule files and skills above, and fails it on a hidden message, a
bidi control or a tag character. It is referenced from a workflow rather than
copied (see [As a GitHub Action](#as-a-github-action)).

Take any of them or all of them. They do not conflict.

## Differences from the Python reference CLI

The golden fixtures pin `clean` and `inspect` to the Python byte for byte across
every text fixture and every option combination, and `report --json` to its
exact bytes. Everything below is a deliberate difference, and the tests pin
each one.

| behaviour | Python | ghostchars |
|---|---|---|
| an abbreviated long option, `--punc` for `--punct` | accepted | unknown flag, exit 2, with the nearest known flag named |
| usage text on a parse error | argparse's wrapped block | one line, a suggestion, and a pointer to `help --json` |
| a missing or unreadable file | traceback, exit 1 | `{path}: no such file or directory`, exit 2 |
| an in-place write | truncate and write | temp file, fsync, mode copied, symlink resolved, rename |
| `.html` and `.htm` in `clean` | cleaned as plain text, markup included | cleaned structurally; `--as text` restores the old behaviour |
| an unrecognised extension | an `unsupported type` error | plain text |
| the `report` human render | middle dot and en dash separators | ASCII, `, ` and ` to `. Byte parity for `report` lives in `--json` |
| `report` on an unreadable file | prints the exception, always exits 0 | prints the message, exits 2 |
| an internal error | traceback, exit 1 | one line, exit 3, stack under `GHOSTCHARS_DEBUG=1` |
| SIGPIPE on stdout | a message, exit 120 | silent exit 0 |
| findings under `--nfc` or `--nfkc` | separate code paths, never cross-referenced | `clean --json` scans findings from the original text, so a normalised character can read as `found-not-targeted`. The cleaned text is authoritative |
| the NAME column for a codepoint the Unicode database does not name | `<unnamed>` | a C0 or C1 control's standard alias (BELL, NEXT LINE) where it has one, `U+XXXX` otherwise |

The last row runs the other way from the rest of the table: it is the one place this tool
prints more than the reference, not less. Every codepoint the Unicode Character
Database does name is named identically here, look-alike letters included, and a
test compares all 1508 nameable look-alikes against `unicodedata` in both
directions, so a missing name and a wrong one both fail.

New here, with no Python counterpart: `--bar`, `--json`, `--stdin-name`, `--as`,
`--limit`, `--fail-on`, `--fix`, the whole `check` command, the `mcp` server, the
`mcp-proxy` command, and the library export.

Two consequences of the atomic write worth knowing: a real write changes the
file's inode, so a hard link to it breaks, and a crash mid-write leaves a
`.ghostchars-*.tmp` file beside the original instead of a truncated original. A
file that would not change is never opened for writing, so its modification time
and inode survive untouched.

## What this cannot do

- **Statistical watermarks** such as SynthID-Text or KGW. They live in word
  choice, not in characters. Only rewriting touches them.
- **Stylometric detection.** Vocabulary, rhythm and structure. `report` measures
  some of the same habits so you can edit them, and it is not a detector: it
  emits no probability and no score, and it never decides whether a text was
  generated.
- **PDF, images, `.pptx`, `.xlsx`, `.rtf`, `.doc`, `.epub`, `.pages` and Google
  Docs.** EXIF, XMP and C2PA are a different tool.
- **Removing what hides around the text.** Hidden runs, comments and tracked
  changes are reported, never deleted.
- **Escapes outside `check`.** A U+2014 EM DASH written as a backslash-u escape
  in a source file is invisible unless a `ghostchars.json` surface turns
  `decodeEscapes` on, and there is no equivalent for extracting the string
  literals out of a language the tool does not parse.
- **Documents in `check` or over MCP.** A gate walking a repository does not open
  zip archives.
- **Anything over the network.** There is no network code in this package and
  no telemetry.
