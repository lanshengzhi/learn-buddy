"""Lookup dictionaries — the local-dictionary half of 查义 (ADR 0008).

Dictionary data lives as build-time SQLite files under <data-dir>/dicts/
(en.sqlite from ECDICT, ja.sqlite from JMdict, kanji.sqlite from KANJIDIC2);
the build script is server/tools/build_dicts.py. At runtime this module only
reads them with stdlib sqlite3 and resolves a clicked word to its entry:

- English: lowercase exact match, then mechanical lemma fallbacks (plural /
  verb endings) for inflected forms; ECDICT's own lemma pointers cannot be
  walked backwards, so the fallback is the suffix strip.
- Japanese: the researched fallback chain surface → normalized_form →
  dictionary_form → reading_form (Sudachi SplitMode C; research/lookup-data.md
  §3.4 measured 93.4% end-to-end vs 83.7% surface-only), then a single-kanji
  KANJIDIC2 fallback for kana-less misses.
- Other languages (zh reserved for a future effort): no dictionary file,
  lookups miss.

Words marked 我认识 are keyed by the resolved key ("ja:食べる", "en:run") so
inflected forms share one state; the key is what /words stores and what the
per-sentence presence check (/lookup/check) reports back.
"""

import os
import re
import sqlite3
import threading

# /lookup/check is a visible-screen batch; bigger batches are rejected.
MAX_CHECK_WORDS = 200

# Lookup response caps — a card shows the first few senses.
MAX_SENSES = 8


class LookupUnavailable(RuntimeError):
    """Raised when no dictionary file for the requested language exists
    (dicts not built / not deployed yet)."""


class Dicts:
    """The per-language SQLite files, opened read-only on first use. Read-only
    because the files are build artifacts; concurrent reads share connections."""

    def __init__(self, dicts_dir):
        self.dicts_dir = dicts_dir
        self._lock = threading.Lock()
        self._connections = {}

    # -- connections --------------------------------------------------------

    def _db(self, filename):
        with self._lock:
            if filename not in self._connections:
                path = os.path.join(self.dicts_dir, filename)
                connection = None
                if os.path.isfile(path):
                    # check_same_thread=False: the HTTP server serves requests
                    # on rotating threads; queries are serialized by self._lock.
                    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
                    connection.execute("PRAGMA mmap_size=134217728")
                self._connections[filename] = connection
            return self._connections[filename]

    def close(self):
        with self._lock:
            for connection in self._connections.values():
                if connection is not None:
                    connection.close()
            self._connections.clear()

    # -- English ------------------------------------------------------------

    def lookup_en(self, surface):
        word = surface.strip().lower()
        if not _EN_WORD_RE.fullmatch(word):
            return None
        db = self._db("en.sqlite")
        if db is None:
            raise LookupUnavailable("en dictionary is not built")
        for candidate in [word] + _en_lemma_candidates(word):
            with _QUERY_LOCK:
                row = db.execute(
                    "SELECT word, phonetic, translation, definition FROM ecdict WHERE word = ?",
                    (candidate,),
                ).fetchone()
            if row is not None:
                return {
                    "key": f"en:{row[0]}",
                    "matched": row[0],
                    "reading": row[1] or "",
                    "senses": _gloss_senses(row[2] or row[3] or ""),
                }
        return None

    # -- Japanese -----------------------------------------------------------

    def lookup_ja(self, surface):
        text = surface.strip()
        if not text:
            return None
        db = self._db("ja.sqlite")
        if db is None:
            raise LookupUnavailable("ja dictionary is not built")
        for key in _ja_keys(text):
            with _QUERY_LOCK:
                hit = db.execute(
                    "SELECT entry FROM forms WHERE text = ? LIMIT 1", (key,)
                ).fetchone()
            if hit is None:
                continue
            entry = _ja_entry(db, hit[0])
            if entry is not None:
                entry["key"] = f"ja:{key}"
                entry["matched"] = key
                return entry
        return self._kanji_fallback(text)

    def _kanji_fallback(self, text):
        """A kana-less miss on a single kanji falls back to KANJIDIC2."""
        if len(text) != 1 or not _KANJI_RE.search(text):
            return None
        db = self._db("kanji.sqlite")
        if db is None:
            return None
        with _QUERY_LOCK:
            row = db.execute(
                "SELECT onyomi, kunyomi, meanings FROM kanji WHERE kanji = ?", (text,)
            ).fetchone()
        if row is None:
            return None
        onyomi, kunyomi, meanings = row
        readings = [r for r in (onyomi or "").split(" ") if r]
        readings += [r for r in (kunyomi or "").split(" ") if r]
        return {
            "key": f"ja:{text}",
            "matched": text,
            "reading": "・".join(dict.fromkeys(readings)),
            "senses": _gloss_senses((meanings or "").replace("|", "\n")),
        }

    # -- presence check (标生词 underline) -----------------------------------

    def check(self, lang, words):
        """Presence map for a batch of words: {word: resolved key or None}."""
        result = {}
        if lang == "en":
            for word in words:
                try:
                    entry = self.lookup_en(word)
                except LookupUnavailable:
                    return {word: None for word in words}
                result[word] = entry["key"] if entry else None
            return result
        if lang == "ja":
            for word in words:
                try:
                    entry = self.lookup_ja(word)
                except LookupUnavailable:
                    return {word: None for word in words}
                result[word] = entry["key"] if entry else None
            return result
        return {word: None for word in words}


