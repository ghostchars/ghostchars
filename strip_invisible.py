#!/usr/bin/env python3
"""Strip zero-width and other invisible characters from text.

Reads stdin or files. Writes to stdout, or edits in place with -i.
Use --show to inspect what is present without changing anything.

Default is context-aware: invisible glue that is load-bearing (ZWJ inside an
emoji sequence, ZWNJ inside Persian, VS16 after an emoji, tag chars inside a
subdivision flag, bidi marks next to RTL text) is kept; the same characters
free-floating in Latin prose are stripped. -a disables that judgement.
"""
import argparse
import re
import sys
import unicodedata

# ---------------------------------------------------------------- tables ----

# Format controls that are contraband anywhere in prose.
ALWAYS_STRIP = {
    0x00AD,  # soft hyphen
    0x034F,  # combining grapheme joiner
    0x180E,  # mongolian vowel separator
    0x200B,  # zero width space
    0x2060,  # word joiner
    0x2061, 0x2062, 0x2063, 0x2064,  # invisible math operators
    0x2800,  # braille pattern blank
    0x3164, 0xFFA0,  # hangul filler / halfwidth hangul filler
    0xFEFF,  # zero width no-break space / BOM
    *range(0x206A, 0x2070),   # deprecated format controls
    *range(0xFFF9, 0xFFFC),   # interlinear annotation
    *range(0x1D173, 0x1D17B),  # musical symbol format controls
    # Noncharacters: permanently unassigned (Cn), so the Cf catch-all misses them.
    *range(0xFDD0, 0xFDF0),
    *(p * 0x10000 + o for p in range(0x11) for o in (0xFFFE, 0xFFFF)),
    # Reserved Default_Ignorable_Code_Points: unassigned (Cn) but renderers
    # already hide them, so they carry payload today. Same reason as above.
    0x2065,
    *range(0xFFF0, 0xFFF9),
    *range(0xE0080, 0xE0100),
    *range(0xE01F0, 0xE1000),
}

# Bidi controls. Overrides/embeddings can reorder unrelated text: always strip.
# Marks/isolates are legitimate next to RTL script: kept there unless --bidi.
BIDI_ALWAYS = {0x202A, 0x202B, 0x202C, 0x202D, 0x202E}
BIDI_MARKS = {0x061C, 0x200E, 0x200F, 0x2066, 0x2067, 0x2068, 0x2069}

# Glue: invisible but load-bearing when adjacent to the right base.
ZWNJ, ZWJ = 0x200C, 0x200D
VS_EMOJI = {0xFE0E, 0xFE0F}
VS_TEXT = set(range(0xFE00, 0xFE0E))
VS_SUPPLEMENT = set(range(0xE0100, 0xE01F0))
MONGOLIAN_FVS = {0x180B, 0x180C, 0x180D}
KHMER_VOWELS = {0x17B4, 0x17B5}
HANGUL_FILLERS = {0x115F, 0x1160}
# Script-specific format controls (Cf): quadrat layout in Egyptian hieroglyphs,
# affix/overlap controls in Duployan. Load-bearing after a letter of their own
# script, contraband anywhere else. Value: the block whose letters bind them.
SCRIPT_CF = {**{cp: (0x13000, 0x1342F) for cp in range(0x13430, 0x13440)},
             **{cp: (0x1BC00, 0x1BC9F) for cp in range(0x1BCA0, 0x1BCA4)}}
TAG_CHARS = set(range(0xE0000, 0xE0080))
TAG_END = 0xE007F
BLACK_FLAG = 0x1F3F4

# Format controls that are ordinary Arabic/Syriac/Kaithi orthography.
ORTHOGRAPHIC_CF = {0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605,
                   0x06DD, 0x070F, 0x08E2, 0x110BD, 0x110CD}

# Visible-ish spaces: collapse to U+0020 rather than delete.
SPACES = {0x00A0, 0x1680, 0x202F, 0x205F, 0x3000, *range(0x2000, 0x200B)}

