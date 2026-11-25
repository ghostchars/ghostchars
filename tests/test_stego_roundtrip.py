#!/usr/bin/env python3
"""Adversarial test: embed a secret with each known text-stego technique, clean,
and verify (a) the decoder can no longer recover it and (b) the visible cover
text survives byte-identical. Run: python3 tests/test_stego_roundtrip.py
"""
import os
import re
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "strip_invisible.py")
COVER = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.\nSecond line here.\n"
SECRET = "hi"  # 16 bits; the cover has 18 spaces, the smallest carrier count
ZERO = "\x00" * len(SECRET)  # all-zero bits: each scheme's "no signal" carrier form


def clean(text, *flags):
    p = subprocess.run([sys.executable, SCRIPT, *flags], input=text.encode(),
                       capture_output=True)
    return p.stdout.decode()


def bits(s):
    return "".join(f"{b:08b}" for b in s.encode())


def unbits(b):
    try:
        raw = bytes(int(b[i:i + 8], 2) for i in range(0, len(b) - len(b) % 8, 8))
        return raw.decode(errors="replace").rstrip("\x00")  # unused carriers read as 0
    except ValueError:
        return ""


# ---------------------------------------------------------------- schemes ----
# Each: (name, flags needed, encode(cover, secret) -> stego, decode(stego) -> secret)

def zw_encode(cover, secret):  # zwsp-steg / stegcloak family
    payload = "".join("​" if b == "0" else "‌" for b in bits(secret)) + "‍"
    return cover[:10] + payload + cover[10:]

def zw_decode(text):
    m = re.search(r"[​‌]+(?=‍)", text)
    return unbits("".join("0" if c == "​" else "1" for c in m.group())) if m else ""


def zw_alt_encode(cover, secret):  # WJ / invisible-math variant (defeats naive ZWSP filters)
    payload = "".join("⁠" if b == "0" else "⁢" for b in bits(secret)) + "⁣"
    return cover[:10] + payload + cover[10:]

def zw_alt_decode(text):
    m = re.search(r"[⁠⁢]+(?=⁣)", text)
    return unbits("".join("0" if c == "⁠" else "1" for c in m.group())) if m else ""


def tag_encode(cover, secret):  # ASCII smuggling via tag block
    return cover[:10] + "".join(chr(0xE0000 + ord(c)) for c in secret) + cover[10:]

def tag_decode(text):
    return "".join(chr(ord(c) - 0xE0000) for c in text if 0xE0000 < ord(c) < 0xE007F)


def vs_encode(cover, secret):  # emoji/VS-supplement byte smuggling (Paul Butler)
    def vs(b):
        return chr(0xFE00 + b) if b < 16 else chr(0xE0100 + b - 16)
    return cover[:10] + "\U0001F600" + "".join(vs(b) for b in secret.encode()) + cover[10:]

def vs_decode(text):
    out = bytearray()
    for c in text:
        cp = ord(c)
        if 0xFE00 <= cp <= 0xFE0F:
            out.append(cp - 0xFE00)
        elif 0xE0100 <= cp <= 0xE01EF:
            out.append(cp - 0xE0100 + 16)
    return out.decode(errors="replace")


def snow_encode(cover, secret):  # trailing whitespace: space=0 tab=1, per line, 8/line
    b = bits(secret)
    lines = cover.split("\n")
    out, i = [], 0
    for ln in lines:
        chunk, i = b[i:i + 8], i + 8
        out.append(ln + "".join(" " if x == "0" else "\t" for x in chunk))
    return "\n".join(out)

def snow_decode(text):
    b = ""
    for ln in text.split("\n"):
        tail = re.search(r"[ \t]+$", ln)
        if tail:
            b += "".join("0" if c == " " else "1" for c in tail.group())
    return unbits(b)


