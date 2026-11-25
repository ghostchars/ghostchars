import subprocess, sys, os, tempfile
import os
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "strip_invisible.py")

def run(flags, text=None, files=()):
    p = subprocess.run([sys.executable, S, *flags, *files],
                       input=None if text is None else text.encode(), capture_output=True)
    return p.returncode, p.stdout.decode(), p.stderr.decode()

fails = []
def check(desc, cond, got=""):
    print(("  ok  " if cond else " FAIL ") + desc + ("" if cond else f"   got={got!r}"))
    if not cond: fails.append(desc)

def eq(desc, flags, inp, want):
    _, o, _ = run(flags, inp); check(desc, o == want, o)

print("=== the format controls stripped by default ===")
for cp in [0x200B,0x2060,0x00AD,0x2061,0x2062,0x2063,0x2064,0x202A,0x202B,0x202C,0x202D,0x202E,0xFEFF]:
    eq(f"U+{cp:04X} stripped by default", [], "A"+chr(cp)+"B", "AB")
for cp in [0x200E,0x200F]:
    eq(f"U+{cp:04X} in Latin text stripped by default", [], "A"+chr(cp)+"B", "AB")
for cp in [0x200C,0x200D]:
    eq(f"U+{cp:04X} free-floating between Latin stripped by DEFAULT", [], "A"+chr(cp)+"B", "AB")
for cp,fl in [(0x00A0,"-s"),(0x202F,"-s"),(0x205F,"-s"),(0x3000,"-s")]:
    eq(f"U+{cp:04X} kept by default", [], "A"+chr(cp)+"B", "A"+chr(cp)+"B")
    eq(f"U+{cp:04X} -> space with -s", [fl], "A"+chr(cp)+"B", "A B")
for cp in [0x2028,0x2029,0x0085]:
    eq(f"U+{cp:04X} kept by default", [], "A"+chr(cp)+"B", "A"+chr(cp)+"B")
    eq(f"U+{cp:04X} -> LF with -n", ["-n"], "A"+chr(cp)+"B", "A\nB")
eq("CRLF preserved by default", [], "a\r\nb", "a\r\nb")
eq("CRLF folded with -n", ["-n"], "a\r\nb", "a\nb")
eq("LF survives", ["-n"], "a\nb", "a\nb")

print("\n=== context-aware glue ===")
fam = "\U0001f468‍\U0001f469‍\U0001f467"
eq("family emoji intact by default", [], fam, fam)
eq("family emoji broken with -a", ["-a"], fam, "\U0001f468\U0001f469\U0001f467")
heart_fire = "❤️‍\U0001f525"
eq("heart-on-fire (VS16 + ZWJ chain) intact", [], heart_fire, heart_fire)
eq("red heart VS16 intact", [], "❤️", "❤️")
eq("keycap 1 intact", [], "1️⃣", "1️⃣")
eq("free VS16 after Latin stripped", [], "A️B", "AB")
persian = "می‌روم"  # می‌روم
eq("Persian ZWNJ intact", [], persian, persian)
eq("Persian ZWNJ stripped with -a", ["-a"], persian, persian.replace("‌",""))
deva = "क्‍ष"  # क्‍ष
eq("Devanagari ZWJ intact", [], deva, deva)
scot = "\U0001f3f4\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f"
eq("Scotland flag intact", [], scot, scot)
eq("Scotland flag stripped to plain flag with -a", ["-a"], scot, "\U0001f3f4")
eq("free tag chars (ASCII smuggling) stripped", [], "A\U000e0048\U000e0069B", "AB")
eq("incomplete flag sequence stripped", [], "\U0001f3f4\U000e0067A", "\U0001f3f4A")
eq("Khmer inherent vowel after Khmer letter kept", [], "ក឴", "ក឴")
eq("Khmer inherent vowel after Latin stripped", [], "A឴B", "AB")
eq("Hangul filler after jamo kept", [], "ᄀᅠ", "ᄀᅠ")
eq("Hangul filler after Latin stripped", [], "AᅠB", "AB")
eq("Hangul filler U+3164 (not jamo-context) stripped", [], "AㅤB", "AB")
eq("Mongolian FVS after Mongolian letter kept", [], "ᠠ᠋", "ᠠ᠋")
eq("Mongolian FVS after Latin stripped", [], "A᠋B", "AB")
eq("VS after CJK ideograph kept", [], "辻\U000e0100", "辻\U000e0100")
eq("VS supplement after Latin stripped (stego carrier)", [], "A\U000e0100\U000e0101B", "AB")

print("\n=== bidi ===")
heb = "שלום"
eq("LRM after Hebrew kept by default", [], heb+"‎ (hi)", heb+"‎ (hi)")
eq("LRM after Hebrew stripped with --bidi", ["--bidi"], heb+"‎ (hi)", heb+" (hi)")
eq("RLM before Arabic kept", [], "x ‏م", "x ‏م")
eq("isolate wrapping Arabic kept", [], "⁧م⁩", "⁧م⁩")
eq("RLO always stripped, even next to RTL", [], "‮م", "م")
eq("ALM in Latin stripped", [], "A؜B", "AB")

