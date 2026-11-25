#!/usr/bin/env python3
"""Generate, and verify, the Unicode property tables in `web/src/engine/tables.ts`.

JavaScript has no `unicodedata`, so the three property lookups
`strip_invisible.classify()` makes -- `category()`, `bidirectional()` and the
`category[0] in "LM"` / `== "L"` tests inside `joining_script()` /
`is_letter_in()` -- have to travel to the browser as data. This script prints
them as compact sorted `[lo, hi]` range pairs, generated from the SAME
`unicodedata` (and therefore the same UCD version) that `tools/gen_golden.py`
used to build the parity fixtures.

    python3 tools/gen_unicode_tables.py            # print the TypeScript block
    python3 tools/gen_unicode_tables.py --check    # exit 1 if tables.ts is stale
    python3 tools/gen_unicode_tables.py --swift    # print the Swift source for a native port

`--check` compares the RANGE DATA, not the text: a byte diff on the block that
lives in `tables.ts` would flap on line wrapping while telling you nothing.
What must not drift is the numbers and the
UCD version -- and `TABLES_UNICODE_VERSION` is asserted equal to `golden.json`'s
`meta.unicodeVersion` by `src/engine/__tests__/parity.test.ts`, so a Python that
ships a different UCD fails the whole suite rather than silently re-deriving
different tables.

Regenerating by hand: run without arguments and paste the output over the block
between the `generated (Unicode NN)` and `end generated` markers in
`web/src/engine/tables.ts`; the pasted block needs no reformatting.

`--swift` prints the same five tables as a standalone Swift source for a
native port, regenerated straight from the SAME `build()` this module uses
for the TS block and the `--check` gate, so the two outputs cannot
independently drift from `unicodedata`.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys
import unicodedata

MAX = 0x110000
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLES_TS = REPO_ROOT / "web" / "src" / "engine" / "tables.ts"


def ranges(pred, lo=0, hi=MAX):
    out = []
    start = None
    for cp in range(lo, hi):
        if pred(cp):
            if start is None:
                start = cp
        elif start is not None:
            out.append((start, cp - 1))
            start = None
    if start is not None:
        out.append((start, hi - 1))
    return out


cat = unicodedata.category
bidi = unicodedata.bidirectional

JOINING_BLOCKS = [
    (0x0600, 0x08FF),
    (0x0900, 0x0DFF),
    (0x0F00, 0x109F),
    (0x1780, 0x17FF),
    (0x1800, 0x18AF),
    (0xFB50, 0xFDFF),
    (0xFE70, 0xFEFF),
]


def build():
    """name -> (doc, ranges), in the order they appear in tables.ts."""
    joining = []
    for lo, hi in JOINING_BLOCKS:
        joining += ranges(lambda cp: cat(chr(cp))[0] in "LM", lo, hi + 1)
    return {
        "CF_RANGES": (
            "General_Category=Cf. `classify` uses it as the catch-all for unlisted format controls.",
            ranges(lambda cp: cat(chr(cp)) == "Cf"),
        ),
        "CO_RANGES": (
            "General_Category=Co (the three private-use areas).",
            ranges(lambda cp: cat(chr(cp)) == "Co"),
        ),
        "RTL_RANGES": (
            "Bidi_Class in {R, AL, AN} -- `is_rtl` in the Python.",
            ranges(lambda cp: bidi(chr(cp)) in ("R", "AL", "AN")),
        ),
        "JOINING_LETTER_OR_MARK_RANGES": (
            "General_Category starting with L or M, restricted to the blocks `joining_script` scans.",
            joining,
        ),
        "SCRIPT_LETTER_RANGES": (
            "General_Category L*, restricted to the four blocks `is_letter_in` is called with.",
            ranges(lambda cp: cat(chr(cp))[0] == "L" and (
                0x1780 <= cp < 0x18B0 or 0x13000 <= cp < 0x13430
                or 0x1BC00 <= cp < 0x1BCA0)),
        ),
    }


def emit(tables) -> str:
    out = []
    # Unicode's licence requires its copyright and permission notice to
    # accompany distributions of its data. These ranges are derived from the
    # UCD via CPython's `unicodedata`, and `tables.ts` ships to every visitor's
    # browser, so the notice is emitted into the file rather than kept in a
    # standalone NOTICE that a regeneration could leave behind.
    out.append("// Derived from the Unicode Character Database, via Python's unicodedata.")
    out.append("// Copyright (c) 1991-2024 Unicode, Inc. All rights reserved.")
    out.append("// Distributed under the Unicode License v3: https://www.unicode.org/license.txt")
    out.append("")
    out.append("/**")
    out.append(" * The UCD version these tables were generated from.")
    out.append(" *")
    out.append(" * `golden.json`'s `meta.unicodeVersion` must agree; the parity test asserts it.")
    out.append(" * If Python moves to a newer UCD, regenerate this file and the fixtures together.")
    out.append(" */")
    out.append(f"export const TABLES_UNICODE_VERSION = '{unicodedata.unidata_version}'")
    out.append("")
    for name, (doc, rs) in tables.items():
        out.append(f"/** {doc} */")
        out.append(f"export const {name}: readonly Range[] = [")
        line = " "
        for lo, hi in rs:
            piece = f" [0x{lo:04X}, 0x{hi:04X}],"
            if len(line) + len(piece) > 96:
                out.append(line)
                line = " "
            line += piece
        if line.strip():
            out.append(line)
        out.append("]")
        out.append("")
    return "\n".join(out)


def swift_name(name: str) -> str:
    """`CF_RANGES` -> `cfRanges`: the TS constant name, lowerCamelCased for Swift."""
    first, *rest = name.split("_")
    return first.lower() + "".join(part.capitalize() for part in rest)


def emit_swift(tables) -> str:
    out = []
    # Same Unicode licence obligation as the TS output (see `emit`) -- the
    # notice travels with every distribution of the derived data, Swift build
    # included.
    out.append("// Derived from the Unicode Character Database, via Python's unicodedata.")
    out.append("// Copyright (c) 1991-2024 Unicode, Inc. All rights reserved.")
    out.append("// Distributed under the Unicode License v3: https://www.unicode.org/license.txt")
    out.append("//")
    out.append("// Generated by `tools/gen_unicode_tables.py --swift`. Do not edit.")
    out.append("// Mirrors the UCD-derived tables in web/src/engine/tables.ts: same")
    out.append("// `unicodedata` snapshot, same ranges; regenerate both together if the")
    out.append("// UCD version moves.")
    out.append("")
    out.append("/// Inclusive codepoint range, `lo...hi`.")
    out.append("public typealias CPRange = ClosedRange<UInt32>")
    out.append("")
    out.append("/// UCD-derived range tables consulted by `classify()`. See the Python")
    out.append("/// docstrings in `tools/gen_unicode_tables.py` for what each one means.")
    out.append("public enum Tables {")
    out.append("    /// The UCD version these tables were generated from.")
    out.append("    ///")
    out.append("    /// Must equal `TABLES_UNICODE_VERSION` in `web/src/engine/tables.ts`.")
    out.append(f'    public static let unicodeVersion = "{unicodedata.unidata_version}"')
    out.append("")
    for name, (doc, rs) in tables.items():
        out.append(f"    /// {doc}")
        out.append(f"    public static let {swift_name(name)}: [CPRange] = [")
        line = "        "
        for lo, hi in rs:
            piece = f"0x{lo:04X}...0x{hi:04X}, "
            if len(line) + len(piece) > 96:
                out.append(line.rstrip())
                line = "        "
            line += piece
        if line.strip():
            out.append(line.rstrip())
        out.append("    ]")
        out.append("")
    out.append("}")
    return "\n".join(out)


def parse_committed(source: str):
    """Pull the committed version string and range tables back out of tables.ts."""
    version = re.search(r"TABLES_UNICODE_VERSION\s*=\s*'([^']+)'", source)
    found = {}
    for match in re.finditer(
        r"export const (\w+): readonly Range\[\] = \[(.*?)\n\]", source, re.S
    ):
        pairs = re.findall(r"\[\s*(0x[0-9A-Fa-f]+)\s*,\s*(0x[0-9A-Fa-f]+)\s*\]", match.group(2))
        found[match.group(1)] = [(int(lo, 16), int(hi, 16)) for lo, hi in pairs]
    return (version.group(1) if version else None), found


def check() -> int:
    if not TABLES_TS.is_file():
        print(f"missing: {TABLES_TS}", file=sys.stderr)
        return 1
    version, committed = parse_committed(TABLES_TS.read_text(encoding="utf-8"))
    problems = []
    if version != unicodedata.unidata_version:
        problems.append(
            f"TABLES_UNICODE_VERSION is {version!r}, this Python has {unicodedata.unidata_version!r}"
        )
    for name, (_doc, expected) in build().items():
        actual = committed.get(name)
        if actual is None:
            problems.append(f"{name}: absent from tables.ts")
        elif actual != expected:
            problems.append(f"{name}: {len(actual)} committed ranges != {len(expected)} generated")
    if problems:
        print("web/src/engine/tables.ts is STALE:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nRegenerate: python3 tools/gen_unicode_tables.py",
            file=sys.stderr,
        )
        return 1
    print(
        f"tables.ts is current for Unicode {unicodedata.unidata_version} "
        f"({sum(len(rs) for _d, rs in build().values())} ranges across {len(build())} tables)"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify web/src/engine/tables.ts instead of printing (exit 1 if stale)",
    )
    parser.add_argument(
        "--swift",
        action="store_true",
        help="print the Swift source for a native port instead of the TS block",
    )
    args = parser.parse_args()
    if args.check and args.swift:
        parser.error("--check and --swift are mutually exclusive")
    if args.check:
        return check()
    print((emit_swift if args.swift else emit)(build()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