_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_EN_WORD_RE = re.compile(r"[a-z][a-z'’\-]*")
# Module-level query lock: _ja_entry is a free function (no Dicts self).
_QUERY_LOCK = threading.Lock()


def _gloss_senses(block):
    senses = [{"pos": "", "gloss": gloss.strip()} for gloss in block.split("\n") if gloss.strip()]
    return senses[:MAX_SENSES]


def _en_lemma_candidates(word):
    """Inflected English forms resolve via mechanical suffix strips: ECDICT's
    exchange field stores lemma pointers on the base form ("0:past" etc.) and
    cannot be walked backwards. Covers plurals and common verb forms."""
    candidates = []

    def push(stem):
        if stem and stem not in candidates:
            candidates.append(stem)

    for suffix, replacement in (("ies", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e")):
        if word.endswith(suffix) and len(word) > len(suffix) + 1:
            push(word[: -len(suffix)] + replacement)
            push(_undouble(word[: -len(suffix)]))
    return candidates


def _undouble(stem):
    """stopping → stopp → stop; stopped → stopp → stop (consonant doubling)."""
    if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in "aeiouwxy":
        return stem[:-1]
    return stem


def _ja_keys(surface):
    """The ja fallback chain keys for one surface form: Sudachi on the
    isolated surface yields normalized / dictionary / reading in one call."""
    keys = []
    seen = set()

    def push(value):
        value = (value or "").strip()
        if value and value not in seen:
            seen.add(value)
            keys.append(value)

    push(surface)
    try:
        from sudachipy import Dictionary, SplitMode
    except ImportError:  # exact-surface hits still work without the tokenizer
        return keys
    tokenizer = Dictionary().create()
    for token in tokenizer.tokenize(surface, SplitMode.C):
        push(token.normalized_form())
        push(token.dictionary_form())
        push(token.reading_form())
    return keys


def _ja_entry(db, entry_id):
    with _QUERY_LOCK:
        rows = db.execute(
            "SELECT pos, gloss FROM senses WHERE entry = ? ORDER BY ord", (entry_id,)
        ).fetchall()
        reading = db.execute("SELECT reading FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not rows:
        return None
    return {
        "key": None,  # filled by the caller: the matched chain key
        "matched": None,
        "reading": (reading[0] if reading else "") or "",
        "senses": [
            {"pos": pos or "", "gloss": gloss}
            for pos, gloss in rows[:MAX_SENSES]
        ],
    }
