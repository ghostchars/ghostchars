#!/usr/bin/env python3
"""Generate the TypeScript engine's parity fixtures from the Python reference.

    python3 tools/gen_golden.py             # write both outputs
    python3 tools/gen_golden.py --check     # CI: exit 1 if the outputs are stale

Outputs (both are generated; never edit them by hand):

    web/src/engine/__fixtures__/golden.json
        Every fixture text with its `strip_invisible.find()` hits (recorded once:
        find() is context-aware but flag-independent) and `strip_invisible.clean()`
        output for each of the 16 flag combos; `style_report.analyze()` JSON for
        the style fixtures; DOCX/ODT/HTML packages with their Python-cleaned forms
        and `clean_file` inspection reports; `decode_payloads.decode()` records
        for every text fixture and for the decode cases; and `canary.embed()`,
        `canary.detect()` and `canary.id_error()` results for the canary cases.

    web/src/engine/unicode-names.ts
        codepoint -> Unicode name for every codepoint the engine can classify.

Fixture inputs are taken from the test suite itself wherever possible so the
fixtures cannot drift from the tests: the stego encoders are imported from
tests/test_stego_roundtrip.py, and make_docx / make_odt / MACHINE / HUMAN are
lifted out of tests/test_clean_file.py and tests/test_style_report.py by AST
extraction (those two modules run their assertions at import time, so they
cannot simply be imported).

Determinism (the file is regenerated and diffed in CI):
  * JSON is written with sorted keys and ensure_ascii, so invisible characters
    survive any editor or formatter as \\uXXXX escapes.
  * Every zip in the fixture is re-serialized with a fixed 1980-01-01 timestamp
    and ZIP_STORED entries, because deflate output differs between zlib builds
    (zlib vs zlib-ng) and would make the file machine-dependent. The compression
    method Python actually chose for each entry is recorded per entry instead,
    under `entries[].compress`.
  * Nothing that varies per machine (paths, interpreter version, wall clock) is
    written. `meta.unicodeVersion` is recorded on purpose: a CI runner with a
    different UCD version must be noticed, not silently tolerated.
"""

from __future__ import annotations

import argparse
import ast
import base64
import importlib.util
import io
import json
import os
import sys
import types
import unicodedata
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TESTS = os.path.join(ROOT, "tests")
sys.path.insert(0, ROOT)

import canary  # noqa: E402
import clean_file as cf  # noqa: E402
import decode_payloads as dp  # noqa: E402
import strip_invisible as si  # noqa: E402
import style_report as sr  # noqa: E402

GOLDEN_PATH = os.path.join(ROOT, "web", "src", "engine", "__fixtures__", "golden.json")
NAMES_PATH = os.path.join(ROOT, "web", "src", "engine", "unicode-names.ts")

FIXED_DATE = (1980, 1, 1, 0, 0, 0)


# ------------------------------------------------------- test-module reuse ----

