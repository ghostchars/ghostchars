#!/usr/bin/env python3
"""Clean hidden characters inside documents, not just plain text.

Formats: .txt .md .markdown .html .htm .docx .odt  (stdlib only, no server)

    clean_file.py --show report.docx            # what is hiding, incl. document-level
    clean_file.py -i --metadata --rsids x.docx   # clean text, blank metadata, drop rsids
    clean_file.py -s --punct essay.docx          # writes essay.clean.docx

Text inside the document goes through the same context-aware cleaner as
strip_invisible.py, with the same flags. On top of that, documents get an
inspection of the things that hide *around* the text: invisible runs, comments,
tracked changes, authoring metadata, and Word's per-session rsid fingerprints.
"""
import argparse
import html
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from xml.sax.saxutils import escape as xml_escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decode_payloads  # noqa: E402
import strip_invisible as si  # noqa: E402

TEXT_EXT = {".txt", ".md", ".markdown"}
HTML_EXT = {".html", ".htm"}
DOCX_EXT = {".docx"}
ODT_EXT = {".odt"}
SUPPORTED = TEXT_EXT | HTML_EXT | DOCX_EXT | ODT_EXT

# ------------------------------------------------------------- reporting ----

def summarize_hits(text):
    """Counter of (kind, flag) and Counter of codepoints for one text blob."""
    hits = si.find(text)
    return Counter((k, f) for _, _, _, k, f in hits), Counter(cp for _, _, cp, _, _ in hits)


def print_char_summary(label, by_kind, by_cp, indent="  "):
    total = sum(by_kind.values())
    if not total:
        print(f"{indent}{label}: clean")
        return
    print(f"{indent}{label}: {total} suspicious characters")
    for (kind, flag), n in sorted(by_kind.items(), key=lambda x: -x[1]):
        note = "" if flag == "default" else f"(needs {flag})"
        print(f"{indent}  {n:>5}  {kind:<16} {note}")
    for cp, n in by_cp.most_common(8):
        print(f"{indent}         U+{cp:04X} ×{n}  {unicodedata.name(chr(cp), '<unnamed>')}")


def print_payloads(text, indent="    "):
    """The hidden-message block of decode_payloads, under the text summary."""
    for line in decode_payloads.payload_lines(text, indent=indent):
        print(line)


# ---------------------------------------------------------- XML text pass ----

# XML text is entity-escaped, and a hidden character may arrive either literal
# or as &#8203;, so every text node is unescaped, cleaned, and re-escaped.
def clean_xml_text_nodes(xml, args, node_re):
    changed = 0

    def sub(m):
        nonlocal changed
        raw = m.group("text")
        text = html.unescape(raw)
        cleaned = si.clean(text, args)
        if cleaned == text:
            return m.group(0)
        changed += 1
        out = xml_escape(cleaned)
        open_tag = m.group("open")
        # Word drops edge whitespace unless xml:space="preserve" is present.
        if open_tag is not None and cleaned != cleaned.strip() and "xml:space" not in open_tag:
            open_tag = open_tag[:-1] + ' xml:space="preserve">'
        return (open_tag or "") + out + (m.group("close") or "")

    return node_re.sub(sub, xml), changed


def find_xml_text(xml, node_re):
    return "".join(html.unescape(m.group("text")) for m in node_re.finditer(xml))


# ------------------------------------------------------------------ DOCX ----

W_T_RE = re.compile(r"(?P<open><w:t(?:\s[^>]*)?>)(?P<text>[^<]*)(?P<close></w:t>)")
DOCX_TEXT_PARTS = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$")
RSID_ATTR_RE = re.compile(r'\s+w:rsid(?:R|RPr|RDefault|Del|P|Sect|Tr)?="[0-9A-Fa-f]{8}"')
RSIDS_BLOCK_RE = re.compile(r"<w:rsids>.*?</w:rsids>|<w:rsids/>", re.S)
VANISH_RE = re.compile(r'<w:vanish(?:\s+w:val="(?:true|1|on)")?\s*/>')
WHITE_RE = re.compile(r'<w:color\s+w:val="(?:FFFFFF|ffffff)"[^>]*/>')
TINY_RE = re.compile(r'<w:sz\s+w:val="([0-9]+)"')  # half-points

CORE_FIELDS = ("dc:creator", "cp:lastModifiedBy", "cp:revision", "dcterms:created",
               "dcterms:modified", "cp:lastPrinted", "dc:description", "cp:keywords",
               "cp:category", "cp:contentStatus")
APP_FIELDS = ("Application", "AppVersion", "Company", "Manager", "TotalTime", "Template",
              "HyperlinkBase", "DocSecurity")


