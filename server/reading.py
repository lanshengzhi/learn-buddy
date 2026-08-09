"""Japanese reading normalization (the G2P stage) — ADR 0004.

Edge TTS cannot take furigana / SSML reading hints (no custom SSML, no
<phoneme>), so the only lever before synthesis is text rewriting: replace
kanji with their kana reading. This module produces a full-kana (hiragana)
reading of a Japanese sentence using SudachiPy's morphological analysis —
lexicon lookup plus context disambiguation, which is what resolves
polyphonic kanji (銀行 ギンコウ vs 行く イク, 一人 ヒトリ vs 一人称 イチニンショウ).

Why hiragana, not katakana: Edge's ja-JP voices pick pitch-accent strategy
from the writing form. Katakana signals a loanword and gets the head-high
(頭高) foreign accent (カブシキガイシャ sounds like カ↑ブシキ…); hiragana is
read with native Japanese word accents. The first deployed version used
katakana and listeners reported wrong pitch — verified by ear, hence the
hiragana output. Original katakana in the text (コーヒー, テレビ) stays
katakana, where its loanword accent is correct anyway.

A small corrections table sits on top for the analyzer's known failures:
date/number compounds Sudachi splits wrongly (一日中 → いちにちじゅう,
二十日 → はつか, 一昨日 → おととい), where the naive token readings would be
flat-out wrong.

The SudachiPy dependency is optional: without it installed the module
degrades to identity (text passes through untouched), keeping the backend's
stdlib-only test suite green and the server runnable on a box that lacks the
dependency. Normalization only fires for Japanese voices (see tts_server).
"""

import re

# Bump when the normalization output for the same input changes, so the
# server audio cache never serves stale readings after a logic change.
NORM_VERSION = 2

# Surfaces SudachiPy misreads, mapped to the correct reading. Applied
# longest-first so compound words win (一昨昨日 beats 一昨日, 一昨日 beats 一昨).
# Keys are plain kanji; values are hiragana readings.
JA_READING_OVERRIDES = {
    "一昨昨日": "さきおととい",  # さきおととい
    "一昨日": "おととい",        # おととい  (analyzer: イッサクニチ)
    "一昨年": "おととし",        # おととし  (analyzer: イッサクネン)
    "一日中": "いちにちじゅう",  # いちにちじゅう (analyzer: イチニチチュウ)
    "一晩中": "ひとばんじゅう",  # ひとばんじゅう (analyzer: イチバンチュウ)
    "二十日": "はつか",          # はつか  (analyzer: ニトウカ)
    "明後日": "あさって",        # あさって (analyzer: ミョウゴニチ)
}

_OVERRIDE_PATTERN = re.compile(
    "|".join(re.escape(k) for k in sorted(JA_READING_OVERRIDES, key=len, reverse=True))
)

# CJK Unified Ideographs (basic + extension A): the kanji set we replace.
_KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def _has_kanji(s):
    return bool(_KANJI_RE.search(s))


# Katakana letters (U+30A1..U+30F6) shifted down to their hiragana twins.
# The prolonged-sound mark ー (U+30FC) and the middle dot ・ (U+30FB) are
# script-neutral and must NOT shift (0x30FC - 0x60 would collide with ゜).
_KATA_TO_HIRA = {
    chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)
    if c not in (0x30FB, 0x30FC)
}
_KATA_TO_HIRA_TABLE = str.maketrans(_KATA_TO_HIRA)


def _kata_to_hira(text):
    return text.translate(_KATA_TO_HIRA_TABLE)


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
    """Return a kana (hiragana) reading of `text` for Japanese TTS.

    Kanji tokens are replaced with SudachiPy's reading converted to hiragana
    (katakana would push Edge's ja voices into loanword/head-high accent);
    kana tokens, particles, punctuation, and Latin script pass through
    unchanged (so particle は/へ keep their surface, and original katakana
    loanwords keep their correct loanword accent). Degrades to the original
    text when SudachiPy is unavailable or the text has no kanji.
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
            parts.append(_kata_to_hira(reading) if reading else surface)
        else:
            parts.append(surface)
    return "".join(parts)
