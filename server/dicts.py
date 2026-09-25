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
- Chinese: exact match on the surface form — CC-CEDICT stores the traditional
  and the simplified form of every entry in one row, so mixed-tradition text
  hits without conversion; the Word key is the simplified form so both
  traditions share 我认识 state. A single-Han-character miss falls back to a
  Unihan table (kMandarin + kDefinition; #10 measured 100% kMandarin coverage
  over 红楼梦 where CC-CEDICT misses 9 chars + 5 non-BMP chars) — the zh
  counterpart of the ja KANJIDIC2 fallback. jieba is simplified-oriented, so
  traditional books tokenize per character; the dictionary still resolves
  them. No inflection, no lemma chain.

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
MAX_ALTERNATE_READINGS = 8


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
        if not _EN_PHRASE_RE.fullmatch(word):
            return None
        db = self._db("en.sqlite")
        if db is None:
            raise LookupUnavailable("en dictionary is not built")
        # A phrase must match its own dictionary entry. Mechanical lemma
        # stripping is only a fallback for a single inflected word.
        candidates = [word] if " " in word else [word] + _en_lemma_candidates(word)
        for candidate in candidates:
            with _QUERY_LOCK:
                row = db.execute(
                    "SELECT word, phonetic, translation, definition FROM ecdict WHERE word = ?",
                    (candidate,),
                ).fetchone()
            if row is not None:
                translation = row[2] or ""
                gloss = translation or row[3] or ""
                return {
                    "key": f"en:{row[0]}",
                    "matched": row[0],
                    "reading": row[1] or "",
                    "senses": _gloss_senses(gloss),
                    # ECDICT's Chinese translation is preferred when present;
                    # its English definition is an explicit fallback.
                    "glossLanguage": "zh" if translation else "en",
                    "glossSource": "ECDICT translation" if translation else "ECDICT definition",
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
            "glossLanguage": "en",
            "glossSource": "KANJIDIC2",
        }

    # -- Chinese ------------------------------------------------------------

    def lookup_zh(self, surface):
        word = surface.strip()
        if not word:
            return None
        db = self._db("zh.sqlite")
        if db is None:
            raise LookupUnavailable("zh dictionary is not built")
        with _QUERY_LOCK:
            rows = db.execute(
                "SELECT simplified, pinyin, glosses FROM cedict WHERE simplified = ? OR traditional = ?",
                (word, word),
            ).fetchall()
        if rows:
            reading = next((pinyin for _, pinyin, _ in rows if pinyin), "")
            senses = []
            for _, _, glosses in rows:
                senses.extend(_gloss_senses((glosses or "").replace("/", "\n")))
                if len(senses) >= MAX_SENSES:
                    break
            simplified = rows[0][0]
            return {
                "key": f"zh:{simplified}",
                "matched": simplified,
                "reading": _pinyin_tone_marks(reading),
                "senses": senses[:MAX_SENSES],
                # CC-CEDICT glosses are English; do not present them as
                # Chinese-native explanations.
                "glossLanguage": "en",
                "glossSource": "CC-CEDICT",
            }
        return self._hanzi_fallback(word)

    def _hanzi_fallback(self, text):
        """A single rare character outside CC-CEDICT falls back to Unihan —
        the zh counterpart of the ja KANJIDIC2 fallback (生僻字 quality bar:
        the character must be lookable-up, not just displayed)."""
        if len(text) != 1 or not _HAN_RE.search(text):
            return None
        db = self._db("zh.sqlite")
        if db is None:
            return None
        with _QUERY_LOCK:
            row = db.execute(
                "SELECT pinyin, definition FROM hanzi WHERE hanzi = ?", (text,)
            ).fetchone()
        if row is None:
            return None
        pinyin, definition = row
        return {
            "key": f"zh:{text}",
            "matched": text,
            "reading": _pinyin_tone_marks(pinyin or ""),
            "senses": _gloss_senses((definition or "").replace("|", "\n")),
            "glossLanguage": "en",
            "glossSource": "Unihan",
        }

    # -- presence check (标生词 underline) -----------------------------------

    def check(self, lang, words):
        """Presence map for a batch of words: {word: resolved key or None}."""
        resolver = {
            "en": self.lookup_en,
            "ja": self.lookup_ja,
            "zh": self.lookup_zh,
        }.get(lang)
        if resolver is None:
            return {word: None for word in words}
        result = {}
        for word in words:
            try:
                entry = resolver(word)
            except LookupUnavailable:
                return {word: None for word in words}
            result[word] = entry["key"] if entry else None
        return result


