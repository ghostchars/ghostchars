#!/usr/bin/env python3
"""Decode what hidden characters carry.

strip_invisible.py finds and removes hidden characters; this module says what
they were carrying. decode(text) returns an ordered list of payload records,
one per carrier it recognises:

    {"scheme": "tag-ascii", "start": 10, "end": 12, "text": "hi",
     "hex": "6869", "bits": 16, "confidence": "decoded"}

  scheme      which carrier, one of SCHEMES (see below)
  start, end  0-based codepoint indices of the carrier, end exclusive: the same
              index convention the findings use. For a run scheme this is the
              run itself; for a scattered scheme it spans the first to the last
              carrier, and the visible text in between is not part of it.
  text        the decoded message, or None when nothing readable came out
  hex         the raw bytes, lowercase hex ("" when the carrier has no byte form)
  bits        how many bits the carrier holds
  confidence  "decoded" (text is set) or "fingerprint" (a pattern is present,
              no readable message)

Run schemes, hidden characters that sit next to each other:

  tag-ascii           Unicode tag characters U+E0000..U+E007F outside a
                      subdivision flag. Each one is an ASCII byte (ASCII
                      smuggling).
  variation-selector  two or more variation selectors in a row, VS1..VS16 and
                      VS17..VS256 read as bytes 0..255, decoded as UTF-8.
  zero-width-binary   a run of at least MIN_ZW_RUN zero-width characters (ZWSP,
                      ZWNJ, ZWJ, WORD JOINER, BOM, the invisible operators)
                      built from two symbols, read as bits. A symbol that only
                      occurs at the ends of the run is a delimiter and is
                      skipped. Three or more data symbols: fingerprint.

Scattered schemes, one carrier per position across the text:

  bidi-mark-binary      LRM = 0, RLM = 1, ignoring marks next to RTL letters
  trailing-whitespace   trailing spaces and tabs per line, space = 0, tab = 1
  space-nbsp-binary     U+0020 = 0, U+00A0 = 1
  double-space-binary   one space between words = 0, two spaces = 1
  apostrophe-binary     U+0027 = 0, U+2019 = 1
  normalization-binary  precomposed letter = 0, base plus combining mark that
                        NFC would compose = 1
  homoglyph             look-alike letters inside mixed-script words; fingerprint
                        only, because which plain letters stand for 0 depends on
                        the encoder's alphabet

A canary mark (canary.py) is a run scheme of its own:

  canary              a per-recipient mark, a run of ZWSP and ZWNJ that holds a
                      whole canary frame with a valid checksum. An unkeyed mark
                      is decoded to its id. A keyed mark is a fingerprint: its
                      id is only trustworthy once the key verifies it, and
                      decoding cannot do that. A canary run is not read again
                      as zero-width binary.

The visible-character channels (spaces, apostrophes, normalization) only ever
produce a decoded record: their carriers are ordinary typography, so a pattern
without a readable message says nothing. Bidi marks (at least
MIN_BIDI_FINGERPRINT of them, both kinds present) and look-alike letters (at
least MIN_HOMOGLYPHS) also produce a fingerprint. Every binary scheme needs
both bit values present before it reads anything.

PLAUSIBILITY. Bits become a message only when the result is plausible text,
because a wrong decode is worse than none. Bits are read 8 per byte, most
significant first. Both polarities are tried, the scheme's own mapping first
(for zero-width binary, the lower codepoint is 0). For one polarity the result
is accepted when:

  1. any bits after the last whole byte are 0, and trailing 0x00 bytes are
     padding and are dropped;
  2. the remaining bytes are strict UTF-8;
  3. the message has at least MIN_MESSAGE_CHARS codepoints (one for the
     variation-selector scheme, whose bytes are explicit);
  4. it holds no C0 or C1 control other than tab, LF and CR, and no character
     that strip_invisible.classify() flags as "default" or reports as
     invisible, bidi-override, format-control, private-use or control;
  5. it holds at least one ASCII letter or digit, or a codepoint from U+00C0 up.

Legitimate glue produces nothing: VS16 after an emoji, emoji ZWJ sequences,
subdivision flags, ZWNJ in Persian, a BOM at the start of a file, soft hyphens,
and LRM or RLM next to RTL letters.

Statistical watermarks (token-probability biasing such as SynthID Text) are not
made of characters, so this module cannot see them, and neither can any other
character decoder.
"""
import unicodedata

import canary
import strip_invisible as si

SCHEMES = (
    "tag-ascii",
    "variation-selector",
    "zero-width-binary",
    "canary",
    "bidi-mark-binary",
    "trailing-whitespace",
    "space-nbsp-binary",
    "double-space-binary",
    "apostrophe-binary",
    "normalization-binary",
    "homoglyph",
)