print("\n=== catch-alls ===")
eq("Cf catch-all: combining grapheme joiner", [], "A͏B", "AB")
eq("Cf catch-all: U+2066-region already; try U+FFFB", [], "A￻B", "AB")
eq("orthographic Arabic number sign kept", [], "؀١", "؀١")
eq("PUA kept by default (icon fonts)", [], "AB", "AB")
eq("PUA stripped with --pua", ["--pua"], "AB", "AB")
eq("BEL kept default", [], "A\x07B", "A\x07B")
eq("BEL stripped --controls", ["--controls"], "A\x07B", "AB")
eq("--controls keeps tab/LF", ["--controls"], "a\tb\nc", "a\tb\nc")
eq("-n beats --controls for NEL", ["--controls","-n"], "A\x85B", "A\nB")

print("\n=== --punct (the em dash thing) ===")
eq("unspaced em dash -> spaced hyphen", ["--punct"], "a—b", "a - b")
eq("spaced em dash -> spaced hyphen, no double space", ["--punct"], "a — b", "a - b")
eq("leading em dash (dialogue) -> hyphen", ["--punct"], "—Hello", "-Hello")
eq("en dash range -> hyphen", ["--punct"], "1990–1995", "1990 - 1995")
eq("curly double quotes", ["--punct"], "“x”", '"x"')
eq("curly single/apostrophe", ["--punct"], "don’t ‘x’", "don't 'x'")
eq("ellipsis", ["--punct"], "wait…", "wait...")
eq("unicode minus / nb hyphen", ["--punct"], "−5 ‑", "-5 -")
eq("em dash preserved WITHOUT --punct", [], "a—b", "a—b")
eq("punct on multi-line", ["--punct"], "a—b\nc — d", "a - b\nc - d")

print("\n=== nfkc / confusables ===")
eq("math bold -> ascii", ["--nfkc"], "".join(chr(0x1D41A+ord(c)-97) for c in "hello"), "hello")
eq("fullwidth -> ascii", ["--nfkc"], "Ｈｉ", "Hi")
eq("cyrillic a kept by default", [], "аpple", "аpple")
eq("cyrillic a -> latin with --confusables", ["--confusables"], "аpple", "apple")
eq("greek omicron -> o", ["--confusables"], "fοo", "foo")
eq("pure-Cyrillic word untouched by --confusables (mixed-script rule)", ["--confusables"], "сор", "сор")
eq("Russian sentence: no look-alike findings at all", [], "Рецепт шарлотки наконец готов", "Рецепт шарлотки наконец готов")
check("Russian sentence yields zero findings", len(__import__('subprocess').run([sys.executable, S, "--show"], input="Рецепт шарлотки наконец готов".encode(), capture_output=True).stdout.decode().splitlines()) == 1)
eq("Cyrillic с inside a Latin brand IS a look-alike", ["--confusables"], "письмо от Miсrosoft", "письмо от Microsoft")
eq("Cyrillic о inside German word IS a look-alike", ["--confusables"], "dein Kоnto", "dein Konto")
eq("Cyrillic О inside digits IS a look-alike", ["--confusables"], "1О0 %", "1O0 %")
eq("ZWSP inside the word cannot hide the look-alike", ["--confusables"], "а\u200bpple", "apple")
eq("punctuation is a word boundary: сор next to Latin word is still Russian", ["--confusables"], "сор, ok", "сор, ok")

print("\n=== mixed-script words: one index, and the whole text at once ===")
sys.path.insert(0, os.path.dirname(S))
import argparse, time
import strip_invisible as si
for desc, text, i, want in [
    ("look-alike a in 'apple' is in a mixed word", "\u0430pple", 0, True),
    ("look-alike inside a pure Cyrillic word is not", "\u0441\u043e\u0440", 1, False),
    ("last letter before a comma, Latin word after it, is not", "\u0441\u043e\u0440, ok", 2, False),
    ("first letter after a space, Latin word before it, is not", "ok \u0430\u0431", 3, False),
    ("letter between a Cyrillic letter and a Latin one is", "\u0431\u0430c", 1, True),
    ("a boundary index sees the word on either side", "\u0430 b", 1, True),
]:
    got = (si.in_mixed_script_word(text, i), si.mixed_script_words(text)[i])
    check(desc, got == (want, want), got)
samples = ["", "\u0430", "\u0430pple \u0441\u043e\u0440, ok", "1\u041e0 %\n\u0430-b",
           "\u043e\u0442 Mi\u0441rosoft", "\u0430\u200bpple", "a b \u0430 . c"]
check("whole-text answers match the per-index answers",
      all(si.mixed_script_words(t) == [si.in_mixed_script_word(t, k) for k in range(len(t))]
          for t in samples))

