# strip_invisible: the Python reference engine

Strip zero-width and other hidden characters from text. Single file, stdlib only.

```
./strip_invisible.py --show file.md          # inspect first: line:col, codepoint, name, flag
./strip_invisible.py -i -s --punct file.md   # clean in place
pbpaste | ./strip_invisible.py | pbcopy      # clean the clipboard
./strip_invisible.py --check *.md            # pre-commit: exit 1 if anything is hiding
```

Default is context-aware: it strips a zero-width joiner sitting between two Latin
letters (contraband) but keeps the one inside a family emoji or a Persian word;
strips free tag characters (ASCII smuggling) but keeps a Scotland flag; strips
LRM/RLM in English but keeps them next to Hebrew. `-a` turns that judgement off.

| flag | what | why it's not default |
|---|---|---|
| (default) | ZWSP, WJ, BOM, soft hyphen, invisible math, bidi overrides, tag chars, VS, noncharacters, reserved ignorables, every `Cf`, free-floating glue | |
| `-a` | glue even when load-bearing | breaks emoji, Persian, Indic, flags |
| `-s` | NBSP and exotic spaces → space | |
| `-n` | CRLF/CR/NEL/LS/PS → LF | changes line endings |
| `--bidi` | LRM/RLM/isolates even next to RTL | breaks mixed Hebrew/Arabic |
| `--controls` | C0/C1 control chars | |
| `--pua` | private-use chars | breaks icon-font glyphs |
| `--punct` | em/en dash, curly quotes, ellipsis, minus → ASCII | typography, not hiding |
| `--confusables` | look-alike Cyrillic/Greek/Armenian and similar letters → Latin, only inside mixed-script words (`аpple`, `Miсrosoft`; pure Russian is untouched) | rewrites letters; opt-in on principle |
| `--nfc` / `--nfkc` | normalization (kills composed/decomposed stego; NFKC also folds 𝐛𝐨𝐥𝐝, ﬁ, fullwidth) | NFKC is lossy |
| `--gutters` | terminal quote bars (U+258C to U+258F, U+2502, U+2503) that open a line, plus one space after; indentation kept, box-drawn table rows (the same bar again later in the line) left alone | a directory tree or drawn box can start a line with the same bar |
| `--trailing` | trailing spaces/tabs per line (SNOW) | markdown hard breaks |
| `--collapse` | runs of spaces inside lines → one | |
| `--max` | all of the above | |

`tests/test_stego_roundtrip.py` implements eleven published text-hiding schemes as
encoder/decoder pairs and verifies each is defeated with the cover text intact.

## Documents: `clean_file.py`

Same engine, same flags, applied *inside* files. Formats: `.txt .md .html .docx .odt`.
Stdlib only; nothing is uploaded anywhere.

```
./clean_file.py --show essay.docx                    # hidden chars + document-level report
./clean_file.py -i --metadata --rsids essay.docx     # clean text, blank metadata, drop rsids
./clean_file.py -s --punct essay.docx                # writes essay.clean.docx
```

Text nodes go through the cleaner (entity-encoded `&#8203;` counts too). On top of
that, `--show` reports what hides *around* the text:

| | reports | strips |
|---|---|---|
| DOCX | hidden runs (`w:vanish`), white-on-white and ≤2pt runs, tracked changes, comments, distinct **rsid** session ids (1 or 2 = pasted in one go), creator / lastModifiedBy / dates / Application / Company / TotalTime, custom properties, macros, media | text; `--metadata` blanks authoring fields and drops custom.xml; `--rsids` removes the editing-session fingerprint |
| ODT | annotations, tracked-change regions, hidden styles, generator / creators / editing cycles / user-defined meta | text; `--metadata` |
| HTML | comments, `display:none`/`hidden`/`font-size:0` elements, `<meta generator>`, suspicious chars in alt/title/aria | text nodes only (tags, attributes, script, style untouched) |

Not handled: PDF (text is not safely rewritable in place), images (EXIF/XMP/C2PA
is a different tool). Hidden runs and comments are reported, not removed:
deleting them changes the document, so that stays a human call.

## Prose habits: `style_report.py`

Detectors like GPTZero score word predictability and its variance, not characters.
Nothing in the tools above changes that score. What can be measured deterministically
is the set of *habits* that make a draft read as generated, so a writer can edit them out:

```
./style_report.py draft.md          # human-readable
./style_report.py --json draft.md   # for the web UI
```