# C0/C1 controls, excluding tab and the line breaks handled below.
CONTROLS = ({*range(0x00, 0x09), 0x0B, 0x0C, *range(0x0E, 0x20), 0x7F}
            | (set(range(0x80, 0xA0)) - {0x85}))

# Line breaks folded to LF. CR/CRLF are handled by a pre-pass.
LINE_BREAKS = {0x0085, 0x2028, 0x2029}

# Typographic punctuation that reads as machine-generated. Human keyboards
# produce the ASCII forms. Dashes are handled by a spacing-aware pre-pass.
PUNCT = {
    0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",  # single quotes
    0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"',  # double quotes
    0x02BC: "'", 0x2032: "'", 0x2033: '"',  # modifier apostrophe, primes
    0x2026: "...",  # ellipsis
    0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2014: "-",
    0x2015: "-", 0x2212: "-",  # hyphens, dashes, minus
    0x2044: "/",  # fraction slash (what NFKC turns ½ into)
}
DASH_RE = re.compile(r"(?<=\S)[ \t]*[–—―][ \t]*(?=\S)")
TRAILING_RE = re.compile(r"[ \t]+(?=\r?\n|\Z)")
COLLAPSE_RE = re.compile(r"(?<=\S)[ \t]{2,}(?=\S)")  # inside lines only; indentation kept

# Terminal quote bars (--gutters). A terminal draws a block quote with a bar in
# the left margin, and copying the quote copies the bar as text, so every line
# of the paste arrives as "\u258e Dear ...". The bar is one of GUTTERS; it is a
# gutter only when it opens its line (after spaces/tabs, which are kept) and the
# rest of that line holds no second copy of the SAME glyph. That clause is what
# leaves a box-drawn table row ("\u2502 a \u2502 b \u2502") alone. The bar goes with at
# most ONE following space. Lines are split on LF only; a CR stays with its line
# ending. One bar per line and no looping: a quote nested under a different bar
# keeps its inner one, and one nested under the same bar is left whole, because
# its second copy is exactly what a table rule looks like.
GUTTERS = {0x258C, 0x258D, 0x258E, 0x258F,  # left half, 3/8, 1/4, 1/8 blocks
           0x2502, 0x2503}  # box drawings light / heavy vertical
GUTTER_RE = re.compile(r"(?<![^\n])([ \t]*)([\u258c-\u258f\u2502\u2503]) ?(?![^\n]*\2)")

# Glyph-confusable lookalikes -> ASCII, generated from Unicode confusables.txt
# (see tools/gen_confusables.py). Applied only inside MIXED-SCRIPT words (see
# in_mixed_script_word), so pure Russian/Greek prose is never touched; still
# opt-in because it rewrites letters. Falls back to a small hand-picked map when
# the generated module is absent.
try:
    from confusables import CONFUSABLES
except ImportError:
    CONFUSABLES = {
        0x0410: "A", 0x0412: "B", 0x0415: "E", 0x041A: "K", 0x041C: "M",
        0x041D: "H", 0x041E: "O", 0x0420: "P", 0x0421: "C", 0x0422: "T",
        0x0425: "X", 0x0430: "a", 0x0435: "e", 0x043E: "o", 0x0440: "p",
        0x0441: "c", 0x0443: "y", 0x0445: "x", 0x0456: "i", 0x0455: "s",
        0x0458: "j", 0x04BB: "h", 0x0501: "d", 0x051B: "q", 0x051D: "w",
        0x0391: "A", 0x0392: "B", 0x0395: "E", 0x0396: "Z", 0x0397: "H",
        0x0399: "I", 0x039A: "K", 0x039C: "M", 0x039D: "N", 0x039F: "O",
        0x03A1: "P", 0x03A4: "T", 0x03A5: "Y", 0x03A7: "X", 0x03BF: "o",
    }

# --------------------------------------------------------- context tests ----

def is_emoji_base(cp):
    return (0x1F000 <= cp <= 0x1FAFF or 0x2190 <= cp <= 0x25FF
            or 0x2600 <= cp <= 0x27BF or 0x2B00 <= cp <= 0x2BFF
            or cp in (0x00A9, 0x00AE, 0x2122, 0x3030, 0x303D, 0x3297, 0x3299)
            or cp in (0x23, 0x2A) or 0x30 <= cp <= 0x39)