def _tag_text(xml, tag):
    m = re.search(rf"<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>", xml)
    return html.unescape(m.group(1)) if m else None


def _blank_tags(xml, tags):
    for tag in tags:
        xml = re.sub(rf"<{tag}(\s[^>]*)?>[^<]*</{tag}>",
                     lambda m: f"<{tag}{m.group(1) or ''}></{tag}>", xml)
    return xml


def inspect_docx(zf):
    names = zf.namelist()
    rep = {}
    doc = zf.read("word/document.xml").decode("utf-8", "replace") if "word/document.xml" in names else ""
    rep["hidden_runs"] = len(VANISH_RE.findall(doc))
    rep["white_text_runs"] = len(WHITE_RE.findall(doc))
    rep["tiny_text_runs"] = sum(1 for m in TINY_RE.finditer(doc) if int(m.group(1)) <= 4)
    rep["tracked_ins"] = doc.count("<w:ins ")
    rep["tracked_del"] = doc.count("<w:del ")
    rep["comments"] = (zf.read("word/comments.xml").decode("utf-8", "replace").count("<w:comment ")
                       if "word/comments.xml" in names else 0)
    rsids = set(m.group(0).split('"')[1] for m in RSID_ATTR_RE.finditer(doc))
    settings = zf.read("word/settings.xml").decode("utf-8", "replace") if "word/settings.xml" in names else ""
    rsids |= set(re.findall(r'<w:rsid\s+w:val="([0-9A-Fa-f]{8})"', settings))
    rep["rsids"] = len(rsids)
    core = zf.read("docProps/core.xml").decode("utf-8", "replace") if "docProps/core.xml" in names else ""
    app = zf.read("docProps/app.xml").decode("utf-8", "replace") if "docProps/app.xml" in names else ""
    rep["metadata"] = {t: _tag_text(core, t) for t in CORE_FIELDS if _tag_text(core, t)}
    rep["metadata"].update({t: _tag_text(app, t) for t in APP_FIELDS if _tag_text(app, t)})
    rep["custom_props"] = "docProps/custom.xml" in names
    rep["macros"] = any(n.startswith("word/vbaProject") for n in names)
    rep["media"] = sum(1 for n in names if n.startswith("word/media/"))
    rep["embeddings"] = sum(1 for n in names if n.startswith("word/embeddings/"))
    return rep


def print_docx_report(rep):
    print("  document:")
    flags = [
        ("hidden text runs (w:vanish)", rep["hidden_runs"]),
        ("white-on-white runs", rep["white_text_runs"]),
        ("tiny (≤2pt) runs", rep["tiny_text_runs"]),
        ("tracked insertions", rep["tracked_ins"]),
        ("tracked deletions", rep["tracked_del"]),
        ("comments", rep["comments"]),
        ("distinct rsid session ids", rep["rsids"]),
        ("media files", rep["media"]),
        ("embedded objects", rep["embeddings"]),
    ]
    for label, n in flags:
        if n:
            print(f"    {n:>5}  {label}")
    if rep["macros"]:
        print("    macros present (vbaProject)")
    if rep["custom_props"]:
        print("    custom properties part present")
    if rep["metadata"]:
        print("    metadata:")
        for k, v in rep["metadata"].items():
            print(f"      {k:<20} {v}")
    if rep["rsids"] <= 2 and rep["rsids"]:
        print("    note: 1 to 2 rsids across the whole document = pasted in one session")


def clean_docx(zf_in, out_path, args):
    """Rewrite a docx with cleaned text (and optionally metadata/rsids)."""
    changed_nodes = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zf_in.infolist():
            data = zf_in.read(item.filename)
            name = item.filename
            if DOCX_TEXT_PARTS.match(name):
                xml = data.decode("utf-8")
                xml, n = clean_xml_text_nodes(xml, args, W_T_RE)
                changed_nodes += n
                if args.rsids:
                    xml = RSID_ATTR_RE.sub("", xml)
                data = xml.encode("utf-8")
            elif name == "word/settings.xml" and args.rsids:
                data = RSIDS_BLOCK_RE.sub("", data.decode("utf-8")).encode("utf-8")
            elif name == "docProps/core.xml" and args.metadata:
                data = _blank_tags(data.decode("utf-8"), CORE_FIELDS).encode("utf-8")
            elif name == "docProps/app.xml" and args.metadata:
                data = _blank_tags(data.decode("utf-8"), APP_FIELDS).encode("utf-8")
            elif name == "docProps/custom.xml" and args.metadata:
                continue  # dropped; the dangling rel/override is tolerated by Word
            zout.writestr(item, data)
    return changed_nodes