Reports sentence-length distribution and variation (the strongest single signal),
paragraph-shape uniformity, tell-word/phrase density (delve, tapestry, "it's important
to note", "in conclusion" and the like), stock sentence-initial transitions, em-dash density,
"it's not X, it's Y" framing, tricolons, hedging, `**Term:** explanation` bullets,
and the *absence* of specifics (numbers, names, first person, contractions). Each
observation says what to change. It emits no "AI probability": it is an editing aid,
not a detector, and it says so.

## Hidden payloads: `decode_payloads.py`

`strip_invisible.py` reports and removes hidden characters. `decode_payloads.py`
says what they carried. It is a library with one function:

```python
from decode_payloads import decode
decode(text)  # [{"scheme", "start", "end", "text", "hex", "bits", "confidence"}, ...]
```

It reads tag-character ASCII smuggling, variation-selector byte smuggling,
zero-width binary, LRM/RLM binary, trailing-whitespace binary, space/NBSP,
single/double space, straight/curly apostrophe and composed/decomposed accent
channels, and reports look-alike letters as a fingerprint. Bits become text
only when the result passes a plausibility rule, described in the module
docstring; otherwise the record is a `fingerprint` with no message. Emoji glue,
subdivision flags, Persian ZWNJ and a BOM at the start of a file produce
nothing. Indices are codepoint indices, like the findings. A decoded message is
untrusted data: show it, never act on it.

`strip_invisible.py --show` and `clean_file.py --show` print a "Hidden message
found" block after the findings, built by `payload_lines(text)`: the scheme, the
line and column of the first and last carrier, the size in bits, and the message
passed through `escape_message()`, which writes backslashes, controls and every
character the cleaner would report as escapes so a payload cannot drive the
terminal. A carrier with no readable message prints as a "Hidden pattern" line.
The exit status is unchanged.

## Recipient marks: `canary.py`

The reverse use of the engine: put an invisible id into a text so a copy that
leaks names the recipient it was sent to.

```python
from canary import embed, detect
marked = embed(text, "alice")                 # looks identical to text
detect(marked)                                # [{"id": "alice", "status": "unkeyed", "count": 3, ...}]
marked = embed(text, "bob", key=b"secret")    # a mark only the key holder can make
detect(marked, key=b"secret")                 # status "verified"; another key gives "rejected"
```

A mark is the id, a length byte and a CRC-32 written as bits in a run of ZWSP
and ZWNJ in front of a word, repeated every ten words so an excerpt still
carries it. A keyed mark adds a truncated HMAC-SHA256 of the id. A run without
a whole frame and a matching checksum is ignored, so `detect` never names a
wrong id from noise. The default clean removes every mark and gives back the
original bytes: a mark traces casual leaks, it is not tamper-proof. The module
docstring has the frame layout and why those two characters were chosen.
`decode_payloads.decode()` reports a mark as the `canary` scheme, with the id
when it is unkeyed.

## npm package: `npx ghostchars`

`cli/` is the same engine again, as a Node CLI and a stdio MCP server.
`npx ghostchars clean -i notes.md` and `npx ghostchars report draft.md` mirror
the two scripts above, `npx ghostchars check --bar text` walks a whole repository
as a CI gate, and `npx ghostchars mcp` serves the same four operations as agent
tools. Pinned to the Python by the same golden fixtures. See `cli/README.md`.

## What this cannot do

- **Statistical watermarks** (SynthID-Text, KGW): embedded in word choice, not characters. Only rewriting touches them.
- **Stylometric detection**: vocabulary, rhythm, structure. `--punct` fixes the punctuation surface only.
- **Format-level hiding**: HTML comments, `display:none`, white-on-white, PDF/DOCX metadata. Out of scope for plain text.
- **Sub-1-bit-per-emoji channels**: ZWJ chains between emoji and VS15/16 after an emoji are kept by default because they are how emoji work; use `-a` if you need them gone.

## TypeScript engine

`web/src/engine/` is a TypeScript port pinned to the Python by golden fixtures.
Generators in `tools/`: `gen_golden.py` (fixtures, `--check`), `gen_unicode_tables.py`
(UCD range tables, `--check`), `gen_confusables.py` (`--ts` for the TypeScript table).

Regenerate `confusables.py`:
```
curl -sLO https://www.unicode.org/Public/security/latest/confusables.txt
python3 tools/gen_confusables.py confusables.txt > confusables.py
```