MIN_ZW_RUN = 8          # shorter zero-width runs are left to the findings
MIN_MESSAGE_CHARS = 2   # a decoded message needs at least this many codepoints
MIN_BIDI_FINGERPRINT = 8
MIN_HOMOGLYPHS = 4

TAG_LO, TAG_HI = 0xE0000, 0xE007F
ZW_CARRIERS = {0x200B, 0x200C, 0x200D, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF}
EMOJI_PRESENTATION = {0xFE0E, 0xFE0F}
LRM, RLM = 0x200E, 0x200F
NBSP = 0x00A0
APOSTROPHE, RIGHT_SINGLE_QUOTE = 0x0027, 0x2019
REJECT_KINDS = {"invisible", "bidi-override", "format-control", "private-use", "control"}


# ------------------------------------------------------------- helpers ----

def is_tag(cp):
    return TAG_LO <= cp <= TAG_HI


def is_flag_spec(cp):
    """A tag digit or lowercase tag letter: what a subdivision code is made of."""
    return 0xE0030 <= cp <= 0xE0039 or 0xE0061 <= cp <= 0xE007A


def flag_tag_indices(cps):
    """Indices of tag characters that belong to a subdivision flag.

    A flag is U+1F3F4, three to seven tag digits or lowercase tag letters (a
    subdivision code such as "gbsct"), then CANCEL TAG. The same opening cut
    short (one to seven code characters, then no further tag character) is a
    truncated flag and is excused too. Anything longer, or with other tag
    characters, is a payload even when the cleaner keeps it as a flag.
    """
    excused = set()
    n = len(cps)
    i = 0
    while i < n:
        if cps[i] != si.BLACK_FLAG:
            i += 1
            continue
        j = i + 1
        while j < n and is_flag_spec(cps[j]):
            j += 1
        length = j - i - 1
        if 3 <= length <= 7 and j < n and cps[j] == si.TAG_END:
            excused.update(range(i + 1, j + 1))
            i = j + 1
        elif 1 <= length <= 7 and (j == n or not is_tag(cps[j])):
            excused.update(range(i + 1, j))
            i = j
        else:
            i += 1
    return excused


def is_vs(cp):
    return 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF


def vs_byte(cp):
    return cp - 0xFE00 if cp <= 0xFE0F else cp - 0xE0100 + 16


def scan(cps):
    """(index, cp, kind, flag) for every finding, as strip_invisible.find() walks."""
    text = "".join(map(chr, cps))
    flag_tags = si.valid_flag_tag_indices(text)
    mixed = si.mixed_script_words(text)
    hits = []
    prev_kept = None
    for i, ch in enumerate(text):
        hit = si.classify(text, i, prev_kept, flag_tags, mixed)
        if hit:
            hits.append((i, cps[i], hit[0], hit[1]))
        if cps[i] not in si.GLUE:
            prev_kept = ch
    return hits


