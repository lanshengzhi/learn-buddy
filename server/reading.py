"""Japanese reading normalization (the G2P stage) — ADR 0004.

Edge TTS cannot take furigana / SSML reading hints (no custom SSML, no
<phoneme>), so the only lever before synthesis is text rewriting: replace
kanji with their kana reading. This module produces a full-kana (katakana)
reading of a Japanese sentence using SudachiPy's morphological analysis —
lexicon lookup plus context disambiguation, which is what resolves
polyphonic kanji (銀行 ギンコウ vs 行く イク, 一人 ヒトリ vs 一人称 イチニンショウ).

A small corrections table sits on top for the analyzer's known failures:
date/number compounds Sudachi splits wrongly (一日中 → イチニチジュウ,
二十日 → ハツカ, 一昨日 → オトトイ), where the naive token readings would be
flat-out wrong.

The SudachiPy dependency is optional: without it installed the module
degrades to identity (text passes through untouched), keeping the backend's
stdlib-only test suite green and the server runnable on a box that lacks the
dependency. Normalization only fires for Japanese voices (see tts_server).
"""

import re

# Bump when the normalization output for the same input changes, so the
# server audio cache never serves stale readings after a logic change.
NORM_VERSION = 1

# Surfaces SudachiPy misreads, mapped to the correct reading. Applied
# longest-first so compound words win (一昨昨日 beats 一昨日, 一昨日 beats 一昨).
# Keys are plain kanji; values are katakana readings.
JA_READING_OVERRIDES = {
    "一昨昨日": "サキオトトイ",  # さきおととい
    "一昨日": "オトトイ",        # おととい  (analyzer: イッサクニチ)
    "一昨年": "オトトシ",        # おととし  (analyzer: イッサクネン)
    "一日中": "イチニチジュウ",  # いちにちじゅう (analyzer: イチニチチュウ)
    "一晩中": "ヒトバンジュウ",  # ひとばんじゅう (analyzer: イチバンチュウ)
    "二十日": "ハツカ",          # はつか  (analyzer: ニトウカ)
    "明後日": "アサッテ",        # あさって (analyzer: ミョウゴニチ)
}

_OVERRIDE_PATTERN = re.compile(
    "|".join(re.escape(k) for k in sorted(JA_READING_OVERRIDES, key=len, reverse=True))
)

# CJK Unified Ideographs (basic + extension A): the kanji set we replace.
_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def _has_kanji(s):
    return bool(_KANJI_RE.search(s))


def _apply_overrides(text):
    return _OVERRIDE_PATTERN.sub(lambda m: JA_READING_OVERRIDES[m.group(0)], text)


try:
    from sudachipy import Dictionary, SplitMode

    _TOKENIZER = Dictionary().create()
    SUDACHI_AVAILABLE = True
except Exception:  # pragma: no cover - environment dependent
    _TOKENIZER = None
    SUDACHI_AVAILABLE = False


def normalize_ja(text):
    """Return a kana (katakana) reading of `text` for Japanese TTS.

    Kanji tokens are replaced with SudachiPy's reading; kana tokens,
    particles, punctuation, and Latin script pass through unchanged (so
    particle は/へ keep their surface and Edge TTS reads them natively).
    Degrades to the original text when SudachiPy is unavailable or the text
    has no kanji.
    """
    if not text or not SUDACHI_AVAILABLE or not _has_kanji(text):
        return text
    text = _apply_overrides(text)
    if not _has_kanji(text):
        return text
    parts = []
    for morph in _TOKENIZER.tokenize(text, SplitMode.C):
        surface = morph.surface()
        if _has_kanji(surface):
            try:
                reading = morph.reading_form()
            except Exception:
                reading = ""
            parts.append(reading if reading else surface)
        else:
            parts.append(surface)
    return "".join(parts)