def is_cjk(cp):
    return (0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF
            or 0xF900 <= cp <= 0xFAFF or 0x20000 <= cp <= 0x323AF)


def joining_script(cp):
    """Broad script group where ZWJ/ZWNJ are orthographic, else None."""
    for lo, hi, name in ((0x0600, 0x08FF, "arabic"), (0xFB50, 0xFDFF, "arabic"),
                         (0xFE70, 0xFEFF, "arabic"), (0x0900, 0x0DFF, "indic"),
                         (0x0F00, 0x109F, "south-asian"), (0x1780, 0x17FF, "khmer"),
                         (0x1800, 0x18AF, "mongolian")):
        if lo <= cp <= hi and unicodedata.category(chr(cp))[0] in "LM":
            return name
    return None


def is_letter_in(cp, lo, hi):
    return lo <= cp <= hi and unicodedata.category(chr(cp))[0] == "L"


def is_hangul_jamo(cp):
    return 0x1100 <= cp <= 0x11FF or 0xA960 <= cp <= 0xA97C or 0xD7B0 <= cp <= 0xD7C6


def is_rtl(cp):
    return unicodedata.bidirectional(chr(cp)) in ("R", "AL", "AN")


def valid_flag_tag_indices(text):
    """Indices inside complete black-flag + tag + cancel-tag sequences."""
    valid = set()
    i = 0
    while i < len(text):
        if ord(text[i]) != BLACK_FLAG:
            i += 1
            continue
        j = i + 1
        while j < len(text) and 0xE0020 <= ord(text[j]) <= 0xE007E:
            j += 1
        if j > i + 1 and j < len(text) and ord(text[j]) == TAG_END:
            valid.update(range(i + 1, j + 1))
            i = j + 1
        else:
            i += 1
    return valid


# Word boundaries for the look-alike rule: whitespace, ASCII punctuation, and the
# common punctuation blocks. Deliberately NOT unicodedata categories, so the
# TypeScript port can carry the identical table without General_Category data.
# Invisible/format characters are neither boundary nor letter: the scan steps
# over them, so a ZWSP wedged into "аpple" cannot hide the look-alike.
WORD_BOUNDARY = ({0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2028, 0x2029,
                  0x202F, 0x205F, 0x3000, 0xA1, 0xA7, 0xAB, 0xB6, 0xB7, 0xBB, 0xBF}
                 | set(range(0x2000, 0x200B))
                 | set(range(0x21, 0x30)) | set(range(0x3A, 0x41)) | set(range(0x5B, 0x61))
                 | set(range(0x7B, 0x7F))
                 | set(range(0x2010, 0x2028)) | set(range(0x2030, 0x205F))
                 | set(range(0x2E00, 0x2E80)) | set(range(0x3001, 0x3040))
                 | set(range(0xFF01, 0xFF10)) | set(range(0xFF1A, 0xFF21))
                 | set(range(0xFF3B, 0xFF41)) | set(range(0xFF5B, 0xFF66)))

GLUE = ({ZWNJ, ZWJ} | VS_EMOJI | VS_TEXT | VS_SUPPLEMENT | MONGOLIAN_FVS
        | KHMER_VOWELS | HANGUL_FILLERS | TAG_CHARS | set(SCRIPT_CF))

# ------------------------------------------------------------- classifier ----

def is_ascii_alnum(cp):
    return 0x30 <= cp <= 0x39 or 0x41 <= cp <= 0x5A or 0x61 <= cp <= 0x7A


def in_mixed_script_word(text, i):
    """True when the word around index i also contains an ASCII letter or digit.

    A Cyrillic а inside "аpple" or "Miсrosoft" is a look-alike; the same letter
    inside "Рецепт" is just Russian. Only the former is reported or replaced.
    """
    n = len(text)
    j = i - 1
    while j >= 0 and ord(text[j]) not in WORD_BOUNDARY:
        if is_ascii_alnum(ord(text[j])):
            return True
        j -= 1
    j = i + 1
    while j < n and ord(text[j]) not in WORD_BOUNDARY:
        if is_ascii_alnum(ord(text[j])):
            return True
        j += 1
    return False