# ------------------------------------------------------------------- ODT ----

# ODT keeps text directly inside <text:p>, <text:span>, <text:h>, <text:a>...;
# cleaning every text node of content.xml is safe because attributes are untouched.
ODT_NODE_RE = re.compile(r"(?P<open>>)(?P<text>[^<]+)(?P<close><)")
ODT_META_FIELDS = ("meta:initial-creator", "dc:creator", "meta:generator", "meta:editing-cycles",
                   "meta:editing-duration", "meta:creation-date", "dc:date", "meta:printed-by",
                   "meta:print-date", "dc:description", "meta:keyword")


def inspect_odt(zf):
    names = zf.namelist()
    rep = {}
    content = zf.read("content.xml").decode("utf-8", "replace") if "content.xml" in names else ""
    rep["tracked_changes"] = content.count("<text:changed-region")
    rep["annotations"] = content.count("<office:annotation")
    rep["hidden_text_styles"] = content.count('text:display="none"')
    meta = zf.read("meta.xml").decode("utf-8", "replace") if "meta.xml" in names else ""
    rep["metadata"] = {t: _tag_text(meta, t) for t in ODT_META_FIELDS if _tag_text(meta, t)}
    rep["user_defined"] = meta.count("<meta:user-defined")
    return rep


def print_odt_report(rep):
    print("  document:")
    for label, n in (("tracked-change regions", rep["tracked_changes"]),
                     ("annotations (comments)", rep["annotations"]),
                     ("hidden text styles", rep["hidden_text_styles"]),
                     ("user-defined meta fields", rep["user_defined"])):
        if n:
            print(f"    {n:>5}  {label}")
    if rep["metadata"]:
        print("    metadata:")
        for k, v in rep["metadata"].items():
            print(f"      {k:<22} {v}")


def clean_odt(zf_in, out_path, args):
    changed_nodes = 0
    with zipfile.ZipFile(out_path, "w") as zout:
        # The mimetype entry must be first and stored, or the file is not a valid ODF package.
        zout.writestr(zipfile.ZipInfo("mimetype"), zf_in.read("mimetype"), zipfile.ZIP_STORED)
        for item in zf_in.infolist():
            if item.filename == "mimetype":
                continue
            data = zf_in.read(item.filename)
            if item.filename == "content.xml":
                xml, n = clean_xml_text_nodes(data.decode("utf-8"), args, ODT_NODE_RE)
                changed_nodes += n
                data = xml.encode("utf-8")
            elif item.filename == "meta.xml" and args.metadata:
                xml = _blank_tags(data.decode("utf-8"), ODT_META_FIELDS)
                xml = re.sub(r"<meta:user-defined\b[^>]*>[^<]*</meta:user-defined>", "", xml)
                data = xml.encode("utf-8")
            zout.writestr(item, data, zipfile.ZIP_DEFLATED)
    return changed_nodes


# ------------------------------------------------------------------ HTML ----

HTML_SPLIT_RE = re.compile(r"(<!--.*?-->|<script\b.*?</script>|<style\b.*?</style>|<[^>]+>)",
                           re.S | re.I)
HTML_HIDDEN_RE = re.compile(
    r"<[^>]*(?:\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)"
    r"[^>]*>", re.I)
HTML_HUMAN_ATTR_RE = re.compile(r'\b(?:alt|title|placeholder|aria-label|content)="([^"]*)"', re.I)


def inspect_html(text):
    rep = {"comments": len(re.findall(r"<!--.*?-->", text, re.S)),
           "hidden_elements": len(HTML_HIDDEN_RE.findall(text))}
    m = re.search(r'<meta\s+name="generator"\s+content="([^"]*)"', text, re.I)
    rep["generator"] = html.unescape(m.group(1)) if m else None
    attr_text = "".join(html.unescape(v) for v in HTML_HUMAN_ATTR_RE.findall(text))
    rep["attr_hits"] = len(si.find(attr_text))
    return rep


def print_html_report(rep):
    print("  document:")
    for label, n in (("HTML comments", rep["comments"]),
                     ("hidden/invisible elements", rep["hidden_elements"]),
                     ("suspicious chars in alt/title/aria attributes", rep["attr_hits"])):
        if n:
            print(f"    {n:>5}  {label}")
    if rep["generator"]:
        print(f"    generator meta: {rep['generator']}")


def clean_html(text, args):
    """Clean text nodes only; tags, comments, script and style pass through."""
    parts = HTML_SPLIT_RE.split(text)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1 or not part:
            out.append(part)
            continue
        raw = html.unescape(part)
        cleaned = si.clean(raw, args)
        out.append(part if cleaned == raw else html.escape(cleaned, quote=False))
    return "".join(out)


