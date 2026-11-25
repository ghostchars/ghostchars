#!/usr/bin/env python3
"""clean_file.py: build real DOCX/ODT/HTML/MD fixtures from scratch, clean them,
verify text is cleaned, structure survives, emoji survive, metadata/rsids go only
when asked, and the reports say what they should."""
import os
import re
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "clean_file.py")

ZWSP, ZWJ, TAG_H, TAG_I, CYR_A = "​", "‍", "\U000e0048", "\U000e0069", "а"
FAMILY = "\U0001f468" + ZWJ + "\U0001f469" + ZWJ + "\U0001f467"

fails = []
def check(desc, cond, got=""):
    print(("  ok  " if cond else " FAIL ") + desc + ("" if cond else f"   got={got!r}"))
    if not cond:
        fails.append(desc)

def run(*a, files=()):
    p = subprocess.run([sys.executable, SCRIPT, *a, *files], capture_output=True)
    return p.returncode, p.stdout.decode(), p.stderr.decode()


# ------------------------------------------------------------- fixtures ----

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

def make_docx(path):
    document = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W}><w:body>
<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3"><w:r w:rsidRPr="00D4E5F6"><w:t>He{ZWSP}llo world {FAMILY} {CYR_A}pple</w:t></w:r></w:p>
<w:p w:rsidR="00A1B2C3"><w:r><w:t xml:space="preserve">tag&#8203;smuggle {TAG_H}{TAG_I} here</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>this run is hidden</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/></w:rPr><w:t>white tiny</w:t></w:r></w:p>
<w:p><w:ins w:id="1" w:author="x"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="x"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
<w:p><w:r><w:t>caf&#233; &amp; &lt;tags&gt; stay</w:t></w:r></w:p>
</w:body></w:document>"""
    settings = f'<?xml version="1.0"?><w:settings {W}><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/><w:rsid w:val="00D4E5F6"/></w:rsids><w:zoom w:percent="100"/></w:settings>'
    comments = f'<?xml version="1.0"?><w:comments {W}><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>'
    core = """<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>My Essay</dc:title><dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-08-17T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-08-17T10:05:00Z</dcterms:modified></cp:coreProperties>"""
    app = """<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion><Company>ACME</Company><TotalTime>3</TotalTime><Pages>1</Pages></Properties>"""
    custom = """<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>"""
    ctypes = """<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"""
    rels = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ctypes)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/settings.xml", settings)
        z.writestr("word/comments.xml", comments)
        z.writestr("docProps/core.xml", core)
        z.writestr("docProps/app.xml", app)
        z.writestr("docProps/custom.xml", custom)


def make_odt(path):
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">
<office:automatic-styles><style:style style:name="T1" style:family="text"/></office:automatic-styles>
<office:body><office:text>
<text:p text:style-name="P1">He{ZWSP}llo <text:span text:style-name="T1">wor{ZWSP}ld</text:span> {FAMILY} &amp; &lt;x&gt;</text:p>
<text:p>tag &#8203; ref</text:p>
<office:annotation><text:p>a comment</text:p></office:annotation>
</office:text></office:body></office:document-content>"""
    meta = """<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><meta:generator>LibreOffice/24.8</meta:generator><meta:initial-creator>Jane</meta:initial-creator><dc:creator>Jane</dc:creator><meta:editing-cycles>7</meta:editing-cycles><meta:user-defined meta:name="Info 1">secret</meta:user-defined></office:meta></office:document-meta>"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/vnd.oasis.opendocument.text", zipfile.ZIP_STORED)
        z.writestr("content.xml", content, zipfile.ZIP_DEFLATED)
        z.writestr("meta.xml", meta, zipfile.ZIP_DEFLATED)


def read_zip(path, name):
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode("utf-8")


def xml_ok(s):
    try:
        ET.fromstring(s.encode("utf-8"))
        return True
    except ET.ParseError:
        return False


# ---------------------------------------------------------------- tests ----

d = tempfile.mkdtemp()

print("=== DOCX ===")
docx = os.path.join(d, "essay.docx")
make_docx(docx)

rc, out, _ = run("--show", files=[docx])
check("--show exits 1 (findings present)", rc == 1, rc)
check("--show counts hidden text runs", re.search(r"1\s+hidden text runs", out), out)
check("--show counts white-on-white", re.search(r"1\s+white-on-white", out), out)
check("--show counts tiny runs", re.search(r"1\s+tiny", out), out)
check("--show counts tracked ins/del", "tracked insertions" in out and "tracked deletions" in out, out)
check("--show counts comments", re.search(r"1\s+comments", out), out)
check("--show counts rsids", re.search(r"2\s+distinct rsid", out), out)
check("--show notes single-session paste", "pasted in one session" in out, out)
check("--show lists creator/app metadata", "Jane Doe" in out and "Microsoft Office Word" in out, out)
check("--show reports custom props", "custom properties" in out, out)
check("--show reports the ZWSP/tag/confusable chars", "U+200B" in out and "U+E0048" in out and "U+0430" in out, out)
check("--show reports the ZWJ as glue needing -a", "glue" in out and "needs -a" in out, out)

# default clean → sibling .clean.docx
rc, out, err = run("-c", files=[docx])
cleaned = os.path.join(d, "essay.clean.docx")
check("default writes essay.clean.docx", os.path.exists(cleaned) and rc == 0, (rc, err))
doc = read_zip(cleaned, "word/document.xml")
check("document.xml still well-formed XML", xml_ok(doc))
check("ZWSP inside 'Hello' removed", "He" + ZWSP + "llo" not in doc and "Hello world" in doc, doc[:200])
check("numeric char ref &#8203; removed", "&#8203;" not in doc and "tagsmuggle" in doc, doc)
check("tag chars (ASCII smuggling) removed", TAG_H not in doc and TAG_I not in doc)
check("family emoji intact (ZWJ kept)", FAMILY in doc)
check("Cyrillic а kept without --confusables", CYR_A + "pple" in doc)
check("entities re-escaped correctly", "&amp; &lt;tags&gt;" in doc, doc)
check("café literal or ref preserved", "café" in doc or "&#233;" in doc, doc)
check("hidden run text still present (report-only)", "this run is hidden" in doc)
check("metadata untouched without --metadata", "Jane Doe" in read_zip(cleaned, "docProps/core.xml"))
check("rsids untouched without --rsids", 'w:rsidR="00A1B2C3"' in doc)
check("custom.xml kept without --metadata", "docProps/custom.xml" in zipfile.ZipFile(cleaned).namelist())
check("[Content_Types].xml survives first", zipfile.ZipFile(cleaned).namelist()[0] == "[Content_Types].xml")

# in place + metadata + rsids + confusables
rc, out, err = run("-i", "--metadata", "--rsids", "--confusables", "-c", files=[docx])
doc = read_zip(docx, "word/document.xml")
core = read_zip(docx, "docProps/core.xml")
app = read_zip(docx, "docProps/app.xml")
settings = read_zip(docx, "word/settings.xml")
check("-i rewrote in place, rc 0", rc == 0, (rc, err))
check("XML valid after metadata/rsids strip", xml_ok(doc) and xml_ok(core) and xml_ok(app) and xml_ok(settings))
check("rsid attributes removed from document", "w:rsid" not in doc, doc[:300])
check("<w:rsids> block removed from settings", "<w:rsids" not in settings and "<w:zoom" in settings, settings)
check("creator blanked", "<dc:creator></dc:creator>" in core and "Jane Doe" not in core, core)
check("dates blanked, title kept", "2026-08-17" not in core and "My Essay" in core, core)
check("Application/Company/TotalTime blanked, Pages kept",
      "Microsoft Office Word" not in app and "ACME" not in app and "<TotalTime></TotalTime>" in app and "<Pages>1</Pages>" in app, app)
check("custom.xml dropped", "docProps/custom.xml" not in zipfile.ZipFile(docx).namelist())
check("--confusables mapped Cyrillic а", "apple" in doc and CYR_A not in doc, doc)
rc, out, _ = run("--show", files=[docx])
check("--show after full clean: no rsids, no metadata lines", "rsid" not in out and "Jane Doe" not in out, out)

# check mode + idempotence
make_docx(os.path.join(d, "b.docx"))
rc, _, _ = run("--check", files=[os.path.join(d, "b.docx")])
check("--check exits 1 on dirty docx", rc == 1, rc)
run("-i", files=[os.path.join(d, "b.docx")])
rc, _, _ = run("--check", files=[os.path.join(d, "b.docx")])
check("--check exits 0 after cleaning (idempotent)", rc == 0, rc)

# xml:space preserve is added when cleaning yields edge whitespace
tmp = os.path.join(d, "sp.docx")
with zipfile.ZipFile(docx) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for it in zin.infolist():
        data = zin.read(it.filename)
        if it.filename == "word/document.xml":
            data = data.decode().replace("<w:t>Hello", "<w:t> Hello").encode()
        zout.writestr(it, data)
run("-i", "-s", files=[tmp])
doc = read_zip(tmp, "word/document.xml")
check("xml:space=preserve added when NBSP→space at edge", re.search(r'<w:t xml:space="preserve"> Hello', doc), doc[:400])

# bad zip
bad = os.path.join(d, "bad.docx"); open(bad, "wb").write(b"not a zip")
rc, _, err = run("-i", files=[bad])
check("corrupt docx skipped, exit 2", rc == 2 and "not a valid" in err, (rc, err))

print("\n=== ODT ===")
odt = os.path.join(d, "doc.odt")
make_odt(odt)
rc, out, _ = run("--show", files=[odt])
check("--show finds ZWSP in odt", "U+200B" in out and rc == 1, out)
check("--show reports annotations + generator + user-defined", "annotations" in out and "LibreOffice" in out and "user-defined" in out, out)
run("-i", "--metadata", files=[odt])
with zipfile.ZipFile(odt) as z:
    names = z.namelist()
    content = z.read("content.xml").decode()
    meta = z.read("meta.xml").decode()
    mimetype_info = z.getinfo("mimetype")
check("mimetype first and STORED", names[0] == "mimetype" and mimetype_info.compress_type == zipfile.ZIP_STORED)
check("content.xml valid", xml_ok(content))
check("ZWSP removed in p and nested span, and &#8203; ref", ZWSP not in content and "&#8203;" not in content and "Hello" in content and "world" in content, content)
check("family emoji intact in odt", FAMILY in content)
check("entities preserved", "&amp; &lt;x&gt;" in content, content)
check("attributes untouched", 'text:style-name="P1"' in content)
check("meta blanked, user-defined removed", "LibreOffice" not in meta and "Jane" not in meta and "user-defined" not in meta and xml_ok(meta), meta)

print("\n=== HTML ===")
htmlp = os.path.join(d, "page.html")
open(htmlp, "w", encoding="utf-8").write(
    f'<!doctype html><html><head><meta name="generator" content="Docs Exporter"><style>p{{color:red}}</style></head>'
    f'<body><!-- hidden note --><p>He{ZWSP}llo &amp; &zwj; {FAMILY} <b>bo{ZWSP}ld</b> &lt;i&gt;</p>'
    f'<span style="display:none">invisible</span><img alt="al{ZWSP}t"><script>var x="{ZWSP}"</script></body></html>')
rc, out, _ = run("--show", files=[htmlp])
check("--show html: hidden chars, comment, hidden element, generator, attr hits",
      "U+200B" in out and "1  HTML comments" in out.replace("     ", " ") and "hidden/invisible" in out
      and "Docs Exporter" in out and "alt/title" in out, out)
run("-i", files=[htmlp])
h = open(htmlp, encoding="utf-8").read()
check("html text nodes cleaned (incl. nested + &zwj; entity)", "Hello" in h and "bold" in h and "&zwj;" not in h and ZWJ + " " not in h, h)
check("html family emoji intact", FAMILY in h)
check("html tags/comment/script/style untouched", "<!-- hidden note -->" in h and f'var x="{ZWSP}"' in h and "p{color:red}" in h, h)
check("html entities re-escaped where node changed", "&amp;" in h and "&lt;i&gt;" in h, h)
check("html attribute (alt) untouched", f'alt="al{ZWSP}t"' in h)

print("\n=== MD / TXT / misc ===")
md = os.path.join(d, "n.md"); open(md, "w", encoding="utf-8").write(f"# T{ZWSP}itle\r\n")
run("-i", files=[md])
check("md cleaned, CRLF preserved", open(md, encoding="utf-8", newline="").read() == "# Title\r\n")
rc, _, err = run("-i", files=[os.path.join(d, "x.pdf")])
check("unsupported ext -> exit 2 with message", rc == 2 and "unsupported" in err, (rc, err))
o = os.path.join(d, "out.md")
run("-o", o, files=[md]); check("-o writes to given path", os.path.exists(o))
rc, _, err = run("-o", o, files=[md, htmlp]); check("-o with 2 inputs is an error", rc == 2 and "single input" in err, (rc, err))

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}"))
sys.exit(1 if fails else 0)
