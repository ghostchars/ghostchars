#!/usr/bin/env python3
"""Tests for canary.py, the per-recipient marks. Run: python3 tests/test_canary.py

Round trip, excerpts, checksum rejection, keyed forgery rejection, and the
promise the module makes about itself: the default clean removes a mark and
gives back the original bytes. tools/gen_golden.py imports EMBED_CASES,
DETECT_CASES and ID_CASES from here, so the ports are held to the same inputs.
"""
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import canary  # noqa: E402
import decode_payloads as dp  # noqa: E402
import strip_invisible as si  # noqa: E402

ZWSP, ZWNJ, ZWJ = "\u200b", "\u200c", "\u200d"
MEMO = ("Quarterly plan: revenue is up and the launch moves to May. Keep this draft "
        "internal until the board meets next week. Questions go to the program office, "
        "not to the press desk.\n\nSecond paragraph:\tfigures are final.\n")
PERSIAN = "\u0645\u06cc\u200c\u0631\u0648\u0645 \u0628\u0647 \u0645\u062f\u0631\u0633\u0647"
FAMILY = "\U0001f468\u200d\U0001f469\u200d\U0001f467"
MIXED = ("Caf\u00e9 notes " + PERSIAN + " and " + FAMILY + " family, \u05e9\u05dc\u05d5\u05dd"
         "\u200f (rtl) " + "\U0001f3f4\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074"
         "\U000e007f flag\u00a0here, \u65e5\u672c\u8a9e\u306e\u6587\u7ae0 end")
KEY = "correct horse battery staple"


def default_clean(text):
    args = types.SimpleNamespace(**{f: False for f in (
        "aggressive", "spaces", "newlines", "bidi", "controls", "pua", "punct",
        "confusables", "nfc", "nfkc", "gutters", "trailing", "collapse")})
    return si.clean(text, args)


def flip_one(text, mark_index=0, bit=40):
    """text with one carrier of one mark swapped for the other symbol."""
    mark = canary.find_marks(text)[mark_index]
    i = mark["start"] + bit
    swapped = ZWNJ if text[i] == ZWSP else ZWSP
    return text[:i] + swapped + text[i + 1:]


def damage_all(text):
    """text with every mark damaged by one flipped bit."""
    while canary.find_marks(text):
        text = flip_one(text)
    return text


def drop_one(text, mark_index=0, bit=17):
    mark = canary.find_marks(text)[mark_index]
    i = mark["start"] + bit
    return text[:i] + text[i + 1:]


def forged(text, mark_id):
    """A keyed frame for mark_id with a made-up tag and a correct CRC-32."""
    import zlib
    id_bytes = mark_id.encode()
    body = bytes([canary.MAGIC, canary.VERSION_KEYED, len(id_bytes)]) + id_bytes + b"\x00" * 8
    raw = body + zlib.crc32(body).to_bytes(4, "big")
    return canary.mark_chars(raw) + text


