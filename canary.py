#!/usr/bin/env python3
"""Per-recipient invisible marks: put an id in a text so a leaked copy names it.

The reverse use of the cleaner. Before a confidential draft goes out, each
recipient gets a copy that carries their id in zero-width characters; when a
copy turns up where it should not, detect() reads the id back.

    marked = embed(text, "alice")          # looks identical to text
    detect(marked)                         # [{"id": "alice", "status": "unkeyed", ...}]
    marked = embed(text, "alice", key=b"secret")
    detect(marked, key=b"secret")          # status "verified"

WHAT IT IS NOT. Any hidden-character cleaner removes the mark, this product's
own cleaner included: strip_invisible.clean() with the default options turns a
marked text back into the original, byte for byte. It deters and traces casual
leaks, forwarded or pasted copies; it is not tamper-proof and it is not a
watermark that survives retyping, rewording or a cleaner.

FRAME. One mark is one run of zero-width characters, one bit per character,
most significant bit first:

  byte 0          MAGIC (0xA7)
  byte 1          VERSION_PLAIN (0x10) or VERSION_KEYED (0x11)
  byte 2          L, the length of the id in UTF-8 bytes, 1..MAX_ID_BYTES
  bytes 3..3+L    the id, UTF-8
  8 bytes         keyed marks only: HMAC-SHA256(key, TAG_CONTEXT + id), truncated
  4 bytes         CRC-32 of everything before it, big-endian

A run is a mark only when its length is exactly the frame's length, the magic
and version match, L agrees with the length, the CRC-32 matches and the id
passes valid_id(). Random or damaged runs fail one of those, so detect() does
not name a wrong id from noise; a run cut short by a partial copy fails too, and
the next whole copy is read instead.

KEYED MODE. Anyone can write an unkeyed mark naming anyone. With a key, the
mark carries a truncated HMAC of the id, so only someone holding the key can
make a mark that verifies. The id itself stays readable; the key authenticates
it, it does not hide it.

CARRIERS. Bit 0 is ZERO WIDTH SPACE (U+200B), bit 1 is ZERO WIDTH NON-JOINER
(U+200C). Real text needs both (ZWSP marks line-break opportunities in Thai,
Khmer and Burmese, ZWNJ is part of Persian and Indic spelling), so editors,
chat apps and clipboards tend to keep them, where tag characters and
variation-selector runs are more often dropped or rewritten. The trade-off:
they are also the first characters a hidden-character cleaner looks for.

PLACEMENT. A mark goes in front of a word: at the start of the text, or right
after whitespace. Next to a space neither carrier is load-bearing, so the
default clean removes every one. A copy of the mark goes in front of word 0,
word EVERY, word 2 * EVERY and so on, so any excerpt that spans EVERY + 1 words
carries at least one whole mark. A text with no word start (empty, or all
whitespace) cannot be marked. Marks already in the text are replaced.
"""
import hashlib
import hmac
import zlib

import strip_invisible as si

ZERO, ONE = 0x200B, 0x200C
CARRIERS = (ZERO, ONE)
MAGIC = 0xA7
VERSION_PLAIN, VERSION_KEYED = 0x10, 0x11
MAX_ID_BYTES = 64
TAG_BYTES = 8
CRC_BYTES = 4
EVERY = 10
TAG_CONTEXT = b"ghostchars-canary-v1\x00"

# Whitespace a mark may follow. An explicit table, so the ports agree without
# relying on each language's own idea of whitespace.
WHITESPACE = ({0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2028, 0x2029,
               0x202F, 0x205F, 0x3000} | set(range(0x2000, 0x200B)))

# The findings an id may contain: typography, not hiding.
ID_ALLOWED_KINDS = {"punct", "confusable"}


# --------------------------------------------------------------- helpers ----

def as_key(key):
    """A key as bytes: str is UTF-8. None stays None. An empty key is an error."""
    if key is None:
        return None
    raw = key.encode("utf-8") if isinstance(key, str) else bytes(key)
    if not raw:
        raise ValueError("the key is empty")
    return raw


def id_error(mark_id):
    """Why mark_id cannot be a mark id, or None when it can."""
    if not isinstance(mark_id, str):
        return "the id must be text"
    raw = mark_id.encode("utf-8", "surrogatepass")
    if not raw:
        return "the id is empty"
    if len(raw) > MAX_ID_BYTES:
        return f"the id is longer than {MAX_ID_BYTES} bytes in UTF-8"
    cps = [ord(c) for c in mark_id]
    if any(0xD800 <= cp <= 0xDFFF for cp in cps):
        return "the id is not valid Unicode"
    if any(cp < 0x20 or 0x7F <= cp <= 0x9F for cp in cps):
        return "the id contains a control character or line break"
    if any(kind not in ID_ALLOWED_KINDS for _, _, _, kind, _ in si.find(mark_id)):
        return "the id contains a hidden or special character"
    if all(cp in WHITESPACE for cp in cps):
        return "the id is blank"
    return None


def valid_id(mark_id):
    return id_error(mark_id) is None


def tag(key, id_bytes):
    """The truncated HMAC that authenticates an id under a key."""
    return hmac.new(key, TAG_CONTEXT + id_bytes, hashlib.sha256).digest()[:TAG_BYTES]