def utf8(raw):
    """The strict UTF-8 decoding of raw, or None."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def plausible(message, min_chars):
    """Rules 3 to 5 of PLAUSIBILITY in the module docstring."""
    cps = [ord(c) for c in message]
    if len(cps) < min_chars:
        return False
    for cp in cps:
        if cp in (0x09, 0x0A, 0x0D):
            continue
        if cp < 0x20 or 0x7F <= cp <= 0x9F:
            return False
    if not any(si.is_ascii_alnum(cp) or cp >= 0xC0 for cp in cps):
        return False
    for _, _, kind, flag in scan(cps):
        if flag == "default" or kind in REJECT_KINDS:
            return False
    return True


def bits_to_bytes(bits):
    """Whole bytes of a bit string, or None when a partial tail byte is not all 0."""
    whole = len(bits) - len(bits) % 8
    if "1" in bits[whole:]:
        return None
    return bytes(int(bits[k:k + 8], 2) for k in range(0, whole, 8))


def read_message(bits):
    """Rules 1 to 5 of PLAUSIBILITY, both polarities: (text, raw bytes) or None."""
    flipped = bits.translate(str.maketrans("01", "10"))
    for candidate in (bits, flipped):
        raw = bits_to_bytes(candidate)
        if raw is None:
            continue
        raw = raw.rstrip(b"\x00")
        message = utf8(raw)
        if message is not None and plausible(message, MIN_MESSAGE_CHARS):
            return message, raw
    return None


def record(scheme, start, end, text, raw_hex, bits):
    return {"scheme": scheme, "start": start, "end": end, "text": text, "hex": raw_hex,
            "bits": bits, "confidence": "fingerprint" if text is None else "decoded"}


def runs(cps, member):
    """(start, end) of each maximal run of indices for which member(i) is true."""
    out = []
    i, n = 0, len(cps)
    while i < n:
        if not member(i):
            i += 1
            continue
        j = i
        while j < n and member(j):
            j += 1
        out.append((i, j))
        i = j
    return out


# ------------------------------------------------------------- run schemes ----

def decode_tags(cps):
    excused = flag_tag_indices(cps)
    out = []
    for start, end in runs(cps, lambda i: is_tag(cps[i]) and i not in excused):
        raw = bytes(cp - TAG_LO for cp in cps[start:end])
        text = "".join(chr(b) for b in raw if 0x20 <= b <= 0x7E or b in (0x09, 0x0A, 0x0D))
        readable = any(c not in " \t\n\r" for c in text)
        out.append(record("tag-ascii", start, end, text if readable else None, raw.hex(),
                          8 * len(raw)))
    return out


def decode_variation_selectors(cps):
    out = []
    for start, end in runs(cps, lambda i: is_vs(cps[i])):
        run = cps[start:end]
        if len(run) < 2 or all(cp in EMOJI_PRESENTATION for cp in run):
            continue
        raw = bytes(vs_byte(cp) for cp in run)
        message = utf8(raw)
        text = message if message is not None and plausible(message, 1) else None
        out.append(record("variation-selector", start, end, text, raw.hex(), 8 * len(raw)))
    return out


def decode_canary(cps):
    """canary.find_marks(): an unkeyed mark reads as its id, a keyed one as a fingerprint."""
    return [record("canary", m["start"], m["end"], None if m["keyed"] else m["id"],
                   m["raw"].hex(), 8 * len(m["raw"]))
            for m in canary.find_marks("".join(map(chr, cps)))]


def decode_zero_width(cps, marked):
    """marked: indices inside a canary mark, which this scheme leaves alone."""
    out = []
    for start, end in runs(cps, lambda i: cps[i] in ZW_CARRIERS and i not in marked):
        run = cps[start:end]
        if len(run) < MIN_ZW_RUN:
            continue
        lo, hi = 0, len(run)
        if len(set(run)) >= 3:
            for sym in sorted({run[0], run[-1]}):
                where = [k for k, cp in enumerate(run) if cp == sym]
                if all(k in (0, len(run) - 1) for k in where):
                    if 0 in where:
                        lo = 1
                    if len(run) - 1 in where:
                        hi = len(run) - 1
        data = run[lo:hi]
        symbols = sorted(set(data))
        if len(symbols) < 2:
            continue
        if len(symbols) > 2:
            per_symbol = (len(symbols) - 1).bit_length()
            out.append(record("zero-width-binary", start, end, None, "",
                              len(data) * per_symbol))
            continue
        bits = "".join("0" if cp == symbols[0] else "1" for cp in data)
        out.append(binary_record("zero-width-binary", start, end, bits, fingerprint=True))
    return out


def binary_record(scheme, start, end, bits, fingerprint):
    """A decoded record when the bits read as text, else a fingerprint or None."""
    found = read_message(bits)
    if found is not None:
        message, raw = found
        return record(scheme, start, end, message, raw.hex(), len(bits))
    if not fingerprint:
        return None
    raw = bytes(int(bits[k:k + 8], 2) for k in range(0, len(bits) - len(bits) % 8, 8))
    return record(scheme, start, end, None, raw.hex(), len(bits))


# ------------------------------------------------------- scattered schemes ----

def scattered(scheme, carriers, fingerprint=False):
    """carriers: (index, bit) pairs in text order. One record or none."""
    if not carriers:
        return []
    bits = "".join(b for _, b in carriers)
    if "0" not in bits or "1" not in bits:
        return []
    start, end = carriers[0][0], carriers[-1][0] + 1
    rec = binary_record(scheme, start, end, bits, fingerprint)
    return [rec] if rec is not None else []


def whitespace_runs(cps):
    return runs(cps, lambda i: cps[i] in (0x20, 0x09))


def decode_bidi_marks(hits):
    carriers = [(i, "0" if cp == LRM else "1") for i, cp, kind, flag in hits
                if kind == "bidi-mark" and flag == "default" and cp in (LRM, RLM)]
    return scattered("bidi-mark-binary", carriers,
                     fingerprint=len(carriers) >= MIN_BIDI_FINGERPRINT)


def decode_trailing_whitespace(cps):
    n = len(cps)
    carriers = []
    for start, end in whitespace_runs(cps):
        trailing = (end == n or cps[end] == 0x0A
                    or (cps[end] == 0x0D and end + 1 < n and cps[end + 1] == 0x0A))
        if trailing:
            carriers += [(i, "0" if cps[i] == 0x20 else "1") for i in range(start, end)]
    return scattered("trailing-whitespace", carriers)


def decode_double_spaces(cps):
    n = len(cps)
    carriers = []
    for start, end in whitespace_runs(cps):
        if start == 0 or end == n or end - start > 2:
            continue
        if cps[start - 1] in (0x0A, 0x0D) or cps[end] in (0x0A, 0x0D):
            continue
        if any(cps[i] != 0x20 for i in range(start, end)):
            continue
        carriers.append((start, "0" if end - start == 1 else "1"))
    return scattered("double-space-binary", carriers)


def decode_two_symbol(cps, scheme, zero, one):
    carriers = [(i, "0" if cp == zero else "1") for i, cp in enumerate(cps) if cp in (zero, one)]
    return scattered(scheme, carriers)


def decode_normalization(cps):
    n = len(cps)
    carriers = []
    i = 0
    while i < n:
        ch = chr(cps[i])
        if unicodedata.normalize("NFD", ch) != ch:
            carriers.append((i, "0"))
        elif i + 1 < n and len(unicodedata.normalize("NFC", ch + chr(cps[i + 1]))) == 1:
            carriers.append((i, "1"))
            i += 1
        i += 1
    return scattered("normalization-binary", carriers)


def decode_homoglyphs(hits):
    where = [i for i, _, kind, _ in hits if kind == "confusable"]
    if len(where) < MIN_HOMOGLYPHS:
        return []
    return [record("homoglyph", where[0], where[-1] + 1, None, "", len(where))]


# ---------------------------------------------------------------- display ----

def escape_message(text):
    """A decoded message, safe to print on a terminal.

    A payload is written by whoever hid it, so it is shown with every character
    a terminal could act on, or a reader could miss, written as an escape:

      backslash         \\\\
      tab, LF, CR       \\t, \\n, \\r
      other controls    \\u{XXXX} (C0, DEL and C1)
      flagged chars     \\u{XXXX} (anything strip_invisible would report here)

    Everything else, printable ASCII and ordinary letters in any script, is
    printed as itself.
    """
    cps = [ord(c) for c in text]
    flagged = {i for i, _, _, _ in scan(cps)}
    out = []
    for i, cp in enumerate(cps):
        if cp == 0x5C:
            out.append("\\\\")
        elif cp == 0x09:
            out.append("\\t")
        elif cp == 0x0A:
            out.append("\\n")
        elif cp == 0x0D:
            out.append("\\r")
        elif cp < 0x20 or 0x7F <= cp <= 0x9F or i in flagged:
            out.append(f"\\u{{{cp:04X}}}")
        else:
            out.append(chr(cp))
    return "".join(out)


def positions(text, indices):
    """{index: (line, col)} for codepoint indices, 1-based, lines split on LF only."""
    wanted = set(indices)
    found = {}
    line, col = 1, 1
    for i, ch in enumerate(text):
        if i in wanted:
            found[i] = (line, col)
        if ch == "\n":
            line, col = line + 1, 1
        else:
            col += 1
    if len(text) in wanted:
        found[len(text)] = (line, col)
    return found


def payload_lines(text, payloads=None, indent="  "):
    """The "Hidden message found" block that --show prints after the findings.

    One line per payload naming the scheme, where it starts and ends (line:col
    of the first and last carrier) and its size in bits. A decoded payload is
    followed by its message, escaped by escape_message(); a fingerprint says
    that no readable message came out.
    """
    if payloads is None:
        payloads = decode(text)
    if not payloads:
        return []
    where = positions(text, [i for p in payloads for i in (p["start"], max(p["start"], p["end"] - 1))])
    lines = []
    for p in payloads:
        line, col = where[p["start"]]
        end_line, end_col = where[max(p["start"], p["end"] - 1)]
        span = f'{p["scheme"]} at {line}:{col} to {end_line}:{end_col}, {p["bits"]} bits'
        if p["text"] is None:
            lines.append(f"{indent}Hidden pattern: {span}, no readable message")
        else:
            lines.append(f"{indent}Hidden message found: {span}")
            lines.append(f"{indent}  {escape_message(p['text'])}")
    return lines


# ------------------------------------------------------------------ entry ----

def decode(text):
    """Every hidden payload in text, ordered by start, then end, then scheme."""
    cps = [ord(c) for c in text]
    hits = scan(cps)
    marks = decode_canary(cps)
    marked = {i for m in marks for i in range(m["start"], m["end"])}
    found = (decode_tags(cps)
             + decode_variation_selectors(cps)
             + decode_zero_width(cps, marked)
             + marks
             + decode_bidi_marks(hits)
             + decode_trailing_whitespace(cps)
             + decode_two_symbol(cps, "space-nbsp-binary", 0x20, NBSP)
             + decode_double_spaces(cps)
             + decode_two_symbol(cps, "apostrophe-binary", APOSTROPHE, RIGHT_SINGLE_QUOTE)
             + decode_normalization(cps)
             + decode_homoglyphs(hits))
    return sorted(found, key=lambda r: (r["start"], r["end"], SCHEMES.index(r["scheme"])))