def excerpt(text, words):
    """The middle `words` words of text, cut at whitespace, marks and all."""
    parts = text.split(" ")
    mid = len(parts) // 2
    return " ".join(parts[mid - words // 2: mid - words // 2 + words])


MARKED_MEMO = canary.embed(MEMO, "alice")
KEYED_MEMO = canary.embed(MEMO, "bob@example.com", key=KEY)

# (id, note, text, mark id, key or None): embed() output is pinned in golden.json.
EMBED_CASES = [
    ("memo-unkeyed", "an unkeyed mark in a memo", MEMO, "alice", None),
    ("memo-keyed", "a keyed mark in a memo", MEMO, "bob@example.com", KEY),
    ("one-word", "a single word gets one mark at the start", "Confidential", "r-7", None),
    ("leading-space", "a text that opens with whitespace", "  \n indented text", "x1", None),
    ("mixed-scripts", "emoji, Persian ZWNJ, Hebrew with RLM, a flag, NBSP and CJK",
     MIXED, "Zo\u00eb \u041c\u0430\u0440\u0438\u044f", "k"),
    ("remark", "marking a marked copy replaces its id", MARKED_MEMO, "carol", None),
    ("existing-zw", "a word that starts with ZWSP is skipped",
     "one " + ZWSP + "two three", "id", None),
]

# (id, note, text, key or None): detect() output is pinned in golden.json.
DETECT_CASES = [
    ("plain", "an unmarked text", MEMO, None),
    ("unkeyed", "an unkeyed mark, every copy counted", MARKED_MEMO, None),
    ("unkeyed-with-key", "an unkeyed mark read with a key is still unkeyed", MARKED_MEMO, KEY),
    ("keyed-no-key", "a keyed mark without the key", KEYED_MEMO, None),
    ("keyed-right-key", "a keyed mark with its key", KEYED_MEMO, KEY),
    ("keyed-wrong-key", "a keyed mark with another key", KEYED_MEMO, "not the key"),
    ("excerpt", "twelve words from the middle", excerpt(MARKED_MEMO, 12), None),
    ("flipped-bit", "one copy with a flipped bit is ignored", flip_one(MARKED_MEMO), None),
    ("dropped-char", "one copy missing a carrier is ignored", drop_one(MARKED_MEMO), None),
    ("all-flipped", "every copy damaged",
     damage_all(MARKED_MEMO), None),
    ("forged", "a keyed frame with a made-up tag", forged(MEMO, "mallory"), KEY),
    ("two-ids", "two marked copies pasted together",
     MARKED_MEMO + canary.embed("Second copy for someone else.", "dave"), None),
    ("cleaned", "a marked text after the default clean", default_clean(MARKED_MEMO), None),
]

# Ids embed() accepts (error None) or refuses, with the reason. Pinned too.
ID_CASES = [
    "alice", "bob@example.com", "Zo\u00eb", "\u041c\u0430\u0440\u0438\u044f 7",
    "x" * 64, "x" * 65, "\u00e9" * 32, "\u00e9" * 33, "", "   ", "a\tb", "a\nb",
    "a\u200bb", "a\u202eb", "a\u00a0b", "caf\u00e9 \u2014 draft", "\u0430pple",
    "a\x07b", "a\x85b", "\ue000",
]


fails = []


def check(desc, cond, got=""):
    print(("  ok  " if cond else " FAIL ") + desc + ("" if cond else f"   got={got!r}"))
    if not cond:
        fails.append(desc)


def ids(records):
    return [(r["id"], r["status"]) for r in records]


def main():
    print("=== round trip ===")
    for fid, note, text, mark_id, key in EMBED_CASES:
        marked = canary.embed(text, mark_id, key)
        status = "unkeyed" if key is None else "verified"
        check(f"{fid}: detect reads {mark_id!r} back", ids(canary.detect(marked, key))
              == [(mark_id, status)], canary.detect(marked, key))
        check(f"{fid}: the visible text is unchanged",
              marked.replace(ZWSP, "").replace(ZWNJ, "")
              == text.replace(ZWSP, "").replace(ZWNJ, ""))
    one = canary.detect(MARKED_MEMO)[0]
    check("record shape", sorted(one) == ["count", "end", "id", "keyed", "start", "status"], one)
    check("unkeyed frame is 8 * (3 + 5 + 4) carriers", one["end"] - one["start"] == 96, one)
    words = len([w for w in MEMO.split() if w])
    check("a copy every EVERY words", one["count"] == -(-words // canary.EVERY), one)
    k = canary.detect(KEYED_MEMO, KEY)[0]
    check("keyed frame adds 64 bits of tag",
          k["end"] - k["start"] == 8 * (3 + 15 + 8 + 4), k)

    print("\n=== the default clean removes the mark ===")
    for fid, _, text, mark_id, key in EMBED_CASES:
        if fid in ("remark", "existing-zw"):
            continue
        marked = canary.embed(text, mark_id, key)
        check(f"{fid}: clean(embed(text)) == text", default_clean(marked) == text,
              default_clean(marked))
        carriers = sum(m["end"] - m["start"] for m in canary.find_marks(marked))
        before = [h for h in si.find(text) if h[4] == "default"]
        after = [h for h in si.find(marked) if h[4] == "default"]
        check(f"{fid}: every carrier is a default finding",
              carriers and len(after) == len(before) + carriers, (len(before), len(after)))
    check("clean(embed(marked)) == clean(original)",
          default_clean(canary.embed(MARKED_MEMO, "carol")) == MEMO)

    print("\n=== excerpts ===")
    for n in range(canary.EVERY + 1, 25):
        part = excerpt(MARKED_MEMO, n)
        check(f"{n} words from the middle carry the id",
              ids(canary.detect(part)) == [("alice", "unkeyed")], canary.detect(part))
    tail = MARKED_MEMO[-60:]
    check("a short tail with no whole mark reports nothing", canary.detect(tail) == [])

    print("\n=== checksum rejects damage ===")
    for bit in range(96):
        got = canary.detect(flip_one(MARKED_MEMO, 0, bit))
        if ids(got) != [("alice", "unkeyed")] or got[0]["count"] != one["count"] - 1:
            check(f"flipped bit {bit} drops that copy and nothing else", False, got)
            break
    else:
        check("each of the 96 single-bit flips drops that copy and nothing else", True)
    check("a missing carrier drops that copy",
          canary.detect(drop_one(MARKED_MEMO))[0]["count"] == one["count"] - 1)
    damaged = damage_all(MARKED_MEMO)
    check("every copy damaged: nothing", canary.detect(damaged) == [], canary.detect(damaged))
    noise = "".join(ZWSP if (i * 7919) % 3 else ZWNJ for i in range(96))
    check("noise of the right length is not a mark", canary.detect("a " + noise + "b") == [])
    run = canary.mark_chars(canary.frame("alice"))
    check("a mark run with one extra carrier is not a mark",
          canary.detect("a " + run + ZWSP + "b") == [])
    check("a mark run next to a ZWJ still reads",
          ids(canary.detect("a " + run + ZWJ + "b")) == [("alice", "unkeyed")])

    print("\n=== keyed marks ===")
    check("no key: unverified", ids(canary.detect(KEYED_MEMO)) == [("bob@example.com", "unverified")])
    check("right key: verified",
          ids(canary.detect(KEYED_MEMO, KEY)) == [("bob@example.com", "verified")])
    check("bytes key equals str key",
          ids(canary.detect(KEYED_MEMO, KEY.encode())) == [("bob@example.com", "verified")])
    check("wrong key: rejected",
          ids(canary.detect(KEYED_MEMO, "nope")) == [("bob@example.com", "rejected")])
    check("forged tag: rejected",
          ids(canary.detect(forged(MEMO, "mallory"), KEY)) == [("mallory", "rejected")])
    check("an unkeyed mark naming someone stays unkeyed under a key",
          ids(canary.detect(canary.embed(MEMO, "bob@example.com"), KEY))
          == [("bob@example.com", "unkeyed")])
    for bad in ("", b""):
        try:
            canary.embed(MEMO, "a", key=bad)
            check("an empty key is refused", False)
        except ValueError:
            check("an empty key is refused", True)

    print("\n=== ids ===")
    for mark_id in ID_CASES:
        error = canary.id_error(mark_id)
        if error is None:
            check(f"{mark_id!r} round-trips",
                  ids(canary.detect(canary.embed("a b", mark_id))) == [(mark_id, "unkeyed")])
        else:
            try:
                canary.embed("a b", mark_id)
                check(f"{mark_id!r} refused", False)
            except ValueError as e:
                check(f"{mark_id!r} refused: {error}", str(e) == error)
    for text in ("", "   \n\t "):
        try:
            canary.embed(text, "a")
            check(f"{text!r} cannot be marked", False)
        except ValueError:
            check(f"{text!r} cannot be marked", True)

    print("\n=== decode reports the mark ===")
    got = dp.decode(MARKED_MEMO)
    check("one canary record per copy, each with the id",
          [(r["scheme"], r["text"]) for r in got] == [("canary", "alice")] * one["count"], got)
    check("canary hex is the frame", got[0]["hex"] == canary.frame("alice").hex(), got[0])
    got = dp.decode(KEYED_MEMO)
    check("keyed mark is a fingerprint",
          {(r["scheme"], r["text"], r["confidence"]) for r in got}
          == {("canary", None, "fingerprint")}, got)
    got = dp.decode(flip_one("a " + run + "b"))
    check("a damaged mark falls back to zero-width binary",
          [r["scheme"] for r in got] == ["zero-width-binary"], got)

    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