def import_module_from(path: str, name: str) -> types.ModuleType:
    """Import a module that is safe to import (guards its own __main__)."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extract_from(path: str, names: tuple[str, ...], preload: dict) -> dict:
    """Exec only the named top-level defs/assignments of a script.

    tests/test_clean_file.py and tests/test_style_report.py run their checks at
    import time; this lifts the fixture builders out of them without running the
    suite, and fails loudly if a name is gone (which is the drift we want CI to
    catch).
    """
    with open(path, encoding="utf-8") as f:
        source = f.read()
    tree = ast.parse(source, filename=path)
    wanted = set(names)
    keep: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            keep.append(node)
        elif isinstance(node, ast.Assign):
            bound: list[str] = []
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bound.append(target.id)
                elif isinstance(target, ast.Tuple):
                    bound += [e.id for e in target.elts if isinstance(e, ast.Name)]
            if any(b in wanted for b in bound):
                keep.append(node)
    namespace = dict(preload)
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), namespace)  # noqa: S102
    missing = sorted(wanted - namespace.keys())
    if missing:
        raise SystemExit(f"{path}: expected fixture names not found: {missing}")
    return {n: namespace[n] for n in names}


STEGO = import_module_from(os.path.join(TESTS, "test_stego_roundtrip.py"), "test_stego_roundtrip")
DOCFX = extract_from(
    os.path.join(TESTS, "test_clean_file.py"),
    ("ZWSP", "ZWJ", "TAG_H", "TAG_I", "CYR_A", "FAMILY", "W", "make_docx", "make_odt"),
    {"zipfile": zipfile},
)
STYLEFX = extract_from(os.path.join(TESTS, "test_style_report.py"), ("MACHINE", "HUMAN"), {})
DECODEFX = import_module_from(os.path.join(TESTS, "test_decode_payloads.py"), "test_decode_payloads")
CANARYFX = import_module_from(os.path.join(TESTS, "test_canary.py"), "test_canary")


# ---------------------------------------------------------------- options ----

CLEAN_FIELDS = ("aggressive", "spaces", "newlines", "bidi", "controls", "pua", "punct",
                "confusables", "nfc", "nfkc", "gutters", "trailing", "collapse")
FILE_FIELDS = ("metadata", "rsids")


def options(*on: str) -> types.SimpleNamespace:
    args = types.SimpleNamespace(**{f: False for f in CLEAN_FIELDS + FILE_FIELDS})
    for field in on:
        if not hasattr(args, field):
            raise SystemExit(f"unknown option {field!r}")
        setattr(args, field, True)
    return args


# id -> the option fields it turns on. Order is the report order in the UI.
COMBOS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("none", ()),
    ("-a", ("aggressive",)),
    ("-s", ("spaces",)),
    ("-n", ("newlines",)),
    ("--punct", ("punct",)),
    ("--confusables", ("confusables",)),
    ("--nfc", ("nfc",)),
    ("--nfkc", ("nfkc",)),
    ("--gutters", ("gutters",)),
    ("--gutters --trailing", ("gutters", "trailing")),
    ("--trailing", ("trailing",)),
    ("--collapse", ("collapse",)),
    ("--bidi", ("bidi",)),
    ("--controls", ("controls",)),
    ("--pua", ("pua",)),
    ("--max", tuple(si.MAX_FLAGS)),
)

DOC_FLAG_SETS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("none", ()),
    ("--metadata --rsids", ("metadata", "rsids")),
    ("-s --punct", ("spaces", "punct")),
)


# --------------------------------------------------------------- fixtures ----

# The 26 codepoints with a dedicated fixture: 24 singles plus one member each
# of the tag block and the variation-selector block.
CODEPOINTS_26: tuple[tuple[int, str], ...] = (
    (0x200B, "zero width space"),
    (0x200C, "zero width non-joiner"),
    (0x200D, "zero width joiner"),
    (0x2060, "word joiner"),
    (0x00AD, "soft hyphen"),
    (0x2062, "invisible times"),
    (0x2063, "invisible separator"),
    (0x2064, "invisible plus"),
    (0x2061, "function application"),
    (0x200E, "left-to-right mark"),
    (0x200F, "right-to-left mark"),
    (0x202A, "left-to-right embedding"),
    (0x202B, "right-to-left embedding"),
    (0x202C, "pop directional formatting"),
    (0x202D, "left-to-right override"),
    (0x202E, "right-to-left override"),
    (0x2028, "line separator"),
    (0x2029, "paragraph separator"),
    (0x0085, "next line"),
    (0x00A0, "no-break space"),
    (0x202F, "narrow no-break space"),
    (0x205F, "medium mathematical space"),
    (0x3000, "ideographic space"),
    (0xFEFF, "zero width no-break space / BOM"),
    (0xE0048, "tag block (TAG LATIN CAPITAL LETTER H)"),
    (0xFE0F, "variation selector block (VS16)"),
)

PERSIAN = "می‌روم"
DEVANAGARI = "क्‍ष"
SCOT = "\U0001f3f4\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f"
FAMILY = DOCFX["FAMILY"]
HEBREW = "שלום"

PARAGRAPH_3KB = (
    "The​ Fenwick Building fire of March 1974 is remembered, when it is "
    "remembered at all, as a footnote in the city’s insurance history—a "
    "$2.3 million loss, no fatalities, a warehouse full of upholstery foam that "
    "should never have been stored six pallets high. What the footnote leaves out "
    "is the twenty‑three minutes between the first alarm and the arrival of "
    "Ladder 9, and what those minutes did to the way this city writes its building "
    "codes.\n\n"
    "Marta Kellerman was the dispatcher on duty. She had been at the console for "
    "eleven hours, covering a shift for a colleague whose daughter had chicken pox, "
    "and she took the call at 4:12 a.m. from a night watchman named Aldo Rossi "
    "who could not tell her which side of the building he was standing on. “I "
    "asked him what he could see,” she told the inquiry two years later. "
    "“He said orange. That was all he had.” The transcript of that call "
    "runs to four pages; it is still handed out on the first day of dispatcher "
    "training, not as a warning but as an ordinary example of how bad the "
    "information usually is…\n\n"
    "The building had two addresses—one on Fenwick, one on the alley behind "
    "it—and the fire department’s map card listed only the second. Trucks "
    "went to the alley. The alley was blocked by a delivery van whose driver had "
    "gone home at midnight and left it there, as he had every night for two years, "
    "because nobody had ever told him not to. By the time the first hose was "
    "charged, the roof had failed over the north bay, and the foam—which "
    "burns at roughly twice the rate of the wood it was stacked against—had "
    "taken the sprinkler risers with it.\n\n"
    "Se­cond-guessing is easy at this distance. The inquiry did not do much of "
    "it. What it produced instead was Ordinance 74–31, eleven pages long, "
    "which required that every commercial structure carry one address and one only, "
    "that map cards be reconciled against the assessor’s roll each January, "
    "and that any lane used for fire access be posted and enforced by the police "
    "rather than by the fire marshal, who had no power to tow. None of this is "
    "dramatic. All of it was cheap. The city has had four warehouse fires of "
    "comparable size since; the slowest response among them was six minutes.\n\n"
    "I went looking for Rossi’s statement in the municipal archive last spring "
    "and found it in a box that had not been opened since 1981, according to the "
    "card taped inside the lid. He was 61 at the time of the fire and worked "
    "another nine years. His statement is one paragraph. He apologizes twice for "
    "not knowing the address, and then he says that he went back in for the dog "
    "that lived in the loading office, and that the dog was fine. The inquiry did "
    "not ask him about the dog. It is the only sentence in the whole file that "
    "sounds like a person talking\U000e0048\U000e0069.\n"
)


def text_fixtures() -> list[dict]:
    """Every plain-text fixture, with its find() hits and per-combo clean()."""
    out: list[tuple[str, str, str, str]] = []

    def add(fid: str, group: str, note: str, text: str) -> None:
        out.append((fid, group, note, text))

    # -- the 26 codepoint pages, one per fixture, plus one mixed paragraph
    for cp, label in CODEPOINTS_26:
        add(f"cp-{cp:04x}", "codepoints", f"{label} between two Latin letters",
            "A" + chr(cp) + "B")
    mixed = "The " + " ".join(
        word + chr(cp) for word, (cp, _) in zip(
            ("quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog", "and",
             "packs", "my", "box", "with", "five", "dozen", "liquor", "jugs", "then",
             "waltzes", "badly", "for", "vexing", "quiz", "prof", "jack", "quartz"),
            CODEPOINTS_26))
    add("cp-mixed-paragraph", "codepoints", "all 26 in one paragraph", mixed + " done.")

    # -- context-aware glue (tests/test_strip_invisible.py)
    add("glue-family-emoji", "context", "ZWJ inside a family emoji", FAMILY)
    add("glue-family-in-prose", "context", "family emoji inside a sentence",
        "we sent " + FAMILY + " to the party")
    add("glue-heart-on-fire", "context", "VS16 + ZWJ chain", "❤️‍\U0001f525")
    add("glue-red-heart-vs16", "context", "red heart with VS16", "❤️")
    add("glue-keycap", "context", "keycap sequence 1️⃣", "1️⃣")
    add("glue-vs16-after-latin", "context", "free VS16 after a Latin letter", "A️B")
    add("glue-persian-zwnj", "context", "Persian ZWNJ inside a word", PERSIAN)
    add("glue-persian-sentence", "context", "Persian ZWNJ in a sentence",
        "من هر روز به دانشگاه " + PERSIAN + ".")
    add("glue-devanagari-zwj", "context", "Devanagari ZWJ", DEVANAGARI)
    add("glue-scotland-flag", "context", "complete black-flag tag sequence", SCOT)
    add("glue-scotland-in-prose", "context", "Scotland flag inside a sentence",
        "the " + SCOT + " flag")
    add("glue-free-tag-chars", "context", "ASCII smuggling via free tag chars",
        "A\U000e0048\U000e0069B")
    add("glue-incomplete-flag", "context", "black flag + tag with no cancel tag",
        "\U0001f3f4\U000e0067A")
    add("glue-khmer-after-base", "context", "Khmer inherent vowel after a Khmer letter", "ក឴")
    add("glue-khmer-after-latin", "context", "Khmer inherent vowel after Latin", "A឴B")
    add("glue-hangul-filler-after-jamo", "context", "Hangul filler after a jamo", "ᄀᅠ")
    add("glue-hangul-filler-after-latin", "context", "Hangul filler after Latin", "AᅠB")
    add("glue-hangul-filler-u3164", "context", "U+3164 hangul filler (always strip)", "AㅤB")
    add("glue-mongolian-fvs-after-base", "context", "Mongolian FVS after a Mongolian letter",
        "ᠠ᠋")
    add("glue-egyptian-cf-after-hieroglyph", "context",
        "Egyptian vertical joiner between hieroglyphs", "\U00013000\U00013430\U00013001")
    add("glue-egyptian-cf-after-latin", "context", "Egyptian vertical joiner in Latin prose",
        "A\U00013430B")
    add("glue-duployan-cf-after-letter", "context",
        "Duployan letter joiner between Duployan letters", "\U0001bc02\U0001bca0\U0001bc03")
    add("glue-duployan-cf-after-latin", "context", "Duployan letter joiner in Latin prose",
        "A\U0001bca0B")
    add("glue-mongolian-fvs-after-latin", "context", "Mongolian FVS after Latin", "A᠋B")
    add("glue-vs-after-cjk", "context", "variation selector after a CJK ideograph",
        "辻\U000e0100")
    add("glue-vs-supplement-after-latin", "context", "VS supplement carrier after Latin",
        "A\U000e0100\U000e0101B")
    add("glue-zwj-between-latin", "context", "ZWJ free-floating between Latin", "A‍B")
    add("glue-zwnj-between-latin", "context", "ZWNJ free-floating between Latin", "A‌B")

    # -- bidi
    add("bidi-lrm-after-hebrew", "bidi", "LRM next to RTL (kept unless --bidi)",
        HEBREW + "‎ (hi)")
    add("bidi-rlm-before-arabic", "bidi", "RLM before Arabic", "x ‏م")
    add("bidi-isolate-around-arabic", "bidi", "isolate wrapping Arabic", "⁧م⁩")
    add("bidi-rlo-next-to-rtl", "bidi", "RLO is stripped even next to RTL", "‮م")
    add("bidi-alm-in-latin", "bidi", "ALM in Latin text", "A؜B")
    add("bidi-mixed-sentence", "bidi", "mixed Hebrew/Latin with marks and isolates",
        "He said ⁦" + HEBREW + "⁩‎ and left.")

    # -- catch-alls
    add("catchall-cgj", "catchall", "combining grapheme joiner", "A͏B")
    add("catchall-fffb", "catchall", "interlinear annotation terminator", "A￻B")
    # The Cf catch-all: category-Cf codepoints in none of the tables. In Unicode 16
    # there are 22 of them, all reached only through unicodedata.category().
    add("catchall-cf-arabic-pound", "catchall", "Cf catch-all: U+0890 arabic pound mark",
        "A࢐B")
    add("catchall-cf-egyptian", "catchall", "Cf catch-all: Egyptian hieroglyph joiners",
        "\U00013000\U00013430\U00013001")
    add("catchall-cf-shorthand", "catchall", "Cf catch-all: shorthand format controls",
        "A\U0001bca0B\U0001bca3C")
    add("catchall-orthographic-arabic", "catchall", "Arabic number sign is orthography",
        "؀١")
    add("catchall-orthographic-kaithi", "catchall", "Kaithi number sign is orthography",
        "\U000110bd\U00011066")
    add("catchall-pua-bmp", "catchall", "BMP private use", "AB")
    add("catchall-pua-f8ff", "catchall", "Apple logo PUA", "AB")
    add("catchall-pua-plane15", "catchall", "supplementary private use", "A\U000f0000B")
    add("catchall-noncharacter", "catchall", "noncharacters U+FDD0 and U+FFFE",
        "A﷐B￾C")
    add("catchall-reserved-ignorable", "catchall",
        "reserved default-ignorables U+2065, U+FFF0, U+E0080, U+E01F0",
        "A\u2065B\ufff0C\U000e0080D\U000e01f0E")
    add("catchall-deprecated-format", "catchall", "deprecated format controls U+206A..U+206F",
        "A⁪B⁯C")
    add("catchall-musical-format", "catchall", "musical symbol format controls",
        "A\U0001d173B\U0001d17aC")
    add("catchall-braille-blank", "catchall", "braille pattern blank", "A⠀B")
    add("catchall-bel", "catchall", "BEL control", "A\x07B")
    add("catchall-controls-keep-tab", "catchall", "--controls keeps tab and LF", "a\tb\nc")
    add("catchall-nel", "catchall", "NEL: -n wins over --controls", "A\x85B")
    add("catchall-c1-controls", "catchall", "C1 controls", "A\x80B\x9fC")
    add("catchall-null-and-esc", "catchall", "NUL and ESC", "A\x00B\x1bC")

    # -- spaces / newlines
    add("space-nbsp", "space", "NBSP between words", "A B")
    add("space-exotic-run", "space", "several exotic spaces in one line",
        "a b c d　e")
    add("space-ogham", "space", "ogham space mark", "a b")
    add("newline-crlf", "newline", "CRLF preserved unless -n", "a\r\nb")
    add("newline-crlf-trailing", "newline", "CRLF with trailing spaces (SNOW carrier)",
        "alpha  \r\nbeta\t\r\n")
    add("newline-cr-only", "newline", "lone CR", "a\rb")
    add("newline-mixed", "newline", "LF, CRLF, NEL, LS and PS in one text",
        "one\ntwo\r\nthree\x85four five six")
    add("empty", "edge", "the empty string", "")
    add("edge-only-newlines", "edge", "newlines only", "\n\n\n")
    add("edge-single-hidden", "edge", "a single hidden character", "​")
    add("edge-lone-tab", "edge", "leading indentation must survive --collapse",
        "\tindented   words   here\n    four spaces\n")
    add("edge-astral-columns", "edge",
        "col is counted in codepoints, not UTF-16 units: astral chars before a hit",
        "\U0001f600​A\n\U0001f600\U0001f600​B")
    add("edge-hidden-at-both-ends", "edge", "hit at index 0 and at the last index",
        "​middle⁠")

    # -- punct
    add("punct-em-dash-unspaced", "punct", "unspaced em dash", "a—b")
    add("punct-em-dash-spaced", "punct", "spaced em dash", "a — b")
    add("punct-em-dash-leading", "punct", "dialogue dash at line start", "—Hello")
    add("punct-en-dash-range", "punct", "en dash range", "1990–1995")
    add("punct-curly-double", "punct", "curly double quotes", "“x”")
    add("punct-curly-single", "punct", "curly single quotes and apostrophe", "don’t ‘x’")
    add("punct-ellipsis", "punct", "ellipsis", "wait…")
    add("punct-minus-and-nb-hyphen", "punct", "unicode minus and non-breaking hyphen", "−5 ‑")
    add("punct-multiline", "punct", "dashes across lines", "a—b\nc — d")
    add("punct-primes-and-fraction", "punct", "primes and fraction slash", "5′ 6″ 1⁄2")

    # -- gutters: terminal quote bars (--gutters)
    add("gutter-terminal-email", "gutter", "an email copied out of a terminal's block quote",
        "\u258e Dear Mr Kirch, dear Karolis, dear Tobias,\n\u258e\n"
        "\u258e We apologise for the delay.\n")
    add("gutter-crlf", "gutter", "CRLF line endings stay with their lines",
        "\u258e one\r\n\u258e two\r\n")
    add("gutter-indented", "gutter", "indentation before the bar is kept",
        "  \u258e two spaces\n\t\u258e a tab\n")
    add("gutter-box-table", "gutter", "a box-drawn table row is not a gutter",
        "\u2502 a \u2502 b \u2502\n\u2503 c \u2503 d \u2503\n")
    add("gutter-lone-bar", "gutter", "a line that is only a bar becomes empty", "\u258f")
    add("gutter-light-heavy", "gutter", "light and heavy vertical box drawings as gutters",
        "\u2502 light\n\u2503 heavy\n\u258c half\n\u258d three eighths\n")
    add("gutter-no-space", "gutter", "a bar with no space after it", "\u258ex\n\u2502y")
    add("gutter-two-spaces", "gutter", "only one of two spaces after the bar goes",
        "\u258e  two\n")
    add("gutter-mid-line", "gutter", "a bar in the middle of a line is untouched",
        "mid \u258e bar \u2502 here\n")
    add("gutter-bare-bar-trailing", "gutter",
        "a bare bar followed by spaces: --trailing cleans up after --gutters",
        "\u258e quote\n\u258e   \n\u258e end  \n")
    add("gutter-nested", "gutter",
        "one bar per line: a nested same-glyph quote is a repeat, a mixed one loses its outer bar",
        "\u258e \u258e nested\n\u2502 \u258e mixed\n")
    add("gutter-lone-cr", "gutter", "a lone CR does not end a line unless -n folds it first",
        "\u258e a\r\u258e b")
    add("gutter-with-dash-and-invisibles", "gutter",
        "gutters run before the dash rule and the classifier",
        "\u258e\u2014quoted\u200b dash\n\u2502 x \u2014 y\n")

    # -- nfc / nfkc / confusables
    add("norm-math-bold", "norm", "mathematical bold letters",
        "".join(chr(0x1D41A + ord(c) - 97) for c in "hello"))
    add("norm-fullwidth", "norm", "fullwidth Latin", "Ｈｉ")
    add("norm-ligature", "norm", "ﬁ ligature", "ﬁle")
    add("norm-decomposed", "norm", "decomposed accents (NFD)",
        unicodedata.normalize("NFD", "café naïve résumé"))
    add("norm-composed", "norm", "composed accents (NFC)",
        unicodedata.normalize("NFC", "café naïve résumé"))
    add("norm-vulgar-fraction", "norm", "vulgar fraction (NFKC yields U+2044)", "½ cup")
    add("confusable-cyrillic-a", "confusable", "Cyrillic а in a Latin word", "аpple")
    add("confusable-greek-omicron", "confusable", "Greek omicron in a Latin word", "fοo")
    add("confusable-real-russian", "confusable", "pure Russian word: NOT a look-alike (mixed-script rule)", "сор")
    add("confusable-mixed-brand", "confusable", "Cyrillic с inside a Latin brand in Russian prose",
        "письмо якобы от Miсrosoft пришло вчера")
    add("confusable-mixed-german", "confusable", "Cyrillic о inside a German word", "Prüf dein Kоnto")
    add("confusable-mixed-digits", "confusable", "Cyrillic О inside digits", "Rabatt 1О0 %")
    add("confusable-zwsp-inside", "confusable", "ZWSP wedged into аpple cannot hide the look-alike", "а\u200bpple")
    add("confusable-punct-boundary", "confusable", "punctuation is a word boundary", "сор, ok — Kоnto!")
    add("confusable-greek-prose", "confusable", "pure Greek prose: no findings", "Καλημέρα κόσμε, τι κάνεις;")

    # -- languages
    add("lang-persian", "language", "Persian sentence with ZWNJ",
        "کتاب‌ها را روی میز گذاشتم و به آرامی در را بستم.")
    add("lang-hebrew", "language", "Hebrew sentence with an LRM and a Latin insert",
        "הספר החדש של מיכל יצא לאור בשנה שעברה‎ (2025).")
    add("lang-hindi", "language", "Hindi sentence with a ZWJ conjunct",
        "मैंने कल शाम को क्‍ष विषय पर एक लेख पढ़ा।")
    add("lang-japanese", "language", "Japanese sentence with an ideographic space and VS",
        "昨日は雨でした。　辻\U000e0100さんに会いました。")
    add("lang-russian", "language", "Russian sentence (must yield no look-alike findings)",
        "Сегодня в Москве шёл снег, и город стал очень тихим.")
    add("lang-arabic-orthographic", "language", "Arabic with an orthographic format control",
        "؀١٢٣ صفحة من الكتاب.")

    # -- prose
    add("prose-3kb", "prose", "≈3 KB of realistic English with typographic punctuation",
        PARAGRAPH_3KB)
    add("prose-realistic-mixed", "prose", "the mixed paragraph from test_strip_invisible.py",
        "The​ results—which we’ll discuss… — were “clear”. "
        + FAMILY + " ❤️ " + PERSIAN + " " + SCOT + "‎\n"
        "Se­cond line \U000e0048\U000e0069 hidden.")

    # -- the eleven published stego schemes
    for name, _flags, encode, _decode in STEGO.SCHEMES:
        slug = "".join(c if c.isalnum() else "-" for c in name.lower())
        while "--" in slug:
            slug = slug.replace("--", "-")
        add(f"stego-{slug.strip('-')}", "stego", f"{name} carrying {STEGO.SECRET!r}",
            encode(STEGO.COVER, STEGO.SECRET))
    add("stego-cover-plain", "stego", "the stego cover text with no payload", STEGO.COVER)

    fixtures = []
    for fid, group, note, text in out:
        fixtures.append({
            "id": fid,
            "group": group,
            "note": note,
            "text": text,
            "findings": [list(hit) for hit in si.find(text)],
            "cleaned": {cid: si.clean(text, options(*fields)) for cid, fields in COMBOS},
        })
    ids = [f["id"] for f in fixtures]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate fixture ids")
    return fixtures


# ------------------------------------------------------------------ style ----

BULLETS_MD = """# Remote onboarding checklist