_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
# Han characters for zh lookups, extended planes included (𣬶 U+23236 etc.:
# #10 measured 5 non-BMP characters in the 红楼梦 化校本 that CC-CEDICT misses).
_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\U00020000-\U0002ffff]")
_EN_PHRASE_RE = re.compile(
    r"[a-z]+(?:[a-z'’\-]*[a-z]+)*(?:[ \t]+[a-z]+(?:[a-z'’\-]*[a-z]+)*)*"
)
# Module-level query lock: _ja_entry is a free function (no Dicts self).
_QUERY_LOCK = threading.Lock()


def _gloss_senses(block):
    senses = [{"pos": "", "gloss": gloss.strip()} for gloss in block.split("\n") if gloss.strip()]
    return senses[:MAX_SENSES]


# CC-CEDICT stores numbered pinyin ("Bao3 yu4"); the card shows tone marks.
# Diacritics per vowel, tone 1–4; tone 5 (neutral) stays unmarked.
_TONE_VOWELS = {
    "a": "āáǎà", "e": "ēéěè", "i": "īíǐì",
    "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ",
}
_PINYIN_SYLLABLE = re.compile(r"([a-zA-ZüÜ]+)([1-5])")


def _pinyin_tone_marks(numbered):
    """"Bao3 yu4" → "Bǎo yù". Placement rule: first a/o/e, else the last
    vowel (iu → iū); CC-CEDICT's "u:" notation is ü. Unknown shapes pass
    through untouched."""
    marked = []
    for syllable in numbered.split(" "):
        letters = syllable.replace("u:", "ü").replace("U:", "Ü")
        match = _PINYIN_SYLLABLE.fullmatch(letters)
        if match is None:
            marked.append(syllable)
            continue
        letters, tone = match.group(1), int(match.group(2))
        if tone < 5:
            lower = letters.lower()
            index = -1
            for vowel in "aoe":
                position = lower.find(vowel)
                if position >= 0:
                    index = position
                    break
            if index < 0:
                for position, char in enumerate(lower):
                    if char in "iüu":
                        index = position
            if 0 <= index < len(letters) and lower[index] in _TONE_VOWELS:
                accented = _TONE_VOWELS[lower[index]][tone - 1]
                if letters[index].isupper():
                    accented = accented.upper()
                letters = letters[:index] + accented + letters[index + 1:]
        marked.append(letters)
    return " ".join(marked)


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
        alternate_rows = db.execute(
            "SELECT DISTINCT entries.reading "
            "FROM forms AS candidate "
            "JOIN entries ON entries.id = candidate.entry "
            "WHERE candidate.text IN (SELECT text FROM forms WHERE entry = ?) "
            "AND entries.reading != '' "
            "ORDER BY entries.reading",
            (entry_id,),
        ).fetchall()
    if not rows:
        return None
    primary = (reading[0] if reading else "") or ""
    alternate_readings = [
        value for (value,) in alternate_rows if value and value != primary
    ]
    return {
        "key": None,  # filled by the caller: the matched chain key
        "matched": None,
        "reading": primary,
        "alternateReadings": alternate_readings[:MAX_ALTERNATE_READINGS],
        "senses": [
            {"pos": pos or "", "gloss": gloss}
            for pos, gloss in rows[:MAX_SENSES]
        ],
        "glossLanguage": "en",
        "glossSource": "JMdict_e",
    }
