"""The one measurement the text gate and the CLI's parity test share.

`changed_chars(before, after)` lists every character of `before` that a clean
would delete or replace, with its line number. `cli/test/parity.gate.test.ts`
imports it to prove the TypeScript engine counts the same characters the
Python reference does, and it lives here beside the other parity tooling.
"""
from __future__ import annotations

import difflib

def changed_chars(before: str, after: str) -> list[tuple[int, str]]:
    """Every character of `before` the clean would delete or replace, with its line.

    Line-aligned on purpose. Neither the default pass nor `-s --punct` ever adds
    or removes a newline, so the two texts have the same line count and a diff
    per line is exact. It is also the difference between a gate that finishes in
    seconds and one that does not: a whole-file character diff of a 2000-line
    catalogue is quadratic and takes minutes. The whole-file fallback stays for
    the day some future pass does move a line break, so the gate degrades to
    slow rather than to wrong.
    """
    before_lines, after_lines = before.split('\n'), after.split('\n')
    if len(before_lines) != len(after_lines):
        hits = []
        matcher = difflib.SequenceMatcher(a=before, b=after, autojunk=False)
        for tag, i1, i2, _j1, _j2 in matcher.get_opcodes():
            if tag != 'equal':
                hits.extend((before.count('\n', 0, i) + 1, before[i]) for i in range(i1, i2))
        return hits

    hits = []
    for number, (b, a) in enumerate(zip(before_lines, after_lines), start=1):
        if b == a:
            continue
        matcher = difflib.SequenceMatcher(a=b, b=a, autojunk=False)
        for tag, i1, i2, _j1, _j2 in matcher.get_opcodes():
            if tag != 'equal':
                hits.extend((number, b[i]) for i in range(i1, i2))
    return hits