Getting a new engineer productive in the first week is mostly logistics. Here is what we do.

- **Day one:** laptop, SSO, and a buddy who answers anything for two weeks.
- **Day two:** ship a one-line change to production. It works or the pipeline is broken.
- **Day three:** read the incident log for the last quarter, not the architecture doc.
- **Day four:** pair on a real ticket with the person who wrote the service.
- **Day five:** write down every question you had to ask someone. That is next week's docs.
- **Week two:** own a small service end to end, including the pager.

Additionally, the buddy should block ninety minutes a day. Furthermore, the manager
should not be the buddy. Moreover, none of this survives contact with a reorg, so
revisit it quarterly.
"""

HEADINGS_DOC = """## What changed in the billing migration

We moved 41,000 subscriptions from the old ledger to the new one over a weekend in
February. Three things went wrong and one of them mattered.

## The part that mattered

Proration on annual plans was computed against the wrong anchor date for accounts that
had upgraded mid-cycle. That is 312 accounts. We refunded $18,400 and sent a plain
email that said what happened, with no apology template.

## The parts that did not

The dashboard was stale for four hours because a materialized view was not in the
migration script. Nobody noticed until we told them. And the CSV export kept the old
column order, which one customer had scripted against; we shipped a fix on Monday.

## What we would do differently

