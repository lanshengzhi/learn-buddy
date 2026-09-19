#!/usr/bin/env python3
"""Rebuild the tiny test epubs next to this file.

Run: python3 server/tests/fixtures/build.py
The generated .epub files are committed; the tests read them directly.
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def write_epub(name, files):
    path = os.path.join(HERE, name)
    with zipfile.ZipFile(path, "w") as archive:
        info = zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0))
        archive.writestr(info, "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for entry, text in files.items():
            archive.writestr(entry, text)
    print("wrote", path)


def nav_epub():
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:lb-nav</dc:identifier>
    <dc:title>Nav Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""
    nav = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="ch1.xhtml">Chapter One</a></li>
      <li><a href="ch2.xhtml#part2">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>
"""
    ch1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>One</title></head>
<body>
  <h1>Chapter One</h1>
  <p>Hello world. This is the first chapter.</p>
  <p>The dog<sup>1</sup> barked. <img src="dog.png" alt="A brown dog"/></p>
</body>
</html>
"""
    ch2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Two</title></head>
<body>
  <h1>Chapter Two</h1>
  <p>Prelude text before the anchor. It comes first.</p>
  <h2 id="part2">Part Two</h2>
  <p>The second part starts here. And it ends.</p>
</body>
</html>
"""
    write_epub("nav.epub", {
        "META-INF/container.xml": CONTAINER,
        "OEBPS/content.opf": opf,
        "OEBPS/nav.xhtml": nav,
        "OEBPS/ch1.xhtml": ch1,
        "OEBPS/ch2.xhtml": ch2,
    })


def ncx_epub():
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:lb-ncx</dc:identifier>
    <dc:title>羅生門</dc:title>
    <dc:creator>芥川龍之介</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""
    ncx = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:lb-ncx"/></head>
  <docTitle><text>羅生門</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一章</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>第二章</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>
"""
    ch1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body>
  <p>ある<ruby>日<rp>(</rp><rt>ひ</rt><rp>)</rp></ruby>の暮方の事である。</p>
  <p>彼は下人である。</p>
</body>
</html>
"""
    ch2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body>
  <p>雨が降っていた。</p>
</body>
</html>
"""
    write_epub("ncx.epub", {
        "META-INF/container.xml": CONTAINER,
        "OEBPS/content.opf": opf,
        "OEBPS/toc.ncx": ncx,
        "OEBPS/ch1.xhtml": ch1,
        "OEBPS/ch2.xhtml": ch2,
    })


def spine_epub():
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:lb-spine</dc:identifier>
    <dc:title>Spine Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>
"""
    c1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Alpha</title></head>
<body><p>First document text.</p></body>
</html>
"""
    c2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Beta</title></head>
<body><p>Second document text.</p></body>
</html>
"""
    write_epub("spine.epub", {
        "META-INF/container.xml": CONTAINER,
        "OEBPS/content.opf": opf,
        "OEBPS/c1.xhtml": c1,
        "OEBPS/c2.xhtml": c2,
    })


if __name__ == "__main__":
    nav_epub()
    ncx_epub()
    spine_epub()