def mixed_script_words(text):
    """in_mixed_script_word(text, i) for every index i, in linear time.

    Asking in_mixed_script_word of each confusable rescans its word every time,
    so a long word of look-alikes costs the square of its length. Two passes
    give every answer at once. right[k] says an ASCII letter or digit sits in
    text[k:] before the first word boundary; the forward pass carries the same
    fact about text[:i], read back from the nearest boundary. A boundary resets
    both, so index i sees exactly the run the per-index scan walks: left of i
    and right of i, each stopping at a boundary, never counting i itself.
    """
    n = len(text)
    right = [False] * (n + 1)
    for k in range(n - 1, -1, -1):
        cp = ord(text[k])
        right[k] = cp not in WORD_BOUNDARY and (right[k + 1] or is_ascii_alnum(cp))
    mixed = [False] * n
    left = False
    for k in range(n):
        mixed[k] = left or right[k + 1]
        cp = ord(text[k])
        left = cp not in WORD_BOUNDARY and (left or is_ascii_alnum(cp))
    return mixed


def is_gutter(text, i):
    """True when the bar at i is a quote gutter: see GUTTERS.

    The same test GUTTER_RE makes, asked of one index so find() can report the
    bar at its position in the caller's text.
    """
    j = i - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    if j >= 0 and text[j] != "\n":
        return False
    end = text.find("\n", i + 1)
    return text[i] not in text[i + 1:end if end != -1 else len(text)]


def classify(text, i, prev_kept, flag_tags, mixed=None):
    """Return (kind, flag, replacement) if the char at i is suspicious.

    kind: label for --show. flag: the option that must be on to act on it
    ("default" is always on). replacement: string to substitute, "" to delete.
    Returns None for ordinary characters. Load-bearing glue is returned with
    flag "-a" so it is reported but only stripped in aggressive mode.

    mixed: mixed_script_words(text), which a caller walking the whole text
    passes so a long word of look-alikes stays linear. Without it the one
    index is answered by in_mixed_script_word, with the same result.
    """
    cp = ord(text[i])
    prev = ord(text[i - 1]) if i > 0 else None
    nxt = ord(text[i + 1]) if i + 1 < len(text) else None
    pk = ord(prev_kept) if prev_kept else None

    if cp in ALWAYS_STRIP:
        return "invisible", "default", ""
    if cp in BIDI_ALWAYS:
        return "bidi-override", "default", ""
    if cp in BIDI_MARKS:
        near_rtl = (prev is not None and is_rtl(prev)) or (nxt is not None and is_rtl(nxt))
        return "bidi-mark", ("--bidi" if near_rtl else "default"), ""

    if cp in GLUE:
        bound = False
        if cp == ZWJ:
            bound = (pk is not None and nxt is not None
                     and is_emoji_base(pk) and is_emoji_base(nxt))
        if cp in (ZWJ, ZWNJ) and not bound:
            bound = (prev is not None and nxt is not None
                     and joining_script(prev) is not None
                     and joining_script(prev) == joining_script(nxt))
        elif cp in VS_EMOJI:
            bound = prev is not None and is_emoji_base(prev)
        elif cp in VS_TEXT or cp in VS_SUPPLEMENT:
            bound = prev is not None and is_cjk(prev)
        elif cp in MONGOLIAN_FVS:
            bound = pk is not None and is_letter_in(pk, 0x1800, 0x18AF)
        elif cp in KHMER_VOWELS:
            bound = pk is not None and is_letter_in(pk, 0x1780, 0x17FF)
        elif cp in HANGUL_FILLERS:
            bound = pk is not None and is_hangul_jamo(pk)
        elif cp in SCRIPT_CF:
            bound = pk is not None and is_letter_in(pk, *SCRIPT_CF[cp])
        elif cp in TAG_CHARS:
            bound = i in flag_tags
        return "glue", ("-a" if bound else "default"), ""

    if cp in ORTHOGRAPHIC_CF:
        return None
    cat = unicodedata.category(chr(cp))
    if cat == "Cf":
        return "format-control", "default", ""
    if cat == "Co":
        return "private-use", "--pua", ""
    if cp in SPACES:
        return "space", "-s", " "
    if cp in LINE_BREAKS:
        return "line-break", "-n", "\n"
    if cp in CONTROLS:
        return "control", "--controls", ""
    if cp in PUNCT:
        return "punct", "--punct", PUNCT[cp]
    if cp in GUTTERS and is_gutter(text, i):
        return "gutter", "--gutters", ""
    if cp in CONFUSABLES and (mixed[i] if mixed is not None
                              else in_mixed_script_word(text, i)):
        return "confusable", "--confusables", CONFUSABLES[cp]
    return None