Run the proration test suite against a snapshot of real accounts, not a fixture. The
bug was visible in production data and invisible in the fixture, which had no
mid-cycle upgrades in it at all.
"""

VERY_SHORT = "Ship it. Then fix it."

LONG_HUMAN_ESSAY = """The first winter I kept bees, I lost both hives, and I still think it was
the mouse guard that did it rather than the cold.

I had read the standard advice: a strip of metal with holes small enough to keep mice out and
big enough to let bees pass. I made mine out of a piece of gutter guard, which is the kind of
substitution that sounds thrifty in October and looks stupid in March. The holes were the right
size. The metal was not stiff enough, and when the snow load pushed the entrance reducer, the
guard bowed inward and closed about a third of the opening. Bees ventilate by fanning. Restrict
the entrance in a wet winter and the cluster sits in its own condensation.

When I opened the boxes in early March there was no smell of fermentation, no robbing, no sign
of nosema on the frames. There were maybe four hundred dead bees on the floor and a cluster the
size of a grapefruit, dead in place, head-first in the cells the way starved bees are supposed
to be. Except there were eleven full frames of capped honey two inches above them. They had not
starved. They had been too cold and too wet to move, which is a distinction that only matters if
you want to know what to do differently.

My neighbour Ivars, who has kept bees since 1988 and does not read books about it, looked at the
gutter guard for about four seconds and said the word he uses for everything he disapproves of,
which is not printable and means roughly "townie". Then he cut me two proper guards out of
galvanised sheet with a pair of tin snips, and refused money, and told me the only real rule is
that you check the entrance after every thaw because that is when the dead bees pile up and plug
it from the inside.