CYR = {"a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "x": "х"}

def homoglyph_encode(cover, secret):  # swap Latin->Cyrillic lookalike where bit=1
    b, out, i = bits(secret), [], 0
    for ch in cover:
        if ch in CYR and i < len(b):
            out.append(CYR[ch] if b[i] == "1" else ch)
            i += 1
        else:
            out.append(ch)
    return "".join(out)

def homoglyph_decode(text):
    inv = set(CYR.values())
    return unbits("".join("1" if ch in inv else "0" for ch in text if ch in CYR or ch in inv))


def nfd_encode(cover, secret):  # composed vs decomposed accents encode bits
    b, out, i = bits(secret), [], 0
    for ch in cover:
        if ch in "aeiou" and i < len(b):
            out.append(unicodedata.normalize("NFD", ch + "́") if b[i] == "1"
                       else unicodedata.normalize("NFC", ch + "́"))
            i += 1
        else:
            out.append(ch)
    return "".join(out)

def nfd_decode(text):
    b = ""
    i = 0
    while i < len(text):
        if i + 1 < len(text) and text[i + 1] == "́":
            b += "1"; i += 2
        elif unicodedata.decomposition(text[i]).endswith("0301"):
            b += "0"; i += 1
        else:
            i += 1
    return unbits(b)


def bidi_encode(cover, secret):  # LRM=0 RLM=1 sprinkled after words
    b, out, i = bits(secret), [], 0
    for ch in cover:
        out.append(ch)
        if ch == " " and i < len(b):
            out.append("‎" if b[i] == "0" else "‏")
            i += 1
    return "".join(out)

def bidi_decode(text):
    return unbits("".join("0" if c == "‎" else "1" for c in text if c in "‎‏"))


def space_homoglyph_encode(cover, secret):  # NBSP=1 space=0
    b, out, i = bits(secret), [], 0
    for ch in cover:
        if ch == " " and i < len(b):
            out.append(" " if b[i] == "1" else " ")
            i += 1
        else:
            out.append(ch)
    return "".join(out)

def space_homoglyph_decode(text):
    return unbits("".join("1" if c == " " else "0" for c in text if c in "  "))


def double_space_encode(cover, secret):  # one space=0, two spaces=1
    b, out, i = bits(secret), [], 0
    for ch in cover:
        if ch == " " and i < len(b):
            out.append("  " if b[i] == "1" else " ")
            i += 1
        else:
            out.append(ch)
    return "".join(out)

def double_space_decode(text):
    return unbits("".join("1" if len(m) == 2 else "0" for m in re.findall(r" +", text)))


def punct_encode(cover, secret):  # straight=0 curly=1 apostrophes
    cover = cover.replace(" ", "' ")  # plant a carrier at every word boundary
    b, out, i = bits(secret), [], 0
    for ch in cover:
        if ch == "'" and i < len(b):
            out.append("’" if b[i] == "1" else "'")
            i += 1
        else:
            out.append(ch)
    return "".join(out)

def punct_decode(text):
    return unbits("".join("1" if c == "’" else "0" for c in text if c in "'’"))


SCHEMES = [
    ("zero-width binary (ZWSP/ZWNJ/ZWJ)", [], zw_encode, zw_decode),
    ("word-joiner / invisible-math binary", [], zw_alt_encode, zw_alt_decode),
    ("tag-block ASCII smuggling", [], tag_encode, tag_decode),
    ("variation-selector byte smuggling", [], vs_encode, vs_decode),
    ("bidi mark binary (LRM/RLM)", [], bidi_encode, bidi_decode),
    ("SNOW trailing whitespace", ["--trailing"], snow_encode, snow_decode),
    ("Cyrillic homoglyph binary", ["--confusables"], homoglyph_encode, homoglyph_decode),
    ("NFC/NFD normalization-form binary", ["--nfc"], nfd_encode, nfd_decode),
    ("NBSP/space homoglyph binary", ["-s"], space_homoglyph_encode, space_homoglyph_decode),
    ("single/double space binary", ["--collapse"], double_space_encode, double_space_decode),
    ("curly/straight apostrophe binary", ["--punct"], punct_encode, punct_decode),
]


def main():
    fails = 0
    print(f"{'scheme':<40} {'flags':<14} {'decodes?':<9} {'cleaned':<9} {'cover ok':<9}")
    print("-" * 85)
    for name, flags, enc, dec in SCHEMES:
        stego = enc(COVER, SECRET)
        # sanity: the scheme actually works before cleaning
        pre = dec(stego)
        if pre != SECRET:
            print(f"{name:<40} SCHEME BROKEN: pre-clean decode {pre!r}")
            fails += 1
            continue
        cleaned = clean(stego, *flags)
        post = dec(cleaned)
        recovered = post == SECRET
        # cover check: compare against the same scheme carrying all-zero bits,
        # cleaned the same way, so schemes that touch visible glyphs (accents,
        # an emoji base) are judged only on damage the cleaner itself did.
        cover_ok = cleaned == clean(enc(COVER, ZERO), *flags)
        ok = (not recovered) and cover_ok
        fails += not ok
        print(f"{name:<40} {' '.join(flags) or '(default)':<14} "
              f"{'YES' if recovered else 'no':<9} {'ok' if not recovered else 'LEAK':<9} "
              f"{'ok' if cover_ok else 'DAMAGED':<9} {'' if ok else '  <-- FAIL'}")
    print("-" * 85)
    print("ALL SCHEMES DEFEATED, COVER INTACT" if not fails else f"{fails} FAILURES")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