def html_text(text):
    return "".join(html.unescape(p) for i, p in enumerate(HTML_SPLIT_RE.split(text)) if i % 2 == 0)


# ------------------------------------------------------------------- cli ----

def out_path_for(path, args):
    if args.in_place:
        return path
    if args.output:
        return args.output
    root, ext = os.path.splitext(path)
    return f"{root}.clean{ext}"


def replace_atomic(tmp, dest):
    if os.path.exists(dest):
        shutil.copymode(dest, tmp)
    os.replace(tmp, dest)


def process(path, args):
    """Returns (found_anything, error)."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED:
        print(f"{path}: unsupported type {ext or '(none)'}", file=sys.stderr)
        return False, True

    if ext in DOCX_EXT or ext in ODT_EXT:
        try:
            zf = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            print(f"{path}: not a valid {ext} package", file=sys.stderr)
            return False, True
        with zf:
            is_docx = ext in DOCX_EXT
            names = zf.namelist()
            parts = ([n for n in names if DOCX_TEXT_PARTS.match(n)] if is_docx
                     else ["content.xml"] if "content.xml" in names else [])
            node_re = W_T_RE if is_docx else ODT_NODE_RE
            all_text = "".join(find_xml_text(zf.read(p).decode("utf-8", "replace"), node_re)
                               for p in parts)
            by_kind, by_cp = summarize_hits(all_text)
            rep = inspect_docx(zf) if is_docx else inspect_odt(zf)

            if args.show:
                print(f"{path}:")
                print_char_summary("text", by_kind, by_cp)
                print_payloads(all_text)
                (print_docx_report if is_docx else print_odt_report)(rep)
                return bool(sum(by_kind.values())), False

            would_change = si.clean(all_text, args) != all_text or args.metadata or args.rsids
            if args.check:
                if would_change and args.count:
                    print(f"{path}: would change", file=sys.stderr)
                return would_change, False

            dest = out_path_for(path, args)
            fd, tmp = tempfile.mkstemp(suffix=ext, dir=os.path.dirname(os.path.abspath(dest)))
            os.close(fd)
            try:
                n = (clean_docx if is_docx else clean_odt)(zf, tmp, args)
                replace_atomic(tmp, dest)
            except Exception:
                os.unlink(tmp)
                raise
            if args.count:
                extra = " + metadata" if args.metadata else ""
                extra += " + rsids" if args.rsids else ""
                print(f"{path}: {n} text nodes changed{extra} -> {dest}", file=sys.stderr)
            return would_change, False

    # plain text / html
    text = si.read_text(path)
    if text is None:
        return False, True
    is_html = ext in HTML_EXT
    if args.show:
        shown = html_text(text) if is_html else text
        by_kind, by_cp = summarize_hits(shown)
        print(f"{path}:")
        print_char_summary("text", by_kind, by_cp)
        print_payloads(shown)
        if is_html:
            print_html_report(inspect_html(text))
        return bool(sum(by_kind.values())), False

    cleaned = clean_html(text, args) if is_html else si.clean(text, args)
    changed = cleaned != text
    if args.check:
        if changed and args.count:
            print(f"{path}: would change", file=sys.stderr)
        return changed, False
    dest = out_path_for(path, args)
    if changed or dest != path:
        with open(dest, "w", encoding="utf-8", newline="") as f:
            f.write(cleaned)
    if args.count:
        print(f"{path}: {len(text) - len(cleaned):+d} chars -> {dest}", file=sys.stderr)
    return changed, False


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="+")
    p.add_argument("-i", "--in-place", action="store_true", help="overwrite the input file")
    p.add_argument("-o", "--output", help="output path (single input only)")
    si.add_clean_flags(p)
    p.add_argument("--metadata", action="store_true",
                   help="blank authoring metadata (creator, lastModifiedBy, dates, app, revision)")
    p.add_argument("--rsids", action="store_true",
                   help="docx: remove per-session rsid attributes (editing-history fingerprint)")
    p.add_argument("--show", action="store_true",
                   help="report hidden characters and document-level findings; change nothing")
    p.add_argument("--check", action="store_true",
                   help="exit 1 if anything would be changed; write nothing")
    p.add_argument("-c", "--count", action="store_true", help="report per-file summary to stderr")
    args = si.apply_max(p.parse_args())

    if args.output and len(args.files) > 1:
        p.error("-o works with a single input file")
    if args.output and args.in_place:
        p.error("-o and -i are mutually exclusive")

    found = failed = False
    for path in args.files:
        f, e = process(path, args)
        found |= f
        failed |= e
    if failed:
        return 2
    if (args.show or args.check) and found:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