That is the part nobody writes down. The books tell you what to install. They do not tell you
that the failure mode is a heap of your own dead bees blocking the door in February, and that
the fix is a stick and thirty seconds.

I have had bees for six years now. I have lost hives to varroa, to a queen that failed in August,
and once to a bear, which is a different essay. I have not lost one to ventilation again. The
gutter guard is still in the shed. I keep it there on purpose.
"""

# Two paragraphs written to reach the observation branches the others miss:
# "fairly uniform sentence length", "uniform paragraph shape", "noticeable LLM
# vocabulary", "heavy hedging", "no first person" (A) and "em-dash habit",
# "tricolon habit" (B). Every branch of style_report.analyze fires in some fixture.
HEDGED_UNIFORM = """Municipal composting can reduce landfill volume by a measurable amount, and the reduction shows up in tipping fees within about two quarters of the launch date. The size of that reduction may vary.

Collection routes are typically built on top of existing waste pickup schedules. That generally keeps the marginal cost of a new organics stream low enough to absorb.

Participation often depends on the design of the kitchen container. Several municipalities report that weekly pickup potentially doubles participation compared with a fortnightly service.

Contamination is arguably harder. Plastic bags, produce stickers and coffee lids can survive screening, and education campaigns may or may not change behaviour at the curb where it matters most.

Finished compost can be sold, donated, or applied to public parks. The revenue is generally modest and in many cases might cover only the cost of screening and bagging.

Operators should weigh siting against odour control before expanding. A robust review every few years typically catches the problems that residents would otherwise report themselves."""

EM_DASH_TRICOLON = """The rebuild took four months — longer than anyone wanted — and the schedule slipped twice.

The first slip was our fault. We had promised a migration path for the old plugin API — every plugin, every version, no exceptions — and three plugins turned out to use an undocumented hook we had deleted in week two. Rewriting them took eleven days.

The second slip was not our fault, exactly. A vendor changed an authentication endpoint with two weeks' notice — a Friday email, no guide, no sandbox — and we spent a sprint on work no user could see.

What shipped is faster, smaller, and simpler. Startup dropped from 4.1 seconds to 900 milliseconds, the settings screen lost half its options, and the installer is now a single file. Nobody has asked for them back.