def frame(mark_id, key=None):
    """The bytes of one mark."""
    error = id_error(mark_id)
    if error:
        raise ValueError(error)
    key = as_key(key)
    id_bytes = mark_id.encode("utf-8")
    body = bytes([MAGIC, VERSION_PLAIN if key is None else VERSION_KEYED, len(id_bytes)])
    body += id_bytes
    if key is not None:
        body += tag(key, id_bytes)
    return body + zlib.crc32(body).to_bytes(CRC_BYTES, "big")


def mark_chars(raw):
    """Frame bytes as carrier characters, most significant bit first."""
    return "".join(chr(ONE if (b >> (7 - k)) & 1 else ZERO) for b in raw for k in range(8))


def parse_frame(cps):
    """The frame a run of carrier codepoints spells, as a dict, or None.

    {"id": str, "keyed": bool, "tag": bytes or None, "raw": bytes}
    """
    n = len(cps)
    if n % 8 or n < 8 * (3 + 1 + CRC_BYTES):
        return None
    raw = bytes(int("".join("1" if cp == ONE else "0" for cp in cps[k:k + 8]), 2)
                for k in range(0, n, 8))
    if raw[0] != MAGIC or raw[1] not in (VERSION_PLAIN, VERSION_KEYED):
        return None
    keyed = raw[1] == VERSION_KEYED
    size = raw[2]
    if not 1 <= size <= MAX_ID_BYTES:
        return None
    if len(raw) != 3 + size + (TAG_BYTES if keyed else 0) + CRC_BYTES:
        return None
    body, crc = raw[:-CRC_BYTES], raw[-CRC_BYTES:]
    if zlib.crc32(body).to_bytes(CRC_BYTES, "big") != crc:
        return None
    try:
        mark_id = raw[3:3 + size].decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not valid_id(mark_id):
        return None
    return {"id": mark_id, "keyed": keyed,
            "tag": raw[3 + size:3 + size + TAG_BYTES] if keyed else None, "raw": raw}


def carrier_runs(cps):
    """(start, end) of each maximal run of carrier codepoints."""
    out = []
    i, n = 0, len(cps)
    while i < n:
        if cps[i] not in CARRIERS:
            i += 1
            continue
        j = i
        while j < n and cps[j] in CARRIERS:
            j += 1
        out.append((i, j))
        i = j
    return out


def find_marks(text):
    """Every whole mark in text, in order, one dict per run.

    {"start", "end", "id", "keyed", "tag", "raw"}: start and end are codepoint
    indices of the run, end exclusive, as the findings count them.
    """
    cps = [ord(c) for c in text]
    out = []
    for start, end in carrier_runs(cps):
        parsed = parse_frame(cps[start:end])
        if parsed is not None:
            out.append({"start": start, "end": end, **parsed})
    return out


def word_starts(cps):
    """Indices where a mark may go: a word's first character, never a carrier."""
    return [i for i, cp in enumerate(cps)
            if cp not in WHITESPACE and cp not in CARRIERS
            and (i == 0 or cps[i - 1] in WHITESPACE)]


# ------------------------------------------------------------------ entry ----

def embed(text, mark_id, key=None):
    """text with a mark for mark_id in front of every EVERY-th word.

    Marks already in text are removed first, so marking a marked copy replaces
    its id. Raises ValueError for an id valid_id() rejects, an empty key, or a
    text with no word to put a mark in front of.
    """
    chars = mark_chars(frame(mark_id, key))
    for mark in reversed(find_marks(text)):
        text = text[:mark["start"]] + text[mark["end"]:]
    cps = [ord(c) for c in text]
    where = word_starts(cps)[::EVERY]
    if not where:
        raise ValueError("the text has no word to put a mark in front of")
    out = []
    last = 0
    for i in where:
        out.append(text[last:i])
        out.append(chars)
        last = i
    out.append(text[last:])
    return "".join(out)


def status_of(mark, key):
    """unkeyed, verified (the key matches), unverified (no key) or rejected."""
    if not mark["keyed"]:
        return "unkeyed"
    if key is None:
        return "unverified"
    good = tag(key, mark["id"].encode("utf-8"))
    return "verified" if hmac.compare_digest(good, mark["tag"]) else "rejected"


def detect(text, key=None):
    """The marks in text, one record per distinct id and status, in order.

    {"id", "keyed", "status", "count", "start", "end"}: status is "unkeyed",
    "verified", "unverified" or "rejected" (see status_of); count is how many
    whole copies were found; start and end locate the first copy. An empty
    list means no whole mark: either the text was never marked, or the marks
    were cleaned out or cut apart.
    """
    key = as_key(key)
    out = []
    seen = {}
    for mark in find_marks(text):
        status = status_of(mark, key)
        group = (mark["id"], mark["keyed"], status)
        if group in seen:
            seen[group]["count"] += 1
            continue
        rec = {"id": mark["id"], "keyed": mark["keyed"], "status": status, "count": 1,
               "start": mark["start"], "end": mark["end"]}
        seen[group] = rec
        out.append(rec)
    return out
