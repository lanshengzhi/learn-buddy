#!/usr/bin/env python3
"""Build the lookup dictionary SQLite files (ADR 0008) into <data-dir>/dicts/.

Sources (research/lookup-data.md §2):
  en.sqlite   ECDICT release csv        → https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
  ja.sqlite   JMdict_e.gz               → https://www.edrdg.org/pub/Nihongo/JMdict_e.gz   (www., not ftp.: cert CN)
  kanji.sqlite KANJIDIC2                → https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz

Usage:  python3 server/tools/build_dicts.py [--data-dir DIR] [--only en,ja]
Files are written atomically (tmp + rename); existing files are kept unless
--force. zh.sqlite is deliberately out of MVP (Chinese effort is a separate map).
"""

import argparse
import csv
import gzip
import io
import os
import re
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_DATA_DIR = os.path.join(REPO_ROOT, "server", "data")

ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
JMDICT_URL = "https://www.edrdg.org/pub/Nihongo/JMdict_e.gz"
KANJIDIC_URL = "https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz"

USER_AGENT = "learnbuddy-dict-builder/1.0"


def _download(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def _atomic_write(path, builder):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    handle, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", dir=directory)
    os.close(handle)
    try:
        connection = sqlite3_connect(tmp)
        with connection:
            builder(connection)
        connection.close()
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sqlite3_connect(path):
    import sqlite3

    return sqlite3.connect(path)


# -- English (ECDICT) --------------------------------------------------------


def build_en(connection, source):
    connection.execute("CREATE TABLE ecdict (word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT, definition TEXT)")
    reader = csv.DictReader(io.StringIO(source.decode("utf-8", "replace")))
    rows = []
    for record in reader:
        rows.append((
            (record.get("word") or "").strip(),
            (record.get("phonetic") or "").strip(),
            (record.get("translation") or "").strip(),
            (record.get("definition") or "").strip(),
        ))
    connection.executemany("INSERT OR REPLACE INTO ecdict VALUES (?, ?, ?, ?)", rows)


# -- EDRG XML (JMdict / KANJIDIC2): entities live in an inline DTD that
# stdlib ElementTree does not read, so the declarations are parsed out of the
# prolog and entity references are substituted by hand before parsing. -------

DOCTYPE_ENTITY = re.compile(r'<!ENTITY\s+([\w.-]+)\s+"([^"]*)"\s*>')


def _load_edrg_xml(source):
    text = source.decode("utf-8")
    entities = dict(DOCTYPE_ENTITY.findall(text))
    doctype_end = text.find("]>")
    if doctype_end >= 0:
        text = text[doctype_end + 2:]
    if entities:
        pattern = re.compile(r"&(" + "|".join(map(re.escape, entities)) + ");")
        text = pattern.sub(lambda match: entities[match.group(1)], text)
    return ET.fromstring(text)


def build_ja(connection, source):
    root = _load_edrg_xml(source)
    connection.execute("CREATE TABLE forms (text TEXT NOT NULL, entry INTEGER NOT NULL)")
    connection.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, reading TEXT)")
    connection.execute("CREATE TABLE senses (entry INTEGER NOT NULL, ord INTEGER NOT NULL, pos TEXT, gloss TEXT)")
    connection.execute("CREATE INDEX forms_text ON forms(text)")

    for element in root.findall("entry"):
        entry_id = int(element.findtext("ent_seq", "0"))
        reb_values = [r.findtext("reb", "") for r in element.findall("r_ele")]
        keb_values = [k.findtext("keb", "") for k in element.findall("k_ele")]
        reading = reb_values[0] if reb_values else ""
        connection.execute("INSERT INTO entries VALUES (?, ?)", (entry_id, reading))
        for form in dict.fromkeys(keb_values + reb_values):
            if form:
                connection.execute("INSERT INTO forms VALUES (?, ?)", (form, entry_id))
        for order, sense in enumerate(element.findall("sense")):
            pos = ";".join(dict.fromkeys(p.text or "" for p in sense.findall("pos")))
            for gloss in sense.findall("gloss"):
                if gloss.text and gloss.text.strip():
                    connection.execute(
                        "INSERT INTO senses VALUES (?, ?, ?, ?)",
                        (entry_id, order, pos, gloss.text.strip()),
                    )


def build_kanji(connection, source):
    root = _load_edrg_xml(source)
    connection.execute("CREATE TABLE kanji (kanji TEXT PRIMARY KEY, onyomi TEXT, kunyomi TEXT, meanings TEXT)")
    for character in root.findall("character"):
        literal = character.findtext("literal")
        if not literal:
            continue
        readings = character.findall(".//reading")
        onyomi = " ".join((r.text or "").strip() for r in readings if r.get("r_type") == "ja_on" and r.text)
        kunyomi = " ".join((r.text or "").strip() for r in readings if r.get("r_type") == "kun")
        meanings = "|".join(
            (m.text or "").strip() for m in character.findall(".//meaning") if not m.get("m_lang")
        )
        connection.execute(
            "INSERT OR REPLACE INTO kanji VALUES (?, ?, ?, ?)", (literal, onyomi, kunyomi, meanings)
        )


BUILDERS = {
    "en": ("en.sqlite", ECDICT_URL, "utf-8", build_en),
    "ja": ("ja.sqlite", JMDICT_URL, "gzip", build_ja),
    "kanji": ("kanji.sqlite", KANJIDIC_URL, "gzip", build_kanji),
}


def build(langs, data_dir, force=False, downloader=_download):
    for lang in langs:
        filename, url, encoding, builder = BUILDERS[lang]
        path = os.path.join(data_dir, "dicts", filename)
        if os.path.isfile(path) and not force:
            print(f"[skip] {lang}: {path} exists (use --force to rebuild)")
            continue
        print(f"[build] {lang}: downloading {url}")
        source = downloader(url)
        if encoding == "gzip":
            source = gzip.decompress(source)
        print(f"[build] {lang}: building {path} from {len(source) / 1e6:.1f} MB of source data")
        _atomic_write(path, lambda connection: builder(connection, source))
        print(f"[done] {lang}: {os.path.getsize(path) / 1e6:.1f} MB")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--only", default="en,ja,kanji", help="comma list: en, ja, kanji")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    langs = [lang.strip() for lang in args.only.split(",") if lang.strip()]
    unknown = [lang for lang in langs if lang not in BUILDERS]
    if unknown:
        sys.exit(f"unknown language(s): {', '.join(unknown)} (known: {', '.join(BUILDERS)})")
    build(langs, args.data_dir, force=args.force)


if __name__ == "__main__":
    main()