The lesson, if there is one: budget for vendors, plugins, and surprises. Ours cost six weeks — call it forty per cent — and it was still cheaper, quieter, or less embarrassing than the alternative."""

STYLE_EDGE = (
    ("style-edge-empty", "empty string", ""),
    ("style-edge-one-word", "one word", "Hello"),
    ("style-edge-one-sentence", "one sentence", "Just one sentence here."),
    ("style-edge-no-punctuation", "no sentence-final punctuation",
     "words and more words without any stop at all"),
    ("style-edge-only-bullets", "bullets only", "- a\n- b\n- c\n"),
    ("style-edge-unicode", "non-Latin scripts", "Привет мир. Ça va? 東京。"),
    ("style-edge-below-thresholds", "too short for any observation",
     "Short. Also short. Very short."),
    # PROPER_RE ends in `\b`, which is Unicode-aware in Python and ASCII-only in
    # JavaScript. Without a rebuilt boundary the port matches the ASCII prefix of
    # every accented or non-Latin capitalised word ("Ren" of "Renée") where the
    # reference matches nothing, inflating proper_nouns_per_1000 and suppressing
    # the "no specifics" observation this fixture's length is chosen to trigger.
    ("style-edge-accented-names", "accented and non-Latin proper nouns",
     "we met Renée in the office and we talked about the plan for the year ahead. " * 22
     + "then Дмитрий and Αθήνα and José joined us."),
    # `low[-400:]` is 400 CODEPOINTS in Python and 400 UTF-16 CODE UNITS in
    # JavaScript. 250 astral characters are 500 units, so a naive port's window
    # never reaches the sign-off phrase.
    ("style-edge-astral-tail", "sign-off followed by astral characters",
     "In summary, done." + "\U0001F600" * 250),
)


def style_fixtures() -> list[dict]:
    cases = [
        ("style-machine", "machine", "MACHINE from tests/test_style_report.py", STYLEFX["MACHINE"]),
        ("style-human", "human", "HUMAN from tests/test_style_report.py", STYLEFX["HUMAN"]),
        ("style-bullets-markdown", "extra", "bullet-heavy markdown with bold leads", BULLETS_MD),
        ("style-headings", "extra", "markdown headings, human voice", HEADINGS_DOC),
        ("style-very-short", "extra", "two words, below every threshold", VERY_SHORT),
        ("style-long-essay", "extra", "long human essay", LONG_HUMAN_ESSAY),
        ("style-hedged-uniform", "branches",
         "hedged, uniformly shaped, no first person", HEDGED_UNIFORM),
        ("style-em-dash-tricolon", "branches", "em-dash and tricolon habits",
         EM_DASH_TRICOLON),
    ]
    cases += [(fid, "edge", note, text) for fid, note, text in STYLE_EDGE]
    return [{"id": fid, "group": group, "note": note, "text": text, "report": sr.analyze(text)}
            for fid, group, note, text in cases]


# ------------------------------------------------------------- packages ------

def normalize_zip(raw: bytes) -> tuple[bytes, list[dict]]:
    """Re-serialize a zip deterministically; report each entry's real method.

    Deflate output is not stable across zlib builds, so the bytes recorded in the
    fixture are STORED. `entries[].compress` keeps what Python actually chose, so
    a TS writer can still be checked on picking the same method.
    """
    entries: list[dict] = []
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as zin, zipfile.ZipFile(buf, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            entries.append({
                "name": item.filename,
                "compress": "stored" if item.compress_type == zipfile.ZIP_STORED else "deflate",
                "size": len(data),
                "crc32": item.CRC,
            })
            info = zipfile.ZipInfo(item.filename, FIXED_DATE)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = item.external_attr
            zout.writestr(info, data)
    return buf.getvalue(), entries


def zip_parts(raw: bytes) -> dict[str, str]:
    parts: dict[str, str] = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for name in z.namelist():
            parts[name] = z.read(name).decode("utf-8")
    return parts


def package_fixture(fid: str, kind: str, note: str, raw: bytes) -> dict:
    is_docx = kind == "docx"
    normalized, entries = normalize_zip(raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        report = cf.inspect_docx(z) if is_docx else cf.inspect_odt(z)
        names = z.namelist()
        # The parts clean_file reads text out of, concatenated in this order and with
        # no separator: line/col in `findings` are positions in that concatenation.
        text_parts = ([n for n in names if cf.DOCX_TEXT_PARTS.match(n)] if is_docx
                      else ["content.xml"] if "content.xml" in names else [])
        node_re = cf.W_T_RE if is_docx else cf.ODT_NODE_RE
        text = "".join(cf.find_xml_text(z.read(p).decode("utf-8", "replace"), node_re)
                       for p in text_parts)

    cleaned: dict[str, dict] = {}
    for label, fields in DOC_FLAG_SETS:
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as zin:
            changed = (cf.clean_docx if is_docx else cf.clean_odt)(zin, out, options(*fields))
        out_bytes = out.getvalue()
        out_normalized, out_entries = normalize_zip(out_bytes)
        cleaned[label] = {
            "changedNodes": changed,
            "entries": out_entries,
            "parts": zip_parts(out_normalized),
            "bytesB64": base64.b64encode(out_normalized).decode("ascii"),
        }

    return {
        "id": fid,
        "kind": kind,
        "note": note,
        "textParts": text_parts,
        "text": text,
        "findings": [list(hit) for hit in si.find(text)],
        "inspect": report,
        "entries": entries,
        "parts": zip_parts(normalized),
        "bytesB64": base64.b64encode(normalized).decode("ascii"),
        "cleaned": cleaned,
    }


HTML_FIXTURE = (
    '<!doctype html><html><head><meta name="generator" content="Docs Exporter">'
    "<style>p{color:red}</style></head>"
    '<body><!-- hidden note --><p>He{ZWSP}llo &amp; &zwj; {FAMILY} <b>bo{ZWSP}ld</b> '
    "&lt;i&gt;</p>"
    '<span style="display:none">invisible</span><img alt="al{ZWSP}t">'
    '<script>var x="{ZWSP}"</script></body></html>'
).replace("{ZWSP}", DOCFX["ZWSP"]).replace("{FAMILY}", DOCFX["FAMILY"])


def html_fixture() -> dict:
    text = cf.html_text(HTML_FIXTURE)
    return {
        "id": "html-page",
        "kind": "html",
        "note": "the HTML fixture from tests/test_clean_file.py",
        "source": HTML_FIXTURE,
        "text": text,
        "findings": [list(hit) for hit in si.find(text)],
        "inspect": cf.inspect_html(HTML_FIXTURE),
        "cleaned": {label: cf.clean_html(HTML_FIXTURE, options(*fields))
                    for label, fields in DOC_FLAG_SETS},
    }


def docx_space_variant(raw: bytes) -> bytes:
    """Put whitespace at the edge of two <w:t> nodes.

    Word drops edge whitespace unless the run carries xml:space="preserve", so
    clean_xml_text_nodes adds it whenever cleaning a node leaves whitespace at an
    edge. This variant covers both branches: a node without the attribute (it must
    be added) and one that already has it (it must not be duplicated).
    """
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as zin, zipfile.ZipFile(out, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                xml = data.decode("utf-8")
                xml = xml.replace("<w:t>He", "<w:t> He", 1)
                xml = xml.replace(DOCFX["CYR_A"] + "pple</w:t>",
                                  DOCFX["CYR_A"] + "pple\u00a0</w:t>", 1)  # NBSP at the node edge
                data = xml.encode("utf-8")
            zout.writestr(item, data)
    return out.getvalue()


def doc_fixtures() -> list[dict]:
    docx = io.BytesIO()
    DOCFX["make_docx"](docx)
    odt = io.BytesIO()
    DOCFX["make_odt"](odt)
    return [
        package_fixture("docx-essay", "docx",
                        "the DOCX fixture from tests/test_clean_file.py", docx.getvalue()),
        package_fixture("docx-space-preserve", "docx",
                        "same DOCX with edge whitespace: xml:space=\"preserve\" handling",
                        docx_space_variant(docx.getvalue())),
        package_fixture("odt-doc", "odt",
                        "the ODT fixture from tests/test_clean_file.py", odt.getvalue()),
        html_fixture(),
    ]


# ---------------------------------------------------------- unicode names ----

# C0/C1 controls and U+0085 have no Unicode Name property; these are their
# standard NameAliases.txt control aliases. Every one is verified against
# unicodedata.lookup() at generation time (BELL is the one alias Unicode shares
# with another character, U+1F514, so it is exempted from that check).
CONTROL_ALIASES: dict[int, str] = {
    0x00: "NULL", 0x01: "START OF HEADING", 0x02: "START OF TEXT", 0x03: "END OF TEXT",
    0x04: "END OF TRANSMISSION", 0x05: "ENQUIRY", 0x06: "ACKNOWLEDGE", 0x07: "BELL",
    0x08: "BACKSPACE", 0x09: "CHARACTER TABULATION", 0x0A: "LINE FEED",
    0x0B: "LINE TABULATION", 0x0C: "FORM FEED", 0x0D: "CARRIAGE RETURN", 0x0E: "SHIFT OUT",
    0x0F: "SHIFT IN", 0x10: "DATA LINK ESCAPE", 0x11: "DEVICE CONTROL ONE",
    0x12: "DEVICE CONTROL TWO", 0x13: "DEVICE CONTROL THREE", 0x14: "DEVICE CONTROL FOUR",
    0x15: "NEGATIVE ACKNOWLEDGE", 0x16: "SYNCHRONOUS IDLE", 0x17: "END OF TRANSMISSION BLOCK",
    0x18: "CANCEL", 0x19: "END OF MEDIUM", 0x1A: "SUBSTITUTE", 0x1B: "ESCAPE",
    0x1C: "INFORMATION SEPARATOR FOUR", 0x1D: "INFORMATION SEPARATOR THREE",
    0x1E: "INFORMATION SEPARATOR TWO", 0x1F: "INFORMATION SEPARATOR ONE", 0x7F: "DELETE",
    0x80: "PADDING CHARACTER", 0x81: "HIGH OCTET PRESET", 0x82: "BREAK PERMITTED HERE",
    0x83: "NO BREAK HERE", 0x84: "INDEX", 0x85: "NEXT LINE", 0x86: "START OF SELECTED AREA",
    0x87: "END OF SELECTED AREA", 0x88: "CHARACTER TABULATION SET",
    0x89: "CHARACTER TABULATION WITH JUSTIFICATION", 0x8A: "LINE TABULATION SET",
    0x8B: "PARTIAL LINE FORWARD", 0x8C: "PARTIAL LINE BACKWARD", 0x8D: "REVERSE LINE FEED",
    0x8E: "SINGLE SHIFT TWO", 0x8F: "SINGLE SHIFT THREE", 0x90: "DEVICE CONTROL STRING",
    0x91: "PRIVATE USE ONE", 0x92: "PRIVATE USE TWO", 0x93: "SET TRANSMIT STATE",
    0x94: "CANCEL CHARACTER", 0x95: "MESSAGE WAITING", 0x96: "START OF GUARDED AREA",
    0x97: "END OF GUARDED AREA", 0x98: "START OF STRING",
    0x99: "SINGLE GRAPHIC CHARACTER INTRODUCER", 0x9A: "SINGLE CHARACTER INTRODUCER",
    0x9B: "CONTROL SEQUENCE INTRODUCER", 0x9C: "STRING TERMINATOR",
    0x9D: "OPERATING SYSTEM COMMAND", 0x9E: "PRIVACY MESSAGE",
    0x9F: "APPLICATION PROGRAM COMMAND",
}
ALIAS_LOOKUP_EXEMPT = {0x07}  # "BELL" is also the alias of U+1F514

# Emitted as a rule in nameOf() instead of 256 table rows: VS1..VS16 and VS17..VS256.
VS_RANGES = ((0xFE00, 0xFE0F, 1), (0xE0100, 0xE01EF, 17))


def verify_aliases() -> None:
    for cp, alias in sorted(CONTROL_ALIASES.items()):
        if cp in ALIAS_LOOKUP_EXEMPT:
            continue
        try:
            found = ord(unicodedata.lookup(alias))
        except KeyError:
            raise SystemExit(f"alias {alias!r} for U+{cp:04X} is not a Unicode alias")
        if found != cp:
            raise SystemExit(f"alias {alias!r} resolves to U+{found:04X}, not U+{cp:04X}")


def verify_vs_rule() -> None:
    for lo, hi, base in VS_RANGES:
        for cp in range(lo, hi + 1):
            want = f"VARIATION SELECTOR-{cp - lo + base}"
            if unicodedata.name(chr(cp), "") != want:
                raise SystemExit(f"VS rule wrong for U+{cp:04X}")


# Never classified, but the pre-passes (-n, --trailing, --collapse) act on them and
# the UI labels them, so they get a name too.
WHITESPACE_EXTRAS = (0x09, 0x0A, 0x0D, 0x20)


def classified_codepoints(text_fx: list[dict], style_fx: list[dict],
                          doc_fx: list[dict]) -> set[int]:
    cps: set[int] = set(WHITESPACE_EXTRAS)
    for table in (si.ALWAYS_STRIP, si.BIDI_ALWAYS, si.BIDI_MARKS, si.GLUE, si.SPACES,
                  si.CONTROLS, si.LINE_BREAKS, set(si.PUNCT), si.ORTHOGRAPHIC_CF, si.GUTTERS):
        cps |= set(table)
    corpus = [f["text"] for f in text_fx] + [f["text"] for f in style_fx]
    for f in doc_fx:
        corpus.append(f["text"])
        corpus.append(f.get("source", ""))
        for part in f.get("parts", {}).values():
            corpus.append(part)
    for text in corpus:
        for ch in text:
            if unicodedata.category(ch) in ("Cf", "Co"):
                cps.add(ord(ch))
    for f in text_fx + doc_fx:
        for finding in f["findings"]:
            cps.add(finding[2])
    return cps


def name_of(cp: int) -> str | None:
    name = unicodedata.name(chr(cp), "")
    if name:
        return name
    return CONTROL_ALIASES.get(cp)


def render_names_ts(cps: set[int]) -> str:
    covered_by_rule = {cp for lo, hi, _ in VS_RANGES for cp in range(lo, hi + 1)}
    rows: list[tuple[int, str]] = []
    unnamed = 0
    for cp in sorted(cps):
        if cp in covered_by_rule:
            continue
        name = name_of(cp)
        if name is None:
            unnamed += 1
            continue
        rows.append((cp, name))

    lines = [
        "// Generated by tools/gen_golden.py from Python's unicodedata "
        f"(Unicode {unicodedata.unidata_version}). Do not edit.",
        "//",
        "// Derived from the Unicode Character Database. Copyright (c) 1991-2024 Unicode, Inc.",
        "// All rights reserved. Distributed under the Unicode License v3:",
        "// https://www.unicode.org/license.txt",
        "// (Emitted by the generator, not kept in a standalone NOTICE, so the notice cannot",
        "// come detached from the data on the next regeneration.)",
        "//",
        "// One entry for every codepoint the engine can classify: the tables in",
        "// strip_invisible.py (ALWAYS_STRIP, BIDI_*, GLUE, SPACES, CONTROLS, LINE_BREAKS,",
        "// PUNCT, ORTHOGRAPHIC_CF, GUTTERS) plus every Cf/Co codepoint and every finding codepoint",
        "// that appears in the golden fixtures. Codepoints outside this set — most of the",
        "// confusables table, unassigned noncharacters — fall back to \"U+XXXX\".",
        "//",
        "// C0/C1 controls have no Unicode Name property; they carry their standard",
        "// NameAliases.txt control alias, verified against unicodedata.lookup() when this",
        "// file was generated. The variation selectors are a rule in nameOf(), not rows.",
        "",
        "const NAME_ENTRIES: readonly (readonly [number, string])[] = [",
    ]
    for cp, name in rows:
        lines.append(f"  [0x{cp:04X}, {json.dumps(name)}],")
    lines += [
        "];",
        "",
        "/** Unicode name by codepoint for everything the engine classifies. */",
        "export const UNICODE_NAMES: ReadonlyMap<number, string> = new Map(NAME_ENTRIES);",
        "",
        "const VARIATION_SELECTOR_RANGES: readonly (readonly [number, number, number])[] = [",
    ]
    for lo, hi, base in VS_RANGES:
        lines.append(f"  [0x{lo:04X}, 0x{hi:04X}, {base}],")
    lines += [
        "];",
        "",
        "/** `U+XXXX` in the form the CLI prints: uppercase hex, at least four digits. */",
        "export function formatCodepoint(cp: number): string {",
        '  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;',
        "}",
        "",
        "/** The Unicode name of a codepoint, or `U+XXXX` when it has none. */",
        "export function nameOf(cp: number): string {",
        "  const known = UNICODE_NAMES.get(cp);",
        "  if (known !== undefined) return known;",
        "  for (const [lo, hi, base] of VARIATION_SELECTOR_RANGES) {",
        "    if (cp >= lo && cp <= hi) return `VARIATION SELECTOR-${cp - lo + base}`;",
        "  }",
        "  return formatCodepoint(cp);",
        "}",
        "",
    ]
    sys.stderr.write(f"unicode-names: {len(rows)} rows, {len(covered_by_rule)} by rule, "
                     f"{unnamed} codepoints left to the U+XXXX fallback\n")
    return "\n".join(lines)


# ----------------------------------------------------------------- decode ----

def decode_fixtures(text_fx: list[dict]) -> dict:
    """`decode_payloads.decode()` over every text fixture and every decode case.

    The cases are tests/test_decode_payloads.py's LEGIT and CASES lists. A case
    whose text starts with U+FEFF stays in the per-language unit tests instead:
    some JSON parsers drop a leading BOM from a string value, so a port that
    reads the fixture could see a different text.
    """
    cases = [(fid, note, text) for fid, note, text in DECODEFX.LEGIT]
    cases += [(fid, note, text) for fid, note, text, _ in DECODEFX.CASES]
    return {
        "cases": [{"id": fid, "note": note, "text": text, "payloads": dp.decode(text)}
                  for fid, note, text in cases if not text.startswith("\ufeff")],
        "text": {f["id"]: dp.decode(f["text"]) for f in text_fx},
    }


# ----------------------------------------------------------------- canary ----

def canary_fixtures() -> dict:
    """`canary` over tests/test_canary.py's EMBED_CASES, DETECT_CASES and ID_CASES."""
    return {
        "embed": [{"id": fid, "note": note, "text": text, "markId": mark_id, "key": key,
                   "marked": canary.embed(text, mark_id, key)}
                  for fid, note, text, mark_id, key in CANARYFX.EMBED_CASES],
        "detect": [{"id": fid, "note": note, "text": text, "key": key,
                    "marks": canary.detect(text, key)}
                   for fid, note, text, key in CANARYFX.DETECT_CASES],
        "ids": [{"markId": mark_id, "error": canary.id_error(mark_id)}
                for mark_id in CANARYFX.ID_CASES],
    }