def enabled_flags(args):
    # "--gutters" is never on here. GUTTER_RE removes the bar in a pre-pass,
    # together with the space after it; the classifier only reports the bar,
    # and acting on it again would strip the inner bar of a nested quote.
    on = {"default"}
    for flag, val in (("-a", args.aggressive), ("-s", args.spaces), ("-n", args.newlines),
                      ("--controls", args.controls), ("--bidi", args.bidi),
                      ("--pua", args.pua), ("--punct", args.punct),
                      ("--confusables", args.confusables)):
        if val:
            on.add(flag)
    return on


def clean(text, args):
    if args.nfkc:
        text = unicodedata.normalize("NFKC", text)
    elif args.nfc:
        text = unicodedata.normalize("NFC", text)
    if args.newlines:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    # After -n, so a lone CR has become a line break; before the dash rule, which
    # should see a quoted line without its bar.
    if args.gutters:
        text = GUTTER_RE.sub(r"\1", text)
    if args.punct:
        text = DASH_RE.sub(" - ", text)
    if args.trailing:  # after --gutters, so a bare-bar line followed by spaces trails clean
        text = TRAILING_RE.sub("", text)
    if args.collapse:
        text = COLLAPSE_RE.sub(" ", text)
    on = enabled_flags(args)
    flag_tags = valid_flag_tag_indices(text)
    mixed = mixed_script_words(text)
    out = []
    prev_kept = None
    for i, ch in enumerate(text):
        hit = classify(text, i, prev_kept, flag_tags, mixed)
        if hit is None or hit[1] not in on:
            out.append(ch)
            if ord(ch) not in GLUE:  # glue does not advance the base
                prev_kept = ch
            continue
        _, _, rep = hit
        out.append(rep)
        if rep:
            prev_kept = rep[-1]
    return "".join(out)


def find(text):
    """Every suspicious codepoint as (line, col, cp, kind, flag), in order."""
    flag_tags = valid_flag_tag_indices(text)
    mixed = mixed_script_words(text)
    hits = []
    prev_kept = None
    line = col = 1
    for i, ch in enumerate(text):
        hit = classify(text, i, prev_kept, flag_tags, mixed)
        if hit:
            hits.append((line, col, ord(ch), *hit[:2]))
        if ord(ch) not in GLUE:
            prev_kept = ch
        if ch == "\n":
            line, col = line + 1, 1
        else:
            col += 1
    return hits


def show(text, label):
    """Report every suspicious codepoint with its location. Returns count.

    Any hidden payload decode_payloads.decode() recognises follows the findings
    as a "Hidden message found" block. It does not change the count.
    """
    import decode_payloads  # imports this module, so not at the top

    hits = find(text)
    if not hits:
        print(f"{label}: clean")
    else:
        print(f"{label}: {len(hits)} found")
    for ln, cl, cp, kind, flag in hits:
        name = unicodedata.name(chr(cp), "<unnamed>")
        note = "" if flag == "default" else f"(needs {flag})"
        print(f"  {ln}:{cl}\tU+{cp:04X}\t{kind:<15} {note:<20} {name}")
    for line in decode_payloads.payload_lines(text):
        print(line)
    return len(hits)


# ------------------------------------------------------------------- cli ----

