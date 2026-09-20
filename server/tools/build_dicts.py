#!/usr/bin/env python3
"""Build the lookup dictionary SQLite files (ADR 0008) into <data-dir>/dicts/.

Sources (research/lookup-data.md §2; zh sources measured in research/rare-hanzi.md):
  en.sqlite   ECDICT release csv        → https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
  ja.sqlite   JMdict_e.gz               → https://www.edrdg.org/pub/Nihongo/JMdict_e.gz   (www., not ftp.: cert CN)
  kanji.sqlite KANJIDIC2                → https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz
  zh.sqlite   CC-CEDICT daily export    → https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz (CC BY-SA 4.0)
              Unihan.zip (kMandarin, kDefinition) → https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip

Usage:  python3 server/tools/build_dicts.py [--data-dir DIR] [--only en,ja]
Files are written atomically (tmp + rename); existing files are kept unless
--force.
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
CEDICT_URL = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz"
UNIHAN_URL = "https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip"

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


# -- Chinese (CC-CEDICT + Unihan) ---------------------------------------------

# `傳統字 簡體字 [pinyin] /gloss/ /gloss/` — traditional and simplified live in
# one row, so the runtime can exact-match either tradition without conversion.
_CEDICT_LINE = re.compile(
    r"^(?P<traditional>\S+) (?P<simplified>\S+) \[(?P<pinyin>[^\]]+)\] (?P<glosses>/.*/)$"
)


def build_zh(connection, sources):
    cedict, unihan = sources
    connection.execute(
        "CREATE TABLE cedict (traditional TEXT, simplified TEXT, pinyin TEXT, glosses TEXT)"
    )
    connection.execute("CREATE INDEX cedict_simplified ON cedict(simplified)")
    connection.execute("CREATE INDEX cedict_traditional ON cedict(traditional)")
    rows = []
    for line in cedict.decode("utf-8", "replace").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        match = _CEDICT_LINE.match(line)
        if match is None:
            continue
        rows.append(
            (
                match["traditional"],
                match["simplified"],
                match["pinyin"].strip(),
                match["glosses"],
            )
        )
    connection.executemany("INSERT INTO cedict VALUES (?, ?, ?, ?)", rows)
    connection.execute(
        "CREATE TABLE hanzi (hanzi TEXT PRIMARY KEY, pinyin TEXT, definition TEXT)"
    )
    connection.executemany(
        "INSERT OR REPLACE INTO hanzi VALUES (?, ?, ?)",
        [
            (char, entry.get("pinyin", ""), entry.get("definition", ""))
            for char, entry in sorted(unihan.items())
        ],
    )


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


def _decode_unihan(data):
    """Unihan.zip → {char: {"pinyin", "definition"}} from Unihan_Readings.txt:
    kMandarin (the first value is the default reading of a 多音字) and
    kDefinition (English gloss; recent UCD versions carry it in the same
    file)."""
    import zipfile

    entries = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for line in archive.read("Unihan_Readings.txt").decode("utf-8").splitlines():
            parts = line.split("\t")
            if line.startswith("#") or len(parts) < 3 or parts[1] not in ("kMandarin", "kDefinition"):
                continue
            value = parts[2].strip()
            if not value:
                continue
            entry = entries.setdefault(chr(int(parts[0][2:], 16)), {})
            if parts[1] == "kMandarin":
                entry.setdefault("pinyin", value.split(" ")[0])
            else:
                entry["definition"] = value
    return entries


BUILDERS = {
    "en": ("en.sqlite", (ECDICT_URL,), ("utf-8",), build_en),
    "ja": ("ja.sqlite", (JMDICT_URL,), ("gzip",), build_ja),
    "kanji": ("kanji.sqlite", (KANJIDIC_URL,), ("gzip",), build_kanji),
    "zh": ("zh.sqlite", (CEDICT_URL, UNIHAN_URL), ("gzip", "unihan"), build_zh),
}


_DECODERS = {
    "utf-8": lambda data: data,
    "gzip": gzip.decompress,
    "unihan": _decode_unihan,
}


def build(langs, data_dir, force=False, downloader=_download):
    for lang in langs:
        filename, urls, encodings, builder = BUILDERS[lang]
        path = os.path.join(data_dir, "dicts", filename)
        if os.path.isfile(path) and not force:
            print(f"[skip] {lang}: {path} exists (use --force to rebuild)")
            continue
        print(f"[build] {lang}: downloading {' and '.join(urls)}")
        sources = [_DECODERS[encoding](downloader(url)) for url, encoding in zip(urls, encodings)]
        print(f"[build] {lang}: building {path}")
        _atomic_write(path, lambda connection: builder(connection, sources))
        print(f"[done] {lang}: {os.path.getsize(path) / 1e6:.1f} MB")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    parser.add_argument("--only", default="en,ja,kanji,zh", help="comma list: en, ja, kanji, zh")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    langs = [lang.strip() for lang in args.only.split(",") if lang.strip()]
    unknown = [lang for lang in langs if lang not in BUILDERS]
    if unknown:
        sys.exit(f"unknown language(s): {', '.join(unknown)} (known: {', '.join(BUILDERS)})")
    build(langs, args.data_dir, force=args.force)


if __name__ == "__main__":
    main()