ap = argparse.ArgumentParser(); si.add_clean_flags(ap)
conf = ap.parse_args(["--confusables"])
for desc, text, want, findings in [
    ("200,000-letter Cyrillic word", "\u0430" * 200000, "\u0430" * 200000, 0),
    ("200,000 look-alikes in one Latin word", "\u0430" * 200000 + "b", "a" * 200000 + "b", 200000),
]:
    t0 = time.perf_counter()
    out = si.clean(text, conf)
    hits = si.find(text)
    took = time.perf_counter() - t0
    check(f"{desc}: clean and find in under 2 s (linear)",
          out == want and len(hits) == findings and took < 2, f"{took:.2f}s, {len(hits)} findings")

print("\n=== --gutters (terminal quote bars) ===")
email = "\u258e Dear Mr Kirch, dear Karolis, dear Tobias,\n\u258e\n\u258e We apologise for the delay.\n"
eq("quote bars kept by default", [], email, email)
eq("the terminal email loses its bars", ["--gutters"], email,
   "Dear Mr Kirch, dear Karolis, dear Tobias,\n\nWe apologise for the delay.\n")
eq("CR stays with its line ending", ["--gutters"], "\u258e a\r\n\u258e b\r\n", "a\r\nb\r\n")
eq("indentation before the bar is kept", ["--gutters"], "  \u2502 x\n\t\u2503 y", "  x\n\ty")
eq("box-drawn table row left alone", ["--gutters"], "\u2502 a \u2502 b \u2502\n", "\u2502 a \u2502 b \u2502\n")
eq("a lone bar line becomes empty", ["--gutters"], "\u258f", "")
eq("bar with no space after", ["--gutters"], "\u258cx\n\u258dy", "x\ny")
eq("only one of two spaces goes", ["--gutters"], "\u2502  two", " two")
eq("a bar mid-line is untouched", ["--gutters"], "mid \u258e bar", "mid \u258e bar")
eq("one bar per line: the inner bar of a mixed quote stays", ["--gutters"],
   "\u2502 \u258e x", "\u258e x")
eq("a lone CR does not end a line", ["--gutters"], "\u258e a\r\u258e b", "\u258e a\r\u258e b")
eq("-n splits it first", ["--gutters", "-n"], "\u258e a\r\u258e b", "a\nb")
eq("--trailing runs after: a bare bar with spaces trails clean", ["--gutters", "--trailing"],
   "\u258e   \nx", "\nx")
eq("without --trailing the extra spaces stay", ["--gutters"], "\u258e   \nx", "  \nx")
eq("--max strips gutters", ["--max"], email,
   "Dear Mr Kirch, dear Karolis, dear Tobias,\n\nWe apologise for the delay.\n")
rc,out,_ = run(["--show"], "\u258e hi\n\u2502 a \u2502 b \u2502\n")
check("--show reports the gutter as needing --gutters, not the table",
      rc == 1 and "gutter" in out and "needs --gutters" in out and "2:" not in out, out)

print("\n=== --show / --check ===")
rc,out,_ = run(["--show"], "a​b‮c"+fam)
check("--show lists contraband", "U+200B" in out and "U+202E" in out, out)
check("--show reports glue as needing -a", "needs -a" in out, out)
check("--show exit 1 dirty", rc == 1, rc)
rc,out,_ = run(["--show"], "clean")
check("--show exit 0 clean", rc == 0 and "clean" in out, out)
rc,out,_ = run(["--check"], "a​b")
check("--check exit 1, no output", rc == 1 and out == "", (rc,out))
rc,out,_ = run(["--check"], "ab")
check("--check exit 0", rc == 0, rc)

print("\n=== files ===")
d = tempfile.mkdtemp()
b = os.path.join(d,"bin"); open(b,"wb").write(b"\xff\xfe\x00")
rc,_,err = run(["-i"], files=[b])
check("binary skipped intact", rc==2 and open(b,"rb").read()==b"\xff\xfe\x00" and "UTF-8" in err, err)
t = os.path.join(d,"t.txt"); open(t,"w",encoding="utf-8",newline="").write("hi​there\r\n")
run(["-i"], files=[t])
check("-i strips, keeps CRLF", open(t,encoding="utf-8",newline="").read()=="hithere\r\n")
run(["-i","-a","-s","-n","--punct"], files=[t]); once=open(t,encoding="utf-8").read()
run(["-i","-a","-s","-n","--punct"], files=[t]); twice=open(t,encoding="utf-8").read()
check("idempotent under all flags", once==twice)

print("\n=== realistic paragraph ===")
para = ("The​ results—which we’ll discuss… — were “clear”. "
        "\U0001f468‍\U0001f469‍\U0001f467 ❤️ "+persian+" "+scot+"‎\n"
        "Se­cond line \U000e0048\U000e0069 hidden.")
_,o,_ = run(["-s","--punct"], para)
want = ("The results - which we'll discuss... - were \"clear\". "
        "\U0001f468‍\U0001f469‍\U0001f467 ❤️ "+persian+" "+scot+"\n"
        "Second line  hidden.")
check("realistic mixed paragraph", o == want, o)

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}"))