# ------------------------------------------------------------------ output ----

def build() -> tuple[str, str]:
    verify_aliases()
    verify_vs_rule()
    text_fx = text_fixtures()
    style_fx = style_fixtures()
    doc_fx = doc_fixtures()
    decode_fx = decode_fixtures(text_fx)
    canary_fx = canary_fixtures()
    golden = {
        "meta": {
            "generator": "tools/gen_golden.py",
            "unicodeVersion": unicodedata.unidata_version,
            "note": ("Generated. Every zip in this file is re-serialized with a fixed "
                     "1980-01-01 timestamp and ZIP_STORED entries so the fixture is "
                     "byte-identical on every machine; the compression method Python "
                     "actually used is recorded per entry under entries[].compress. "
                     "Findings are [line, col, cp, kind, flag] with 1-based line/col "
                     "counted in codepoints, not UTF-16 units."),
            "sources": ["strip_invisible.py", "style_report.py", "clean_file.py",
                        "decode_payloads.py", "canary.py",
                        "tests/test_strip_invisible.py", "tests/test_stego_roundtrip.py",
                        "tests/test_clean_file.py", "tests/test_style_report.py",
                        "tests/test_decode_payloads.py", "tests/test_canary.py"],
            "counts": {"text": len(text_fx), "style": len(style_fx), "documents": len(doc_fx),
                       "combos": len(COMBOS), "decode": len(decode_fx["cases"]),
                       "canary": len(canary_fx["embed"]) + len(canary_fx["detect"])},
        },
        "combos": [{"id": cid, "options": sorted(fields)} for cid, fields in COMBOS],
        "docFlagSets": [{"id": label, "options": sorted(fields)}
                        for label, fields in DOC_FLAG_SETS],
        "text": text_fx,
        "style": style_fx,
        "documents": doc_fx,
        "decode": decode_fx,
        "canary": canary_fx,
    }
    names_ts = render_names_ts(classified_codepoints(text_fx, style_fx, doc_fx))
    return json.dumps(golden, sort_keys=True, ensure_ascii=True, indent=1) + "\n", names_ts


def write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()
    except OSError:
        return None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--golden", default=GOLDEN_PATH, help="path of golden.json")
    p.add_argument("--names", default=NAMES_PATH, help="path of unicode-names.ts")
    p.add_argument("--check", action="store_true",
                   help="do not write; exit 1 if either output is stale")
    args = p.parse_args()

    golden, names = build()
    stale = []
    for path, content in ((args.golden, golden), (args.names, names)):
        if args.check:
            if read(path) != content:
                stale.append(path)
        else:
            write(path, content)
            print(f"{path}: {len(content.encode()):,} bytes", file=sys.stderr)
    if args.check:
        for path in stale:
            print(f"{path}: stale, re-run tools/gen_golden.py", file=sys.stderr)
        return 1 if stale else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