def read_text(path):
    try:
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()
    except UnicodeDecodeError:
        print(f"{path}: not valid UTF-8, skipped", file=sys.stderr)
        return None


MAX_FLAGS = ("aggressive", "spaces", "newlines", "bidi", "controls", "pua",
             "punct", "confusables", "nfkc", "gutters", "trailing", "collapse")


def add_clean_flags(p):
    """The cleaning options, shared with clean_file.py."""
    p.add_argument("-a", "--aggressive", action="store_true",
                   help="strip glue even when load-bearing (breaks emoji, Persian, flags)")
    p.add_argument("-s", "--spaces", action="store_true",
                   help="normalize NBSP and exotic spaces to a plain space")
    p.add_argument("-n", "--newlines", action="store_true",
                   help="fold CRLF, CR, NEL, U+2028 and U+2029 to a plain LF")
    p.add_argument("--bidi", action="store_true",
                   help="strip LRM/RLM/isolates even next to RTL text")
    p.add_argument("--controls", action="store_true",
                   help="strip C0/C1 control characters (keeps tab and line breaks)")
    p.add_argument("--pua", action="store_true",
                   help="strip private-use characters (breaks icon-font glyphs)")
    p.add_argument("--punct", action="store_true",
                   help="ASCII-ify em/en dashes, curly quotes, ellipsis, minus")
    p.add_argument("--confusables", action="store_true",
                   help="map look-alike Cyrillic/Greek letters to Latin inside mixed-script words "
                        "(\"аpple\", \"Miсrosoft\"); pure Cyrillic/Greek words are left alone")
    p.add_argument("--nfc", action="store_true",
                   help="NFC-normalize: composes e+accent into é (kills normalization-form stego)")
    p.add_argument("--nfkc", action="store_true",
                   help="NFKC-normalize: NFC plus styled math letters, ligatures, fullwidth")
    p.add_argument("--gutters", action="store_true",
                   help="strip terminal quote bars (U+258C-U+258F, U+2502, U+2503) that open a "
                        "line, with one space after; keeps indentation and box-drawn tables")
    p.add_argument("--trailing", action="store_true",
                   help="strip trailing spaces/tabs on every line (SNOW-style stego)")
    p.add_argument("--collapse", action="store_true",
                   help="collapse runs of spaces inside lines to one (keeps indentation)")
    p.add_argument("--max", action="store_true",
                   help="every pass on: -a -s -n --bidi --controls --pua --punct --confusables "
                        "--nfkc --gutters --trailing --collapse. Destructive to emoji and non-Latin text.")


def apply_max(args):
    if args.max:
        for name in MAX_FLAGS:
            setattr(args, name, True)
    return args


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="*", help="files to clean (default: stdin)")
    p.add_argument("-i", "--in-place", action="store_true", help="rewrite files in place")
    add_clean_flags(p)
    p.add_argument("--show", action="store_true",
                   help="report what is present, with locations; change nothing")
    p.add_argument("--check", action="store_true",
                   help="exit 1 if anything would be changed; write nothing")
    p.add_argument("-c", "--count", action="store_true",
                   help="report per-file totals to stderr")
    args = apply_max(p.parse_args())

    if args.in_place and not args.files:
        p.error("-i needs file arguments")

    sys.stdin.reconfigure(newline="")
    sys.stdout.reconfigure(newline="")

    found = failed = 0
    for path in args.files or [None]:
        label = path or "<stdin>"
        text = sys.stdin.read() if path is None else read_text(path)
        if text is None:
            failed = 1
            continue
        if args.show:
            found += show(text, label)
            continue

        cleaned = clean(text, args)
        changed = cleaned != text
        found += changed
        if args.check:
            if changed and args.count:
                print(f"{label}: would change", file=sys.stderr)
        elif args.in_place:
            if changed:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(cleaned)
        else:
            sys.stdout.write(cleaned)
        if args.count and not args.check:
            print(f"{label}: {len(text) - len(cleaned):+d} chars", file=sys.stderr)

    if failed:
        return 2
    if (args.check or args.show) and found:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
